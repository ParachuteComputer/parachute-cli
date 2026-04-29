import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthDeps, type Runner, auth, authHelp } from "../commands/auth.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import {
  OPERATOR_TOKEN_AUDIENCE,
  OPERATOR_TOKEN_SCOPES,
  readOperatorTokenFile,
} from "../operator-token.ts";
import { listUsers, verifyPassword } from "../users.ts";

function makeRunner(result: number | (() => Promise<number>) = 0): {
  runner: Runner;
  calls: Array<readonly string[]>;
} {
  const calls: Array<readonly string[]> = [];
  const runner: Runner = {
    async run(cmd) {
      calls.push(cmd);
      return typeof result === "function" ? await result() : result;
    },
  };
  return { runner, calls };
}

function makeTmp(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "phub-auth-"));
  return {
    dir,
    dbPath: hubDbPath(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Capture console.log + console.error output for the duration of `fn`. */
async function captureOutput(fn: () => Promise<number> | number): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const origLog = console.log;
  const origErr = console.error;
  let stdout = "";
  let stderr = "";
  console.log = (...a: unknown[]) => {
    stdout += `${a.map(String).join(" ")}\n`;
  };
  console.error = (...a: unknown[]) => {
    stderr += `${a.map(String).join(" ")}\n`;
  };
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("parachute auth", () => {
  test("2fa enroll forwards to parachute-vault 2fa enroll", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth(["2fa", "enroll"], runner);
    expect(code).toBe(0);
    expect(calls).toEqual([["parachute-vault", "2fa", "enroll"]]);
  });

  test("2fa enroll --some-flag forwards every arg after the subcommand", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth(["2fa", "enroll", "--some-flag", "value"], runner);
    expect(code).toBe(0);
    expect(calls).toEqual([["parachute-vault", "2fa", "enroll", "--some-flag", "value"]]);
  });

  test("exit code from parachute-vault is propagated", async () => {
    const { runner } = makeRunner(3);
    const code = await auth(["2fa", "status"], runner);
    expect(code).toBe(3);
  });

  test("ENOENT on a vault-forwarded subcommand surfaces install hint and exit 127", async () => {
    const runner: Runner = {
      async run() {
        throw new Error("ENOENT: spawn parachute-vault");
      },
    };
    const code = await auth(["2fa", "status"], runner);
    expect(code).toBe(127);
  });

  test("set-password no longer forwards to vault", async () => {
    const tmp = makeTmp();
    try {
      const { runner, calls } = makeRunner(0);
      const code = await auth(["set-password", "--password", "pw"], {
        runner,
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      });
      expect(code).toBe(0);
      // Did NOT spawn parachute-vault.
      expect(calls).toEqual([]);
    } finally {
      tmp.cleanup();
    }
  });

  test("bogus subcommand exits 1 without spawning vault", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth(["whoami"], runner);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  test("no args prints help and exits 0 without spawning vault", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth([], runner);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  test("--help and help both route to the same help surface", async () => {
    const { runner, calls } = makeRunner(0);
    expect(await auth(["--help"], runner)).toBe(0);
    expect(await auth(["-h"], runner)).toBe(0);
    expect(await auth(["help"], runner)).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("authHelp", () => {
  const h = authHelp();

  test("lists every blessed subcommand", () => {
    expect(h).toContain("parachute auth set-password");
    expect(h).toContain("parachute auth list-users");
    expect(h).toContain("parachute auth 2fa status");
    expect(h).toContain("parachute auth 2fa enroll");
    expect(h).toContain("parachute auth 2fa disable");
    expect(h).toContain("parachute auth 2fa backup-codes");
    expect(h).toContain("parachute auth rotate-key");
  });

  test("set-password help mentions the new flags + hub-local home", () => {
    expect(h).toContain("--username");
    expect(h).toContain("--allow-multi");
    expect(h).toContain("hub.db");
  });

  test("mentions the vault-install hint", () => {
    expect(h).toContain("parachute install vault");
  });

  test("rotate-key explains the 24h JWKS retention", () => {
    expect(h).toContain("jwks.json");
    // "24" + "hours" may be split by line wrap; check both pieces.
    expect(h).toContain("24");
    expect(h).toContain("hours");
  });
});

describe("parachute auth rotate-key", () => {
  test("invokes the rotate hook and exits 0; does not spawn vault", async () => {
    const { runner, calls } = makeRunner(0);
    let hookCalls = 0;
    const code = await auth(["rotate-key"], {
      runner,
      rotateKey: () => {
        hookCalls++;
        return { kid: "test-kid-abc", createdAt: "2026-04-26T00:00:00.000Z" };
      },
    });
    expect(code).toBe(0);
    expect(hookCalls).toBe(1);
    expect(calls).toEqual([]);
  });

  test("propagates rotate errors as exit 1", async () => {
    const code = await auth(["rotate-key"], {
      rotateKey: () => {
        throw new Error("disk full");
      },
    });
    expect(code).toBe(1);
  });
});

describe("parachute auth set-password", () => {
  test("creates the first user with --password (non-interactive)", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      const { code, stdout } = await captureOutput(() =>
        auth(["set-password", "--password", "hunter2"], deps),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("Created hub user");
      expect(stdout).toContain("owner");
      const db = openHubDb(tmp.dbPath);
      try {
        const users = listUsers(db);
        expect(users).toHaveLength(1);
        expect(users[0]?.username).toBe("owner");
        expect(await verifyPassword(users[0]!, "hunter2")).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("creates with a custom --username", async () => {
    const tmp = makeTmp();
    try {
      const { code } = await captureOutput(() =>
        auth(["set-password", "--username", "aaron", "--password", "pw"], {
          dbPath: tmp.dbPath,
          configDir: tmp.dir,
          isInteractive: () => false,
        }),
      );
      expect(code).toBe(0);
      const db = openHubDb(tmp.dbPath);
      try {
        expect(listUsers(db).map((u) => u.username)).toEqual(["aaron"]);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("updates the existing user's password (single-user mode)", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath, configDir: tmp.dir, isInteractive: () => false };
      // First-run create.
      await captureOutput(() => auth(["set-password", "--password", "old"], deps));
      // Update.
      const { code, stdout } = await captureOutput(() =>
        auth(["set-password", "--password", "new"], deps),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("Updated password");
      const db = openHubDb(tmp.dbPath);
      try {
        const u = listUsers(db)[0]!;
        expect(await verifyPassword(u, "new")).toBe(true);
        expect(await verifyPassword(u, "old")).toBe(false);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("rejects --username mismatch without --allow-multi", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath, configDir: tmp.dir, isInteractive: () => false };
      await captureOutput(() => auth(["set-password", "--password", "p"], deps));
      const { code, stderr } = await captureOutput(() =>
        auth(["set-password", "--username", "second", "--password", "p"], deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("already exists");
    } finally {
      tmp.cleanup();
    }
  });

  test("creates a second user with --allow-multi", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath, configDir: tmp.dir, isInteractive: () => false };
      await captureOutput(() => auth(["set-password", "--password", "p"], deps));
      const { code } = await captureOutput(() =>
        auth(["set-password", "--username", "second", "--password", "p", "--allow-multi"], deps),
      );
      expect(code).toBe(0);
      const db = openHubDb(tmp.dbPath);
      try {
        expect(
          listUsers(db)
            .map((u) => u.username)
            .sort(),
        ).toEqual(["owner", "second"]);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("non-interactive without --password is an error", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["set-password"], {
          dbPath: tmp.dbPath,
          configDir: tmp.dir,
          isInteractive: () => false,
        }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--password is required");
    } finally {
      tmp.cleanup();
    }
  });

  test("interactive: prompts twice and creates the user when they match", async () => {
    const tmp = makeTmp();
    try {
      const prompts: string[] = [];
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => true,
        readPassword: async (p) => {
          prompts.push(p);
          return "matched";
        },
        readLine: async () => "y",
      };
      const { code } = await captureOutput(() => auth(["set-password"], deps));
      expect(code).toBe(0);
      expect(prompts.length).toBe(2);
      const db = openHubDb(tmp.dbPath);
      try {
        const u = listUsers(db)[0]!;
        expect(await verifyPassword(u, "matched")).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  test("interactive: mismatched confirmation aborts with exit 1", async () => {
    const tmp = makeTmp();
    try {
      const answers = ["one", "two"];
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => true,
        readPassword: async () => answers.shift() ?? "",
        readLine: async () => "y",
      };
      const { code, stderr } = await captureOutput(() => auth(["set-password"], deps));
      expect(code).toBe(1);
      expect(stderr).toContain("did not match");
    } finally {
      tmp.cleanup();
    }
  });

  test("interactive: empty password aborts with exit 1", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => true,
        readPassword: async () => "",
        readLine: async () => "y",
      };
      const { code, stderr } = await captureOutput(() => auth(["set-password"], deps));
      expect(code).toBe(1);
      expect(stderr).toContain("empty");
    } finally {
      tmp.cleanup();
    }
  });

  test("first-run interactive: declining the default-username confirmation aborts", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => true,
        readPassword: async () => "pw",
        readLine: async () => "n",
      };
      const { code, stderr } = await captureOutput(() => auth(["set-password"], deps));
      expect(code).toBe(1);
      expect(stderr).toContain("aborted");
    } finally {
      tmp.cleanup();
    }
  });

  test("unknown flag exits 1", async () => {
    const tmp = makeTmp();
    try {
      const { code, stderr } = await captureOutput(() =>
        auth(["set-password", "--lol"], {
          dbPath: tmp.dbPath,
          configDir: tmp.dir,
          isInteractive: () => false,
        }),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("unknown flag");
    } finally {
      tmp.cleanup();
    }
  });
});

describe("parachute auth list-users", () => {
  test("empty state prints the seeding hint", async () => {
    const tmp = makeTmp();
    try {
      const { code, stdout } = await captureOutput(() =>
        auth(["list-users"], { dbPath: tmp.dbPath }),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("no hub users yet");
    } finally {
      tmp.cleanup();
    }
  });

  test("lists usernames after a set-password", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath, configDir: tmp.dir, isInteractive: () => false };
      await captureOutput(() =>
        auth(["set-password", "--username", "alice", "--password", "p"], deps),
      );
      const { code, stdout } = await captureOutput(() => auth(["list-users"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("USERNAME");
      expect(stdout).toContain("alice");
    } finally {
      tmp.cleanup();
    }
  });
});

describe("set-password operator-token side-effect", () => {
  // First-run set-password must seed ~/.parachute/operator.token. Without
  // this, on-box CLI callers have nothing to present as a bearer when the
  // hub starts requiring auth on every request (no loopback bypass).
  test("creates operator.token on first-run, signed against active key, audience=operator", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      const { code, stdout } = await captureOutput(() =>
        auth(["set-password", "--password", "pw"], deps),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("operator token");
      const tokenOnDisk = await readOperatorTokenFile(tmp.dir);
      expect(tokenOnDisk).not.toBeNull();
      const db = openHubDb(tmp.dbPath);
      try {
        const validated = await validateAccessToken(db, tokenOnDisk ?? "");
        expect(validated.payload.aud).toBe(OPERATOR_TOKEN_AUDIENCE);
        expect(validated.payload.scope).toBe(OPERATOR_TOKEN_SCOPES.join(" "));
        const users = listUsers(db);
        expect(validated.payload.sub).toBe(users[0]?.id);
      } finally {
        db.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  // Password reset rotates the file too — old token stays valid until its
  // 1y TTL expires (the hub doesn't track operator-token jtis), but the
  // file always carries the freshest one.
  test("password update overwrites operator.token with a fresh JWT", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "old"], deps));
      const first = await readOperatorTokenFile(tmp.dir);
      // Sleep a beat to make sure the new JWT has a different iat — JWT
      // claims are second-precision.
      await new Promise((r) => setTimeout(r, 1100));
      await captureOutput(() => auth(["set-password", "--password", "new"], deps));
      const second = await readOperatorTokenFile(tmp.dir);
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("parachute auth rotate-operator", () => {
  test("mints a fresh token, overwrites the file, exits 0", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      await captureOutput(() => auth(["set-password", "--password", "pw"], deps));
      const before = await readOperatorTokenFile(tmp.dir);
      await new Promise((r) => setTimeout(r, 1100));
      const { code, stdout } = await captureOutput(() => auth(["rotate-operator"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("Rotated operator token");
      const after = await readOperatorTokenFile(tmp.dir);
      expect(after).not.toBeNull();
      expect(after).not.toBe(before);
    } finally {
      tmp.cleanup();
    }
  });

  test("with no users yet, exits 1 with a hint to run set-password", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = {
        dbPath: tmp.dbPath,
        configDir: tmp.dir,
        isInteractive: () => false,
      };
      const { code, stderr } = await captureOutput(() => auth(["rotate-operator"], deps));
      expect(code).toBe(1);
      expect(stderr).toContain("set-password");
    } finally {
      tmp.cleanup();
    }
  });
});

// closes #74 — the operator's surface for the DCR approval gate. The CLI
// is the only approval path at launch (no admin UI yet); these tests pin
// the round-trip so an operator can promote a pending registration.
describe("parachute auth pending-clients / approve-client", () => {
  test("pending-clients on an empty db says '(no pending OAuth clients)'", async () => {
    const tmp = makeTmp();
    try {
      const deps: AuthDeps = { dbPath: tmp.dbPath };
      const { code, stdout } = await captureOutput(() => auth(["pending-clients"], deps));
      expect(code).toBe(0);
      expect(stdout).toContain("no pending OAuth clients");
    } finally {
      tmp.cleanup();
    }
  });

  test("pending-clients lists pending rows; approve-client promotes them", async () => {
    const tmp = makeTmp();
    try {
      const { registerClient } = await import("../clients.ts");
      const db = openHubDb(tmp.dbPath);
      let pendingId: string;
      try {
        pendingId = registerClient(db, {
          redirectUris: ["https://app.example/cb"],
          status: "pending",
          clientName: "MyApp",
        }).client.clientId;
        registerClient(db, {
          redirectUris: ["https://approved.example/cb"],
          status: "approved",
          clientName: "Already",
        });
      } finally {
        db.close();
      }
      const deps: AuthDeps = { dbPath: tmp.dbPath };

      // pending-clients shows only the pending row.
      const list = await captureOutput(() => auth(["pending-clients"], deps));
      expect(list.code).toBe(0);
      expect(list.stdout).toContain(pendingId);
      expect(list.stdout).toContain("MyApp");
      expect(list.stdout).not.toContain("approved.example");

      // approve-client without an arg is a usage error.
      const noArg = await captureOutput(() => auth(["approve-client"], deps));
      expect(noArg.code).toBe(1);
      expect(noArg.stderr).toContain("missing client_id");

      // approve-client <unknown> is a 1.
      const unknown = await captureOutput(() => auth(["approve-client", "no-such"], deps));
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain("no OAuth client");

      // approve-client <pending> succeeds and the row drops off pending-clients.
      const ok = await captureOutput(() => auth(["approve-client", pendingId], deps));
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain("Approved");
      const after = await captureOutput(() => auth(["pending-clients"], deps));
      expect(after.stdout).toContain("no pending OAuth clients");
    } finally {
      tmp.cleanup();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthDeps, type Runner, auth, authHelp } from "../commands/auth.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
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

function makeTmp(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "phub-auth-"));
  return {
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
      const deps: AuthDeps = { dbPath: tmp.dbPath, isInteractive: () => false };
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
      const deps: AuthDeps = { dbPath: tmp.dbPath, isInteractive: () => false };
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
      const deps: AuthDeps = { dbPath: tmp.dbPath, isInteractive: () => false };
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
        auth(["set-password"], { dbPath: tmp.dbPath, isInteractive: () => false }),
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
        auth(["set-password", "--lol"], { dbPath: tmp.dbPath, isInteractive: () => false }),
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
      const deps: AuthDeps = { dbPath: tmp.dbPath, isInteractive: () => false };
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

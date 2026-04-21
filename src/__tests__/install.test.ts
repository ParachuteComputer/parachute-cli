import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "../commands/install.ts";
import { findService, upsertService } from "../services-manifest.ts";

function makeTempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-install-"));
  return {
    path: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("install", () => {
  test("rejects unknown service with exit 1", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("mystery", {
        runner: async () => 0,
        manifestPath: path,
        isLinked: () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/unknown service/);
    } finally {
      cleanup();
    }
  });

  test("runs bun add -g then init; seeds manifest when service didn't write one", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        isLinked: () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls[0]).toEqual(["bun", "add", "-g", "@openparachute/vault"]);
      expect(calls[1]).toEqual(["parachute-vault", "init"]);
      expect(logs.join("\n")).toMatch(/Seeded services\.json entry for parachute-vault/);
      const seeded = findService("parachute-vault", path);
      expect(seeded?.port).toBe(1940);
      expect(seeded?.version).toBe("0.0.0-linked");
    } finally {
      cleanup();
    }
  });

  test("confirms registration when manifest entry exists after init (no seeding)", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          if (cmd[0] === "parachute-vault") {
            upsertService(
              {
                name: "parachute-vault",
                port: 1940,
                paths: ["/"],
                health: "/health",
                version: "0.2.4",
              },
              path,
            );
          }
          return 0;
        },
        manifestPath: path,
        isLinked: () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/registered on port 1940/);
      expect(logs.join("\n")).not.toMatch(/Seeded/);
      const entry = findService("parachute-vault", path);
      expect(entry?.version).toBe("0.2.4");
    } finally {
      cleanup();
    }
  });

  test("propagates non-zero exit from bun add", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 42;
        },
        manifestPath: path,
        isLinked: () => false,
        log: () => {},
      });
      expect(code).toBe(42);
      expect(calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("warns when manifest entry lands outside the canonical port range", async () => {
    // Historically lens wrote 5173 (Vite's dev default). Canonical is
    // 1939–1949; warn so integrators know their service could conflict with
    // other software on the box, but don't block — forks may intentionally
    // deviate.
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("lens", {
        runner: async (cmd) => {
          if (cmd[0] === "bun") {
            upsertService(
              {
                name: "parachute-lens",
                port: 5173,
                paths: ["/lens"],
                health: "/lens/health",
                version: "0.0.1",
              },
              path,
            );
          }
          return 0;
        },
        manifestPath: path,
        isLinked: () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/registered on port 5173/);
      expect(logs.join("\n")).toMatch(/outside the canonical Parachute range/);
    } finally {
      cleanup();
    }
  });

  test("`install notes` aliases to lens with a rename notice", async () => {
    // Transition alias after the Lens rebrand (2026-04). Accepted for one
    // release cycle; removed after launch users have re-installed.
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("notes", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        isLinked: () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(
        /"notes" has been renamed to "lens"; installing lens\./,
      );
      // Downstream bun-add must use the new package name, not the old.
      expect(calls[0]).toEqual(["bun", "add", "-g", "@openparachute/lens"]);
      const seeded = findService("parachute-lens", path);
      expect(seeded?.port).toBe(1942);
    } finally {
      cleanup();
    }
  });

  test("does not warn when manifest port is in the canonical range", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      await install("vault", {
        runner: async (cmd) => {
          if (cmd[0] === "parachute-vault") {
            upsertService(
              {
                name: "parachute-vault",
                port: 1940,
                paths: ["/vault/default"],
                health: "/vault/default/health",
                version: "0.2.4",
              },
              path,
            );
          }
          return 0;
        },
        manifestPath: path,
        isLinked: () => false,
        log: (l) => logs.push(l),
      });
      expect(logs.join("\n")).not.toMatch(/outside the canonical/);
    } finally {
      cleanup();
    }
  });

  test("skips init when spec has none (scribe)", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        isLinked: () => false,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["bun", "add", "-g", "@openparachute/scribe"]);
      // scribe has no init, so seedEntry fires — no authoritative entry to defer to.
      const seeded = findService("parachute-scribe", path);
      expect(seeded?.port).toBe(1943);
      expect(logs.join("\n")).toMatch(/Seeded services\.json entry for parachute-scribe/);
    } finally {
      cleanup();
    }
  });

  test("skips `bun add -g` when the package is already bun-linked", async () => {
    // The scribe motivator: package isn't published to npm yet, so `bun add -g`
    // 404s. If bun link already points the global node_modules at a local
    // checkout, detect that and proceed to init + seeding.
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        isLinked: (pkg) => pkg === "@openparachute/scribe",
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/already linked globally/);
      const seeded = findService("parachute-scribe", path);
      expect(seeded?.port).toBe(1943);
      expect(seeded?.paths).toEqual(["/scribe"]);
    } finally {
      cleanup();
    }
  });

  test("--tag composes `<package>@<tag>` for the bun add call", async () => {
    // RC testers pin a pre-release channel via dist-tag (e.g. `--tag rc`).
    // The composed name shows up in logs so the operator knows which channel
    // they're on — no surprise upgrades when the tag rolls forward.
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        isLinked: () => false,
        log: (l) => logs.push(l),
        tag: "rc",
      });
      expect(code).toBe(0);
      expect(calls[0]).toEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
      expect(logs.join("\n")).toMatch(/Installing @openparachute\/vault@rc/);
    } finally {
      cleanup();
    }
  });

  test("--tag accepts an exact version string", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        isLinked: () => false,
        log: () => {},
        tag: "0.3.0-rc.1",
      });
      expect(code).toBe(0);
      expect(calls[0]).toEqual(["bun", "add", "-g", "@openparachute/vault@0.3.0-rc.1"]);
    } finally {
      cleanup();
    }
  });

  test("--tag is moot when the package is already bun-linked", async () => {
    // The link short-circuit beats the tag — local checkout wins, no fetch.
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          return 0;
        },
        manifestPath: path,
        isLinked: () => true,
        log: (l) => logs.push(l),
        tag: "rc",
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/already linked globally/);
    } finally {
      cleanup();
    }
  });

  test("error log on non-zero bun add includes the tagged spec", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async () => 1,
        manifestPath: path,
        isLinked: () => false,
        log: (l) => logs.push(l),
        tag: "rc",
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/bun add -g @openparachute\/vault@rc failed/);
    } finally {
      cleanup();
    }
  });

  test("linked vault still runs init and defers to init's manifest write", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const calls: string[][] = [];
      const logs: string[] = [];
      const code = await install("vault", {
        runner: async (cmd) => {
          calls.push([...cmd]);
          if (cmd[0] === "parachute-vault") {
            upsertService(
              {
                name: "parachute-vault",
                port: 1940,
                paths: ["/vault/default"],
                health: "/vault/default/health",
                version: "0.3.0",
              },
              path,
            );
          }
          return 0;
        },
        manifestPath: path,
        isLinked: () => true,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toEqual([["parachute-vault", "init"]]);
      expect(logs.join("\n")).not.toMatch(/Seeded/);
      expect(findService("parachute-vault", path)?.version).toBe("0.3.0");
    } finally {
      cleanup();
    }
  });

  // Auto-wire: when `parachute install` lands a service that completes the
  // vault↔scribe pair, generate a shared secret and persist to both sides.
  // Covered in detail by auto-wire.test.ts; these tests assert the install
  // command actually invokes the helper at the right moment.
  test("installing scribe with vault already present auto-wires the shared secret", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      // Pretend vault was installed previously — entry already in services.json.
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        path,
      );
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        isLinked: () => false,
        log: (l) => logs.push(l),
        randomToken: () => "test-token-value",
      });
      expect(code).toBe(0);

      const envPath = join(configDir, "vault", ".env");
      const scribeCfgPath = join(configDir, "scribe", "config.json");
      expect(existsSync(envPath)).toBe(true);
      expect(existsSync(scribeCfgPath)).toBe(true);

      const envText = readFileSync(envPath, "utf8");
      expect(envText).toContain("SCRIBE_AUTH_TOKEN=test-token-value");
      const cfg = JSON.parse(readFileSync(scribeCfgPath, "utf8"));
      expect(cfg.auth.required_token).toBe("test-token-value");

      expect(logs.join("\n")).toMatch(/Auto-wired shared secret for vault → scribe/);
    } finally {
      cleanup();
    }
  });

  test("installing scribe without vault does NOT auto-wire (nothing to wire against)", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      const logs: string[] = [];
      const code = await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        isLinked: () => false,
        log: (l) => logs.push(l),
        randomToken: () => "should-not-fire",
      });
      expect(code).toBe(0);
      // No vault/.env, no scribe/config.json written by auto-wire.
      expect(existsSync(join(configDir, "vault", ".env"))).toBe(false);
      expect(existsSync(join(configDir, "scribe", "config.json"))).toBe(false);
      expect(logs.join("\n")).not.toMatch(/Auto-wired shared secret/);
    } finally {
      cleanup();
    }
  });

  test("installing vault with scribe already present auto-wires (either-order)", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      upsertService(
        {
          name: "parachute-scribe",
          port: 1943,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.1.0",
        },
        path,
      );
      const code = await install("vault", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        isLinked: () => false,
        log: () => {},
        randomToken: () => "install-vault-side-token",
      });
      expect(code).toBe(0);
      const envText = readFileSync(join(configDir, "vault", ".env"), "utf8");
      expect(envText).toContain("SCRIBE_AUTH_TOKEN=install-vault-side-token");
    } finally {
      cleanup();
    }
  });

  test("repeat install preserves an existing SCRIBE_AUTH_TOKEN (idempotent)", async () => {
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        path,
      );
      // First install: mints a token.
      await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        isLinked: () => false,
        log: () => {},
        randomToken: () => "first-token",
      });
      // Second install: must preserve the first token — churning it would
      // break an already-running vault worker that's holding the old one.
      await install("scribe", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        isLinked: () => false,
        log: () => {},
        randomToken: () => "should-not-replace",
      });
      const envText = readFileSync(join(configDir, "vault", ".env"), "utf8");
      expect(envText).toContain("SCRIBE_AUTH_TOKEN=first-token");
      expect(envText).not.toContain("should-not-replace");
    } finally {
      cleanup();
    }
  });

  test("installing lens doesn't trigger auto-wire even if vault + scribe are present", async () => {
    // Defense: auto-wire should only fire from the scribe or vault install
    // path. A parallel install of a different service shouldn't touch the
    // shared-secret files.
    const { path, cleanup } = makeTempPath();
    const configDir = join(path, "..");
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        path,
      );
      upsertService(
        {
          name: "parachute-scribe",
          port: 1943,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.1.0",
        },
        path,
      );
      await install("lens", {
        runner: async () => 0,
        manifestPath: path,
        configDir,
        isLinked: () => false,
        log: () => {},
        randomToken: () => "should-not-fire",
      });
      expect(existsSync(join(configDir, "vault", ".env"))).toBe(false);
      expect(existsSync(join(configDir, "scribe", "config.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

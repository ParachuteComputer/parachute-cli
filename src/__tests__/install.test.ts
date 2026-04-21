import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
    // Historically notes wrote 5173 (Vite's dev default). Canonical is
    // 1939–1949; warn so integrators know their service could conflict with
    // other software on the box, but don't block — forks may intentionally
    // deviate.
    const { path, cleanup } = makeTempPath();
    try {
      const logs: string[] = [];
      const code = await install("notes", {
        runner: async (cmd) => {
          if (cmd[0] === "bun") {
            upsertService(
              {
                name: "parachute-notes",
                port: 5173,
                paths: ["/notes"],
                health: "/notes/health",
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
});

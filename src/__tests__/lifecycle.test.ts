import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logs, restart, start, stop } from "../commands/lifecycle.ts";
import { writeHubPort } from "../hub-control.ts";
import { ensureLogPath, logPath, readPid, writePid } from "../process-state.ts";
import { upsertService } from "../services-manifest.ts";

interface Harness {
  configDir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-life-"));
  return {
    configDir: dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seedVault(manifestPath: string): void {
  upsertService(
    {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
      version: "0.2.4",
    },
    manifestPath,
  );
}

function seedNotes(manifestPath: string): void {
  upsertService(
    {
      name: "parachute-notes",
      port: 5173,
      paths: ["/notes"],
      health: "/notes/health",
      version: "0.0.1",
    },
    manifestPath,
  );
}

interface SpawnerStub {
  spawn: (cmd: readonly string[], logFile: string, env?: Record<string, string>) => number;
  calls: Array<{
    cmd: readonly string[];
    logFile: string;
    env?: Record<string, string>;
  }>;
}

function makeSpawner(pidSequence: number[]): SpawnerStub {
  const calls: Array<{
    cmd: readonly string[];
    logFile: string;
    env?: Record<string, string>;
  }> = [];
  let i = 0;
  return {
    calls,
    spawn(cmd, logFile, env) {
      calls.push({ cmd: [...cmd], logFile, env });
      return pidSequence[i++] ?? 99999;
    },
  };
}

describe("parachute start", () => {
  test("errors cleanly when no services installed", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const code = await start(undefined, {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/No services installed/);
    } finally {
      h.cleanup();
    }
  });

  test("errors cleanly when targeting an uninstalled service", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const logs: string[] = [];
      const code = await start("notes", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/notes isn't installed/);
    } finally {
      h.cleanup();
    }
  });

  test("spawns vault with parachute-vault serve, writes PID", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const spawner = makeSpawner([4242]);
      const logs: string[] = [];
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(1);
      expect(spawner.calls[0]?.cmd).toEqual(["parachute-vault", "serve"]);
      expect(spawner.calls[0]?.logFile).toBe(logPath("vault", h.configDir));
      expect(readPid("vault", h.configDir)).toBe(4242);
      expect(logs.join("\n")).toMatch(/vault started \(pid 4242\)/);
    } finally {
      h.cleanup();
    }
  });

  test("notes start command includes configured port and notes-serve shim path", async () => {
    const h = makeHarness();
    try {
      seedNotes(h.manifestPath);
      const spawner = makeSpawner([5151]);
      const code = await start("notes", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      const cmd = spawner.calls[0]?.cmd ?? [];
      expect(cmd[0]).toBe("bun");
      expect(cmd.some((a) => a.endsWith("notes-serve.ts"))).toBe(true);
      const portIdx = cmd.indexOf("--port");
      expect(portIdx).toBeGreaterThan(-1);
      expect(cmd[portIdx + 1]).toBe("5173");
      const mountIdx = cmd.indexOf("--mount");
      expect(mountIdx).toBeGreaterThan(-1);
      expect(cmd[mountIdx + 1]).toBe("/notes");
    } finally {
      h.cleanup();
    }
  });

  test("no-op when already running", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const spawner = makeSpawner([9999]);
      const logs: string[] = [];
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        alive: () => true,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/already running \(pid 4242\)/);
      expect(readPid("vault", h.configDir)).toBe(4242);
    } finally {
      h.cleanup();
    }
  });

  test("clears stale PID file before spawning fresh", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const spawner = makeSpawner([7777]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        alive: () => false,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(1);
      expect(readPid("vault", h.configDir)).toBe(7777);
    } finally {
      h.cleanup();
    }
  });

  test("start (no svc) targets every installed + known service", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      seedNotes(h.manifestPath);
      const spawner = makeSpawner([4242, 5151]);
      const code = await start(undefined, {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(2);
      expect(readPid("vault", h.configDir)).toBe(4242);
      expect(readPid("notes", h.configDir)).toBe(5151);
    } finally {
      h.cleanup();
    }
  });

  test("legacy parachute-lens manifest entry still starts under the notes spec", async () => {
    // Users who installed during the brief Notes→Lens window (Apr 19–22)
    // will still have `parachute-lens` in services.json until their notes
    // package next boots and rewrites the row. Without the manifest alias,
    // shortNameForManifest returns undefined, resolveTargets skips the
    // entry, and they get "No manageable services" with no hint.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-lens",
          port: 5173,
          paths: ["/lens"],
          health: "/lens/health",
          version: "0.0.1",
        },
        h.manifestPath,
      );
      const spawner = makeSpawner([5151]);
      const code = await start(undefined, {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(1);
      expect(spawner.calls[0]?.cmd.some((a) => a.endsWith("notes-serve.ts"))).toBe(true);
      expect(readPid("notes", h.configDir)).toBe(5151);
    } finally {
      h.cleanup();
    }
  });

  test("passes PARACHUTE_HUB_ORIGIN from expose-state when set", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writeFileSync(
        join(h.configDir, "expose-state.json"),
        JSON.stringify({
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [],
          hubOrigin: "https://parachute.taildf9ce2.ts.net",
        }),
      );
      const spawner = makeSpawner([4242]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toEqual({
        PARACHUTE_HUB_ORIGIN: "https://parachute.taildf9ce2.ts.net",
      });
    } finally {
      h.cleanup();
    }
  });

  test("falls back to loopback origin from hub.port when not exposed", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writeHubPort(1939, h.configDir);
      const spawner = makeSpawner([4242]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toEqual({
        PARACHUTE_HUB_ORIGIN: "http://127.0.0.1:1939",
      });
    } finally {
      h.cleanup();
    }
  });

  test("--hub-origin override wins over expose-state", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writeFileSync(
        join(h.configDir, "expose-state.json"),
        JSON.stringify({
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [],
          hubOrigin: "https://parachute.taildf9ce2.ts.net",
        }),
      );
      const spawner = makeSpawner([4242]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        hubOrigin: "https://override.example.com/",
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toEqual({
        PARACHUTE_HUB_ORIGIN: "https://override.example.com",
      });
    } finally {
      h.cleanup();
    }
  });

  test("omits env when no override, no exposure, no hub port", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const spawner = makeSpawner([4242]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("merges <configDir>/<svc>/.env into the spawn env", async () => {
    // Scribe's API key prompt writes GROQ_API_KEY into ~/.parachute/scribe/.env.
    // Scribe itself doesn't auto-load .env, so `parachute start scribe` has to
    // forward the values into the child env or the API key won't take effect.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-scribe",
          port: 1943,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.1.0",
        },
        h.manifestPath,
      );
      ensureLogPath("scribe", h.configDir);
      writeFileSync(
        join(h.configDir, "scribe", ".env"),
        'GROQ_API_KEY=gsk_real_value\nQUOTED="quoted_val"\n',
      );
      const spawner = makeSpawner([7777]);
      const code = await start("scribe", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toEqual({
        GROQ_API_KEY: "gsk_real_value",
        QUOTED: "quoted_val",
      });
    } finally {
      h.cleanup();
    }
  });

  test("hub-origin override wins over conflicting key in service .env", async () => {
    // Defense: `start --hub-origin <url>` is the authoritative source for
    // PARACHUTE_HUB_ORIGIN. If a service .env happens to have the same key
    // (e.g. an old hand-edit), the live override should still apply.
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      ensureLogPath("vault", h.configDir);
      writeFileSync(
        join(h.configDir, "vault", ".env"),
        "SCRIBE_AUTH_TOKEN=secret\nPARACHUTE_HUB_ORIGIN=http://stale.local\n",
      );
      const spawner = makeSpawner([4242]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        hubOrigin: "https://live.example.com",
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toEqual({
        SCRIBE_AUTH_TOKEN: "secret",
        PARACHUTE_HUB_ORIGIN: "https://live.example.com",
      });
    } finally {
      h.cleanup();
    }
  });
});

describe("parachute stop", () => {
  test("no-op when nothing is running", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const killed: Array<[number, string | number]> = [];
      const logs: string[] = [];
      const code = await stop("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        kill: (pid, sig) => killed.push([pid, sig]),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(killed).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/wasn't running/);
    } finally {
      h.cleanup();
    }
  });

  test("cleans stale PID file without sending any signal", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const killed: Array<[number, string | number]> = [];
      const code = await stop("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        kill: (pid, sig) => killed.push([pid, sig]),
        alive: () => false,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(killed).toHaveLength(0);
      expect(readPid("vault", h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("SIGTERM + clean exit within window clears PID", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const killed: Array<[number, string | number]> = [];
      let aliveCall = 0;
      const code = await stop("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        kill: (pid, sig) => killed.push([pid, sig]),
        alive: () => {
          aliveCall++;
          return aliveCall === 1;
        },
        sleep: async () => {},
        log: () => {},
      });
      expect(code).toBe(0);
      expect(killed).toEqual([[4242, "SIGTERM"]]);
      expect(readPid("vault", h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("escalates to SIGKILL when SIGTERM doesn't land", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const killed: Array<[number, string | number]> = [];
      let t = 0;
      const code = await stop("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        kill: (pid, sig) => killed.push([pid, sig]),
        alive: () => true,
        sleep: async () => {},
        now: () => {
          // Jump past the kill-wait window so the polling loop exits fast.
          t += 20_000;
          return t;
        },
        killWaitMs: 10_000,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(killed[0]).toEqual([4242, "SIGTERM"]);
      expect(killed[killed.length - 1]).toEqual([4242, "SIGKILL"]);
      expect(readPid("vault", h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("parachute restart", () => {
  test("stops then starts in sequence", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const spawner = makeSpawner([7777]);
      const killed: Array<[number, string | number]> = [];
      const code = await restart("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        kill: (pid, sig) => killed.push([pid, sig]),
        alive: () => false,
        sleep: async () => {},
        log: () => {},
      });
      expect(code).toBe(0);
      expect(killed).toHaveLength(0); // stale pid → cleanup without kill
      expect(spawner.calls).toHaveLength(1);
      expect(readPid("vault", h.configDir)).toBe(7777);
    } finally {
      h.cleanup();
    }
  });
});

describe("parachute logs", () => {
  test("hint when no log file exists", async () => {
    const h = makeHarness();
    try {
      const lines: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toMatch(/no logs yet/);
    } finally {
      h.cleanup();
    }
  });

  test("prints last N lines in one-shot mode", async () => {
    const h = makeHarness();
    try {
      const p = ensureLogPath("vault", h.configDir);
      const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
      writeFileSync(p, `${content}\n`);
      const lines: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        lines: 3,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines).toEqual(["line 8", "line 9", "line 10"]);
    } finally {
      h.cleanup();
    }
  });

  test("unknown service errors cleanly", async () => {
    const h = makeHarness();
    try {
      const lines: string[] = [];
      const code = await logs("nope", {
        configDir: h.configDir,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toMatch(/unknown service/);
    } finally {
      h.cleanup();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logs, restart, start, stop } from "../commands/lifecycle.ts";
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
  spawn: (cmd: readonly string[], logFile: string) => number;
  calls: Array<{ cmd: readonly string[]; logFile: string }>;
}

function makeSpawner(pidSequence: number[]): SpawnerStub {
  const calls: Array<{ cmd: readonly string[]; logFile: string }> = [];
  let i = 0;
  return {
    calls,
    spawn(cmd, logFile) {
      calls.push({ cmd: [...cmd], logFile });
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
      expect(cmd.at(-2)).toBe("--port");
      expect(cmd.at(-1)).toBe("5173");
      expect(cmd.some((a) => a.endsWith("notes-serve.ts"))).toBe(true);
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

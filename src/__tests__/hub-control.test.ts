import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HubPortProbe,
  type HubSpawner,
  clearHubPort,
  ensureHubRunning,
  hubPortPath,
  readHubPort,
  stopHub,
  writeHubPort,
} from "../hub-control.ts";
import { pidPath, readPid, writePid } from "../process-state.ts";

interface Harness {
  configDir: string;
  wellKnownDir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-hub-ctl-"));
  return {
    configDir: dir,
    wellKnownDir: join(dir, "well-known"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface SpawnerStub {
  spawn: HubSpawner["spawn"];
  calls: Array<{ cmd: readonly string[]; logFile: string }>;
}

function makeSpawner(pid: number): SpawnerStub {
  const calls: Array<{ cmd: readonly string[]; logFile: string }> = [];
  return {
    calls,
    spawn(cmd, logFile) {
      calls.push({ cmd: [...cmd], logFile });
      return pid;
    },
  };
}

/** Probe that claims every port in a set is taken. */
function probeTaken(taken: Set<number>): HubPortProbe {
  return async (p) => !taken.has(p);
}

describe("port persistence helpers", () => {
  test("writeHubPort + readHubPort round-trip", () => {
    const h = makeHarness();
    try {
      writeHubPort(1942, h.configDir);
      expect(readHubPort(h.configDir)).toBe(1942);
      expect(existsSync(hubPortPath(h.configDir))).toBe(true);
      clearHubPort(h.configDir);
      expect(readHubPort(h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("ensureHubRunning", () => {
  test("spawns with --port + --well-known-dir, writes pid + port files", async () => {
    const h = makeHarness();
    try {
      const spawner = makeSpawner(5555);
      const result = await ensureHubRunning({
        configDir: h.configDir,
        wellKnownDir: h.wellKnownDir,
        spawner,
        alive: () => true,
        probe: probeTaken(new Set()),
        readyWaitMs: 0,
      });
      expect(result.started).toBe(true);
      expect(result.pid).toBe(5555);
      expect(result.port).toBe(1939);
      expect(spawner.calls).toHaveLength(1);
      const cmd = spawner.calls[0]?.cmd ?? [];
      expect(cmd[0]).toBe("bun");
      expect(cmd).toContain("--port");
      expect(cmd).toContain("1939");
      expect(cmd).toContain("--well-known-dir");
      expect(cmd).toContain(h.wellKnownDir);
      expect(readPid("hub", h.configDir)).toBe(5555);
      expect(readHubPort(h.configDir)).toBe(1939);
    } finally {
      h.cleanup();
    }
  });

  test("default fallback is 1 slot: fails when 1939 is taken", async () => {
    // Canonical layout pins hub to 1939. Walking up would collide with the
    // next service's slot, so the default is to fail and let the user unblock
    // the port — not quietly land somewhere else.
    const h = makeHarness();
    try {
      const spawner = makeSpawner(7777);
      await expect(
        ensureHubRunning({
          configDir: h.configDir,
          wellKnownDir: h.wellKnownDir,
          spawner,
          alive: () => true,
          probe: probeTaken(new Set([1939])),
          readyWaitMs: 0,
        }),
      ).rejects.toThrow(/lsof -iTCP:1939/);
    } finally {
      h.cleanup();
    }
  });

  test("fallback walks up when caller widens the range (debug/tests only)", async () => {
    const h = makeHarness();
    try {
      const spawner = makeSpawner(7777);
      const result = await ensureHubRunning({
        configDir: h.configDir,
        wellKnownDir: h.wellKnownDir,
        spawner,
        alive: () => true,
        probe: probeTaken(new Set([1939, 1940])),
        readyWaitMs: 0,
        fallbackRange: 5,
      });
      expect(result.port).toBe(1941);
      expect(readHubPort(h.configDir)).toBe(1941);
    } finally {
      h.cleanup();
    }
  });

  test("idempotent: returns existing pid + port when hub is already running", async () => {
    const h = makeHarness();
    try {
      writePid("hub", 12345, h.configDir);
      writeHubPort(1944, h.configDir);
      const spawner = makeSpawner(9999);
      const result = await ensureHubRunning({
        configDir: h.configDir,
        wellKnownDir: h.wellKnownDir,
        spawner,
        alive: () => true,
        probe: probeTaken(new Set()),
        readyWaitMs: 0,
      });
      expect(result.started).toBe(false);
      expect(result.pid).toBe(12345);
      expect(result.port).toBe(1944);
      expect(spawner.calls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("stale pid (process gone) is cleared and a fresh hub is spawned", async () => {
    const h = makeHarness();
    try {
      writePid("hub", 99, h.configDir);
      writeHubPort(1939, h.configDir);
      const spawner = makeSpawner(100);
      const result = await ensureHubRunning({
        configDir: h.configDir,
        wellKnownDir: h.wellKnownDir,
        spawner,
        alive: () => false,
        probe: probeTaken(new Set()),
        readyWaitMs: 0,
      });
      expect(result.started).toBe(true);
      expect(result.pid).toBe(100);
      expect(spawner.calls).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  test("throws when no port in the fallback range is free", async () => {
    const h = makeHarness();
    try {
      const spawner = makeSpawner(1);
      await expect(
        ensureHubRunning({
          configDir: h.configDir,
          wellKnownDir: h.wellKnownDir,
          spawner,
          alive: () => true,
          probe: async () => false,
          readyWaitMs: 0,
          fallbackRange: 3,
        }),
      ).rejects.toThrow(/unavailable/);
    } finally {
      h.cleanup();
    }
  });

  test("skips reserved service ports during fallback (widened range)", async () => {
    // Fallback is off by default (range=1). When a caller opens it up for
    // debug, reservedPorts must still be honored so the hub never steals a
    // registered service's slot even if the service isn't yet bound.
    const h = makeHarness();
    try {
      const spawner = makeSpawner(3333);
      const result = await ensureHubRunning({
        configDir: h.configDir,
        wellKnownDir: h.wellKnownDir,
        spawner,
        alive: () => true,
        probe: probeTaken(new Set([1939])), // default port is held
        reservedPorts: [1940], // vault's reservation
        readyWaitMs: 0,
        fallbackRange: 5,
      });
      // 1939 is taken, 1940 is reserved → we get 1941.
      expect(result.port).toBe(1941);
      expect(readHubPort(h.configDir)).toBe(1941);
    } finally {
      h.cleanup();
    }
  });

  test("honors startPort override", async () => {
    const h = makeHarness();
    try {
      const spawner = makeSpawner(2222);
      const result = await ensureHubRunning({
        configDir: h.configDir,
        wellKnownDir: h.wellKnownDir,
        spawner,
        alive: () => true,
        probe: probeTaken(new Set()),
        readyWaitMs: 0,
        startPort: 18080,
      });
      expect(result.port).toBe(18080);
    } finally {
      h.cleanup();
    }
  });
});

describe("stopHub", () => {
  test("SIGTERMs running hub, clears pid + port", async () => {
    const h = makeHarness();
    try {
      writePid("hub", 4242, h.configDir);
      writeHubPort(1939, h.configDir);
      let aliveNow = true;
      const signals: NodeJS.Signals[] = [];
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: (_pid, sig) => {
          signals.push(sig as NodeJS.Signals);
          aliveNow = false;
        },
        alive: () => aliveNow,
        sleep: async () => {},
        now: () => 0,
      });
      expect(stopped).toBe(true);
      expect(signals).toEqual(["SIGTERM"]);
      expect(existsSync(pidPath("hub", h.configDir))).toBe(false);
      expect(readHubPort(h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("escalates to SIGKILL when SIGTERM doesn't land", async () => {
    const h = makeHarness();
    try {
      writePid("hub", 4242, h.configDir);
      writeHubPort(1939, h.configDir);
      let t = 0;
      const signals: NodeJS.Signals[] = [];
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: (_pid, sig) => {
          signals.push(sig as NodeJS.Signals);
        },
        alive: () => true,
        sleep: async () => {
          t += 1000;
        },
        now: () => t,
        killWaitMs: 100,
        pollIntervalMs: 10,
      });
      expect(stopped).toBe(true);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      h.cleanup();
    }
  });

  test("no-op + cleans port file when no pid recorded", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: () => {
          throw new Error("must not be called");
        },
        alive: () => true,
        sleep: async () => {},
        now: () => 0,
      });
      expect(stopped).toBe(false);
      expect(readHubPort(h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("stale pid (process already gone) clears state without killing", async () => {
    const h = makeHarness();
    try {
      writePid("hub", 77, h.configDir);
      writeHubPort(1939, h.configDir);
      let killCalled = false;
      const stopped = await stopHub({
        configDir: h.configDir,
        kill: () => {
          killCalled = true;
        },
        alive: () => false,
        sleep: async () => {},
        now: () => 0,
      });
      expect(stopped).toBe(false);
      expect(killCalled).toBe(false);
      expect(existsSync(pidPath("hub", h.configDir))).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

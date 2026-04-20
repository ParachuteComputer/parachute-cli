import { existsSync, openSync } from "node:fs";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import {
  type AliveFn,
  clearPid,
  defaultAlive,
  ensureLogPath,
  logPath as logPathFor,
  processState,
  readPid,
  writePid,
} from "../process-state.ts";
import { getSpec, knownServices, shortNameForManifest } from "../service-spec.ts";
import { type ServiceEntry, readManifest } from "../services-manifest.ts";

/**
 * Tiny seam over `Bun.spawn` for lifecycle tests. The real spawner opens the
 * log file, appends stdout+stderr to it, and `unref()`s the child so parent
 * exit doesn't bring it down.
 */
export interface Spawner {
  spawn(cmd: readonly string[], logFile: string): number;
}

export const defaultSpawner: Spawner = {
  spawn(cmd, logFile) {
    const fd = openSync(logFile, "a");
    const proc = Bun.spawn([...cmd], { stdio: ["ignore", fd, fd] });
    proc.unref();
    return proc.pid;
  },
};

export type KillFn = (pid: number, signal: NodeJS.Signals | number) => void;
export type SleepFn = (ms: number) => Promise<void>;

export const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

export const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export interface LifecycleOpts {
  spawner?: Spawner;
  kill?: KillFn;
  alive?: AliveFn;
  sleep?: SleepFn;
  now?: () => number;
  manifestPath?: string;
  configDir?: string;
  log?: (line: string) => void;
  /** How long stop waits for SIGTERM before escalating to SIGKILL. */
  killWaitMs?: number;
  /** Poll interval while waiting for SIGTERM to land. */
  pollIntervalMs?: number;
}

interface Resolved {
  spawner: Spawner;
  kill: KillFn;
  alive: AliveFn;
  sleep: SleepFn;
  now: () => number;
  manifestPath: string;
  configDir: string;
  log: (line: string) => void;
  killWaitMs: number;
  pollIntervalMs: number;
}

function resolve(opts: LifecycleOpts): Resolved {
  return {
    spawner: opts.spawner ?? defaultSpawner,
    kill: opts.kill ?? defaultKill,
    alive: opts.alive ?? defaultAlive,
    sleep: opts.sleep ?? defaultSleep,
    now: opts.now ?? Date.now,
    manifestPath: opts.manifestPath ?? SERVICES_MANIFEST_PATH,
    configDir: opts.configDir ?? CONFIG_DIR,
    log: opts.log ?? ((line) => console.log(line)),
    killWaitMs: opts.killWaitMs ?? 10_000,
    pollIntervalMs: opts.pollIntervalMs ?? 200,
  };
}

/**
 * Services selected by the `[svc]` positional. `undefined` targets every
 * installed service (looked up via the manifest). Unknown names get a
 * friendly error up front rather than a confusing spawn failure downstream.
 */
function resolveTargets(
  svc: string | undefined,
  manifestPath: string,
): { targets: Array<{ short: string; entry: ServiceEntry }> } | { error: string } {
  const manifest = readManifest(manifestPath);
  if (manifest.services.length === 0) {
    return { error: "No services installed yet. Try: parachute install vault" };
  }

  if (svc !== undefined) {
    const spec = getSpec(svc);
    if (!spec) {
      return {
        error: `unknown service "${svc}". known: ${knownServices().join(", ")}`,
      };
    }
    const entry = manifest.services.find((s) => s.name === spec.manifestName);
    if (!entry) {
      return {
        error: `${svc} isn't installed. Run \`parachute install ${svc}\` first.`,
      };
    }
    return { targets: [{ short: svc, entry }] };
  }

  const targets: Array<{ short: string; entry: ServiceEntry }> = [];
  for (const entry of manifest.services) {
    const short = shortNameForManifest(entry.name);
    if (!short) continue;
    targets.push({ short, entry });
  }
  if (targets.length === 0) {
    return { error: "No manageable services in services.json." };
  }
  return { targets };
}

export async function start(svc: string | undefined, opts: LifecycleOpts = {}): Promise<number> {
  const r = resolve(opts);
  const picked = resolveTargets(svc, r.manifestPath);
  if ("error" in picked) {
    r.log(picked.error);
    return 1;
  }

  let failures = 0;
  for (const { short, entry } of picked.targets) {
    const state = processState(short, r.configDir, r.alive);
    if (state.status === "running") {
      r.log(`${short} already running (pid ${state.pid}).`);
      continue;
    }
    if (state.pid !== undefined) {
      // Stale PID file for a dead process — clear it before we spawn fresh.
      clearPid(short, r.configDir);
    }

    const spec = getSpec(short);
    const cmd = spec?.startCmd?.(entry);
    if (!cmd || cmd.length === 0) {
      r.log(`${short}: lifecycle not yet supported for this service.`);
      failures++;
      continue;
    }

    const logFile = ensureLogPath(short, r.configDir);
    try {
      const pid = r.spawner.spawn(cmd, logFile);
      writePid(short, pid, r.configDir);
      r.log(`✓ ${short} started (pid ${pid}); logs: ${logFile}`);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      r.log(`✗ ${short} failed to start: ${msg}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

export async function stop(svc: string | undefined, opts: LifecycleOpts = {}): Promise<number> {
  const r = resolve(opts);
  const picked = resolveTargets(svc, r.manifestPath);
  if ("error" in picked) {
    r.log(picked.error);
    return 1;
  }

  let failures = 0;
  for (const { short } of picked.targets) {
    const pid = readPid(short, r.configDir);
    if (pid === undefined) {
      r.log(`${short} wasn't running.`);
      continue;
    }
    if (!r.alive(pid)) {
      clearPid(short, r.configDir);
      r.log(`${short} wasn't running (cleaned stale pid file).`);
      continue;
    }

    try {
      r.kill(pid, "SIGTERM");
    } catch (err) {
      failures++;
      r.log(`✗ ${short}: SIGTERM failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const deadline = r.now() + r.killWaitMs;
    while (r.now() < deadline && r.alive(pid)) {
      await r.sleep(r.pollIntervalMs);
    }

    if (r.alive(pid)) {
      r.log(`${short} didn't exit after ${r.killWaitMs}ms; sending SIGKILL.`);
      try {
        r.kill(pid, "SIGKILL");
      } catch (err) {
        failures++;
        r.log(`✗ ${short}: SIGKILL failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    clearPid(short, r.configDir);
    r.log(`✓ ${short} stopped.`);
  }
  return failures === 0 ? 0 : 1;
}

export async function restart(svc: string | undefined, opts: LifecycleOpts = {}): Promise<number> {
  const stopCode = await stop(svc, opts);
  if (stopCode !== 0) return stopCode;
  return await start(svc, opts);
}

export interface LogsOpts {
  configDir?: string;
  log?: (line: string) => void;
  /** Tail stream — if omitted, uses `tail -n <lines> -f <file>` via spawn. */
  tailSpawner?: Spawner;
  /** Number of trailing lines to print (default 200). */
  lines?: number;
  follow?: boolean;
}

export async function logs(svc: string, opts: LogsOpts = {}): Promise<number> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const log = opts.log ?? ((line) => console.log(line));
  const lines = opts.lines ?? 200;
  const follow = opts.follow ?? false;

  const spec = getSpec(svc);
  if (!spec) {
    log(`unknown service "${svc}". known: ${knownServices().join(", ")}`);
    return 1;
  }

  const path = logPathFor(svc, configDir);
  if (!existsSync(path)) {
    log(`no logs yet for ${svc}. \`parachute start ${svc}\` to begin.`);
    return 0;
  }

  if (follow) {
    const spawner = opts.tailSpawner ?? {
      spawn(cmd) {
        const proc = Bun.spawn([...cmd], { stdio: ["ignore", "inherit", "inherit"] });
        return proc.pid;
      },
    };
    spawner.spawn(["tail", "-n", String(lines), "-f", path], path);
    // tail runs until user Ctrl-C; block this process until it exits.
    // When called from the real CLI, process.exit wraps us; in tests a
    // stub spawner returns immediately and we fall through.
    return 0;
  }

  // Non-follow path: read last N lines synchronously for a clean one-shot.
  const content = await Bun.file(path).text();
  const trimmed = content.replace(/\n$/, "");
  const allLines = trimmed === "" ? [] : trimmed.split("\n");
  const tail = allLines.slice(-lines);
  for (const line of tail) log(line);
  return 0;
}

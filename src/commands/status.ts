import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { type AliveFn, defaultAlive, formatUptime, processState } from "../process-state.ts";
import { shortNameForManifest } from "../service-spec.ts";
import { type ServiceEntry, readManifest } from "../services-manifest.ts";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface StatusOpts {
  manifestPath?: string;
  fetchImpl?: FetchFn;
  print?: (line: string) => void;
  timeoutMs?: number;
  configDir?: string;
  alive?: AliveFn;
  now?: () => Date;
}

export interface ProbeResult {
  entry: ServiceEntry;
  healthy: boolean;
  statusCode?: number;
  error?: string;
  latencyMs: number;
}

export async function probe(
  entry: ServiceEntry,
  fetchImpl: FetchFn,
  timeoutMs: number,
): Promise<ProbeResult> {
  const url = `http://localhost:${entry.port}${entry.health}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    const latencyMs = Math.round(performance.now() - start);
    return {
      entry,
      healthy: res.ok,
      statusCode: res.status,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      entry,
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatRow(cells: string[], widths: number[]): string {
  return cells
    .map((c, i) => c.padEnd(widths[i] ?? 0, " "))
    .join("  ")
    .trimEnd();
}

export async function status(opts: StatusOpts = {}): Promise<number> {
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const print = opts.print ?? ((line) => console.log(line));
  const timeoutMs = opts.timeoutMs ?? 1500;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const alive = opts.alive ?? defaultAlive;
  const now = opts.now ?? (() => new Date());

  const manifest = readManifest(manifestPath);
  if (manifest.services.length === 0) {
    print("No services installed yet.");
    print("Try: parachute install vault");
    return 0;
  }

  const nowDate = now();

  /**
   * Per-row resolution: look up the short name so we can read PID state,
   * skip the health probe when the process is known-stopped (ECONNREFUSED
   * noise isn't informative), and report it as running/stopped + uptime.
   *
   * Third-party services we don't know about fall back to probing and show
   * "-" for process columns.
   */
  const rows = await Promise.all(
    manifest.services.map(async (entry) => {
      const short = shortNameForManifest(entry.name);
      const proc = short ? processState(short, configDir, alive) : undefined;

      const processLabel =
        proc?.status === "running" ? "running" : proc?.status === "stopped" ? "stopped" : "-";
      const pidLabel =
        proc?.status === "running" && proc.pid !== undefined ? String(proc.pid) : "-";
      const uptimeLabel =
        proc?.status === "running" && proc.startedAt ? formatUptime(proc.startedAt, nowDate) : "-";

      // Only skip probe when we know the process is dead (PID file was
      // present but kill(pid, 0) failed). "unknown" status (no PID file)
      // still probes — externally-managed services should report health.
      if (proc?.status === "stopped") {
        return {
          entry,
          processLabel,
          pidLabel,
          uptimeLabel,
          healthLabel: "-",
          latencyLabel: "-",
          healthy: false,
          skipped: true,
        };
      }

      const p = await probe(entry, fetchImpl, timeoutMs);
      const healthLabel = p.healthy
        ? "ok"
        : p.statusCode !== undefined
          ? `http ${p.statusCode}`
          : (p.error ?? "down");
      return {
        entry,
        processLabel,
        pidLabel,
        uptimeLabel,
        healthLabel,
        latencyLabel: `${p.latencyMs}ms`,
        healthy: p.healthy,
        skipped: false,
      };
    }),
  );

  const header = ["SERVICE", "PORT", "VERSION", "PROCESS", "PID", "UPTIME", "HEALTH", "LATENCY"];
  const textRows = rows.map((r) => [
    r.entry.name,
    String(r.entry.port),
    r.entry.version,
    r.processLabel,
    r.pidLabel,
    r.uptimeLabel,
    r.healthLabel,
    r.latencyLabel,
  ]);
  const widths = header.map((_, i) =>
    Math.max(header[i]?.length ?? 0, ...textRows.map((r) => r[i]?.length ?? 0)),
  );
  print(formatRow(header, widths));
  for (const r of textRows) print(formatRow(r, widths));

  /**
   * Overall exit: non-zero if any *probed* service is unhealthy. A stopped
   * service is expected ("I haven't started it yet"), not a failure — users
   * want `parachute status` to return 0 after a fresh install before they
   * `parachute start`. Health regressions among running services still 1.
   */
  const anyUnhealthy = rows.some((r) => !r.skipped && !r.healthy);
  return anyUnhealthy ? 1 : 0;
}

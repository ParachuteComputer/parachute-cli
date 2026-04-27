import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { HUB_SVC, readHubPort } from "../hub-control.ts";
import { type AliveFn, defaultAlive, formatUptime, processState } from "../process-state.ts";
import { getSpec, shortNameForManifest } from "../service-spec.ts";
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

interface StatusRow {
  service: string;
  port: string;
  version: string;
  processLabel: string;
  pidLabel: string;
  uptimeLabel: string;
  healthLabel: string;
  latencyLabel: string;
  url: string | undefined;
  healthy: boolean;
  skipped: boolean;
}

/**
 * Canonical reachable URL for a row. Spec-driven where possible (vault appends
 * `/mcp`, scribe is at the root, …). Unknown services fall back to bare
 * `http://127.0.0.1:<port>` plus the first declared path so third-party
 * services still get a useful pointer rather than an empty cell.
 */
function urlForEntry(entry: ServiceEntry, short: string | undefined): string | undefined {
  const spec = short ? getSpec(short) : undefined;
  const fromSpec = spec?.urlForEntry?.(entry);
  if (fromSpec) return fromSpec;
  const first = entry.paths[0]?.replace(/\/+$/, "") ?? "";
  return `http://127.0.0.1:${entry.port}${first}`;
}

function hubRow(configDir: string, alive: AliveFn, nowDate: Date): StatusRow | undefined {
  const proc = processState(HUB_SVC, configDir, alive);
  if (proc.status === "unknown") return undefined;
  const port = readHubPort(configDir);
  const portLabel = port !== undefined ? String(port) : "-";
  const processLabel = proc.status === "running" ? "running" : "stopped";
  const pidLabel = proc.status === "running" && proc.pid !== undefined ? String(proc.pid) : "-";
  const uptimeLabel =
    proc.status === "running" && proc.startedAt ? formatUptime(proc.startedAt, nowDate) : "-";
  return {
    service: "parachute-hub (internal)",
    port: portLabel,
    version: "-",
    processLabel,
    pidLabel,
    uptimeLabel,
    healthLabel: "-",
    latencyLabel: "-",
    url: port !== undefined ? `http://127.0.0.1:${port}` : undefined,
    healthy: true,
    skipped: true,
  };
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
  const rows: StatusRow[] = await Promise.all(
    manifest.services.map(async (entry) => {
      // Third-party rows (with `installDir`) live under `~/.parachute/<entry.name>/`,
      // matching what `parachute start` uses as the short. First-party rows still
      // map manifestName → short via the canonical fallback.
      const short = shortNameForManifest(entry.name) ?? (entry.installDir ? entry.name : undefined);
      const proc = short ? processState(short, configDir, alive) : undefined;

      const processLabel =
        proc?.status === "running" ? "running" : proc?.status === "stopped" ? "stopped" : "-";
      const pidLabel =
        proc?.status === "running" && proc.pid !== undefined ? String(proc.pid) : "-";
      const uptimeLabel =
        proc?.status === "running" && proc.startedAt ? formatUptime(proc.startedAt, nowDate) : "-";

      const url = urlForEntry(entry, short);

      // Only skip probe when we know the process is dead (PID file was
      // present but kill(pid, 0) failed). "unknown" status (no PID file)
      // still probes — externally-managed services should report health.
      if (proc?.status === "stopped") {
        return {
          service: entry.name,
          port: String(entry.port),
          version: entry.version,
          processLabel,
          pidLabel,
          uptimeLabel,
          healthLabel: "-",
          latencyLabel: "-",
          url,
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
        service: entry.name,
        port: String(entry.port),
        version: entry.version,
        processLabel,
        pidLabel,
        uptimeLabel,
        healthLabel,
        latencyLabel: `${p.latencyMs}ms`,
        url,
        healthy: p.healthy,
        skipped: false,
      };
    }),
  );

  // Hub is an internal service — not in services.json, but users notice
  // when it's dead. Only show it if we've seen it run.
  const hub = hubRow(configDir, alive, nowDate);
  if (hub) rows.push(hub);

  const header = ["SERVICE", "PORT", "VERSION", "PROCESS", "PID", "UPTIME", "HEALTH", "LATENCY"];
  const textRows = rows.map((r) => [
    r.service,
    r.port,
    r.version,
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
  // URL stays on a continuation line rather than a column. URLs are long
  // (vault's MCP path runs ~40 chars), and a ninth column would push the
  // table past 80 cols on every install. The "  → " prefix groups visually
  // with the row above without misleading the table widths.
  for (let i = 0; i < textRows.length; i++) {
    const cells = textRows[i];
    const row = rows[i];
    if (!cells || !row) continue;
    print(formatRow(cells, widths));
    if (row.url) print(`  → ${row.url}`);
  }

  /**
   * Overall exit: non-zero if any *probed* service is unhealthy. A stopped
   * service is expected ("I haven't started it yet"), not a failure — users
   * want `parachute status` to return 0 after a fresh install before they
   * `parachute start`. Health regressions among running services still 1.
   */
  const anyUnhealthy = rows.some((r) => !r.skipped && !r.healthy);
  return anyUnhealthy ? 1 : 0;
}

import { SERVICES_MANIFEST_PATH } from "../config.ts";
import { type ServiceEntry, readManifest } from "../services-manifest.ts";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface StatusOpts {
  manifestPath?: string;
  fetchImpl?: FetchFn;
  print?: (line: string) => void;
  timeoutMs?: number;
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

  const manifest = readManifest(manifestPath);
  if (manifest.services.length === 0) {
    print("No services installed yet.");
    print("Try: parachute install vault");
    return 0;
  }

  const probes = await Promise.all(manifest.services.map((e) => probe(e, fetchImpl, timeoutMs)));

  const header = ["SERVICE", "PORT", "VERSION", "STATUS", "LATENCY"];
  const rows = probes.map((p) => {
    const status = p.healthy
      ? "ok"
      : p.statusCode !== undefined
        ? `http ${p.statusCode}`
        : (p.error ?? "down");
    return [p.entry.name, String(p.entry.port), p.entry.version, status, `${p.latencyMs}ms`];
  });

  const widths = header.map((_, i) =>
    Math.max(header[i]?.length ?? 0, ...rows.map((r) => r[i]?.length ?? 0)),
  );

  print(formatRow(header, widths));
  for (const r of rows) print(formatRow(r, widths));

  return probes.every((p) => p.healthy) ? 0 : 1;
}

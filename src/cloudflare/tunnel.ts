import { join } from "node:path";
import type { CommandResult, Runner } from "../tailscale/run.ts";

export class CloudflaredError extends Error {
  override name = "CloudflaredError";
  constructor(
    message: string,
    public readonly cmd: readonly string[],
    public readonly result: CommandResult,
  ) {
    super(message);
  }
}

export interface Tunnel {
  id: string;
  name: string;
  createdAt?: string;
}

function combineErrStreams(result: CommandResult): string {
  const e = result.stderr.trim();
  if (e.length > 0) return e;
  return result.stdout.trim();
}

/**
 * Parse `cloudflared tunnel list --output json`. The schema is stable: an
 * array of objects each with `id` (UUID) and `name`. We ignore extra fields.
 * Entries missing either id or name are skipped rather than thrown — keeps
 * us forward-compatible with cloudflared adding new tunnel shapes.
 */
export async function listTunnels(runner: Runner): Promise<Tunnel[]> {
  const cmd = ["cloudflared", "tunnel", "list", "--output", "json"];
  const result = await runner(cmd);
  if (result.code !== 0) {
    throw new CloudflaredError(
      `cloudflared tunnel list failed: ${combineErrStreams(result)}`,
      cmd,
      result,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new CloudflaredError(
      `failed to parse cloudflared tunnel list JSON: ${err instanceof Error ? err.message : String(err)}`,
      cmd,
      result,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CloudflaredError("cloudflared tunnel list did not return a JSON array", cmd, result);
  }
  const tunnels: Tunnel[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : undefined;
    const name = typeof r.name === "string" ? r.name : undefined;
    if (!id || !name) continue;
    const t: Tunnel = { id, name };
    if (typeof r.created_at === "string") t.createdAt = r.created_at;
    tunnels.push(t);
  }
  return tunnels;
}

export async function findTunnelByName(runner: Runner, name: string): Promise<Tunnel | undefined> {
  const tunnels = await listTunnels(runner);
  return tunnels.find((t) => t.name === name);
}

/**
 * `cloudflared tunnel create <name>` writes credentials to
 * `~/.cloudflared/<UUID>.json` and prints a line like
 *
 *   Created tunnel parachute with id 2c1a7c7e-…-b3ef7c1d9a2a
 *
 * We parse the UUID from stdout rather than requiring callers to walk the
 * credentials dir afterward — less filesystem coupling, and the UUID format
 * is stable (RFC 4122 lowercase hex).
 */
export async function createTunnel(runner: Runner, name: string): Promise<Tunnel> {
  const cmd = ["cloudflared", "tunnel", "create", name];
  const result = await runner(cmd);
  if (result.code !== 0) {
    throw new CloudflaredError(
      `cloudflared tunnel create failed: ${combineErrStreams(result)}`,
      cmd,
      result,
    );
  }
  const match = result.stdout.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (!match) {
    throw new CloudflaredError(
      `could not parse tunnel UUID from cloudflared output: ${result.stdout.trim()}`,
      cmd,
      result,
    );
  }
  return { id: match[1]!, name };
}

export async function routeDns(
  runner: Runner,
  tunnelName: string,
  hostname: string,
): Promise<void> {
  const cmd = ["cloudflared", "tunnel", "route", "dns", tunnelName, hostname];
  const result = await runner(cmd);
  if (result.code !== 0) {
    throw new CloudflaredError(
      `cloudflared tunnel route dns failed: ${combineErrStreams(result)}`,
      cmd,
      result,
    );
  }
}

export function credentialsPath(uuid: string, cloudflaredHome: string): string {
  return join(cloudflaredHome, `${uuid}.json`);
}

/**
 * State file for an active cloudflared quick tunnel. Separate from
 * `expose-state.json` (which tracks tailscale serve) because the shape and
 * lifecycle are independent — a user can have tailscale + cloudflared both
 * active in principle, though `parachute expose` serializes to one at a time.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "../config.ts";

export const CLOUDFLARE_STATE_PATH = join(CONFIG_DIR, "cloudflared-state.json");

export interface CloudflaredState {
  version: 1;
  pid: number;
  url: string;
  localPort: number;
  startedAt: string;
}

export class CloudflaredStateError extends Error {
  override name = "CloudflaredStateError";
}

function validate(raw: unknown, path: string): CloudflaredState {
  if (!raw || typeof raw !== "object") {
    throw new CloudflaredStateError(`${path}: root must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) {
    throw new CloudflaredStateError(`${path}: unsupported version ${String(r.version)}`);
  }
  if (typeof r.pid !== "number" || !Number.isInteger(r.pid)) {
    throw new CloudflaredStateError(`${path}: pid must be an integer`);
  }
  if (typeof r.url !== "string" || !r.url.startsWith("https://")) {
    throw new CloudflaredStateError(`${path}: url must be an https://… string`);
  }
  if (typeof r.localPort !== "number" || !Number.isInteger(r.localPort)) {
    throw new CloudflaredStateError(`${path}: localPort must be an integer`);
  }
  if (typeof r.startedAt !== "string") {
    throw new CloudflaredStateError(`${path}: startedAt must be a string`);
  }
  return {
    version: 1,
    pid: r.pid,
    url: r.url,
    localPort: r.localPort,
    startedAt: r.startedAt,
  };
}

export function readCloudflaredState(
  path: string = CLOUDFLARE_STATE_PATH,
): CloudflaredState | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CloudflaredStateError(
      `failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validate(raw, path);
}

export function writeCloudflaredState(
  state: CloudflaredState,
  path: string = CLOUDFLARE_STATE_PATH,
): void {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function clearCloudflaredState(path: string = CLOUDFLARE_STATE_PATH): void {
  if (existsSync(path)) unlinkSync(path);
}

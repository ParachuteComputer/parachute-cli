import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "../config.ts";

export const CLOUDFLARED_STATE_PATH = join(CONFIG_DIR, "cloudflared-state.json");

export interface CloudflaredState {
  version: 1;
  pid: number;
  tunnelUuid: string;
  tunnelName: string;
  hostname: string;
  /** ISO-8601 start timestamp — debugging only. */
  startedAt: string;
  /** Absolute path to the cloudflared config.yml driving this tunnel. */
  configPath: string;
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
  if (typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid <= 0) {
    throw new CloudflaredStateError(`${path}: pid must be a positive integer`);
  }
  if (typeof r.tunnelUuid !== "string" || r.tunnelUuid.length === 0) {
    throw new CloudflaredStateError(`${path}: tunnelUuid must be a non-empty string`);
  }
  if (typeof r.tunnelName !== "string" || r.tunnelName.length === 0) {
    throw new CloudflaredStateError(`${path}: tunnelName must be a non-empty string`);
  }
  if (typeof r.hostname !== "string" || r.hostname.length === 0) {
    throw new CloudflaredStateError(`${path}: hostname must be a non-empty string`);
  }
  if (typeof r.startedAt !== "string" || r.startedAt.length === 0) {
    throw new CloudflaredStateError(`${path}: startedAt must be a non-empty string`);
  }
  if (typeof r.configPath !== "string" || r.configPath.length === 0) {
    throw new CloudflaredStateError(`${path}: configPath must be a non-empty string`);
  }
  return {
    version: 1,
    pid: r.pid,
    tunnelUuid: r.tunnelUuid,
    tunnelName: r.tunnelName,
    hostname: r.hostname,
    startedAt: r.startedAt,
    configPath: r.configPath,
  };
}

export function readCloudflaredState(
  path: string = CLOUDFLARED_STATE_PATH,
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
  path: string = CLOUDFLARED_STATE_PATH,
): void {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function clearCloudflaredState(path: string = CLOUDFLARED_STATE_PATH): void {
  if (existsSync(path)) unlinkSync(path);
}

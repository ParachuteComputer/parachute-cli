import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SERVICES_MANIFEST_PATH } from "./config.ts";

/**
 * Whether the service is safe to mount on public-facing expose layers.
 *
 *   "allowed"       mount on every layer (tailnet + public). Use when the
 *                   service gates its own endpoints with auth.
 *   "loopback"      never mount on tailnet/funnel — only reachable at
 *                   http://127.0.0.1:<port>. For internal services that
 *                   shouldn't leave the box.
 *   "auth-required" the service wants auth but isn't guaranteed to have it
 *                   configured (e.g., scribe without SCRIBE_AUTH_TOKEN set).
 *                   At launch this is treated the same as "loopback"; future
 *                   work can flip to "allowed" once the service reports its
 *                   auth state over `/.parachute/info`.
 *
 * Absent field: the CLI derives a safe default from the service's ServiceSpec
 * (known api/tool services without declared auth → "auth-required"; everything
 * else → "allowed"). Unknown services default to "allowed" for back-compat.
 */
export type PublicExposure = "allowed" | "loopback" | "auth-required";

export interface ServiceEntry {
  name: string;
  port: number;
  paths: string[];
  health: string;
  version: string;
  /** Human-readable name for the hub page. Falls back to the short manifest name. */
  displayName?: string;
  /** One-line subtitle for the hub page card. */
  tagline?: string;
  /** Opt-in or opt-out of public-facing expose layers. See PublicExposure. */
  publicExposure?: PublicExposure;
}

export interface ServicesManifest {
  services: ServiceEntry[];
}

export class ServicesManifestError extends Error {
  override name = "ServicesManifestError";
}

const EMPTY: ServicesManifest = { services: [] };

function validateEntry(raw: unknown, where: string): ServiceEntry {
  if (!raw || typeof raw !== "object") {
    throw new ServicesManifestError(`${where}: expected object, got ${typeof raw}`);
  }
  const e = raw as Record<string, unknown>;
  const name = e.name;
  const port = e.port;
  const paths = e.paths;
  const health = e.health;
  const version = e.version;
  if (typeof name !== "string" || name.length === 0) {
    throw new ServicesManifestError(`${where}: "name" must be a non-empty string`);
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ServicesManifestError(`${where}: "port" must be an integer 1..65535`);
  }
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
    throw new ServicesManifestError(`${where}: "paths" must be an array of strings`);
  }
  if (typeof health !== "string" || !health.startsWith("/")) {
    throw new ServicesManifestError(`${where}: "health" must be a path starting with "/"`);
  }
  if (typeof version !== "string") {
    throw new ServicesManifestError(`${where}: "version" must be a string`);
  }
  const displayName = e.displayName;
  const tagline = e.tagline;
  const publicExposure = e.publicExposure;
  if (displayName !== undefined && typeof displayName !== "string") {
    throw new ServicesManifestError(`${where}: "displayName" must be a string if present`);
  }
  if (tagline !== undefined && typeof tagline !== "string") {
    throw new ServicesManifestError(`${where}: "tagline" must be a string if present`);
  }
  if (
    publicExposure !== undefined &&
    publicExposure !== "allowed" &&
    publicExposure !== "loopback" &&
    publicExposure !== "auth-required"
  ) {
    throw new ServicesManifestError(
      `${where}: "publicExposure" must be "allowed" | "loopback" | "auth-required" if present`,
    );
  }
  const entry: ServiceEntry = { name, port, paths: paths as string[], health, version };
  if (displayName !== undefined) entry.displayName = displayName;
  if (tagline !== undefined) entry.tagline = tagline;
  if (publicExposure !== undefined) entry.publicExposure = publicExposure as PublicExposure;
  return entry;
}

function validateManifest(raw: unknown, where: string): ServicesManifest {
  if (!raw || typeof raw !== "object") {
    throw new ServicesManifestError(`${where}: root must be an object`);
  }
  const services = (raw as Record<string, unknown>).services;
  if (!Array.isArray(services)) {
    throw new ServicesManifestError(`${where}: "services" must be an array`);
  }
  return {
    services: services.map((s, i) => validateEntry(s, `${where} services[${i}]`)),
  };
}

export function readManifest(path: string = SERVICES_MANIFEST_PATH): ServicesManifest {
  if (!existsSync(path)) return { services: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ServicesManifestError(
      `failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateManifest(raw, path);
}

export function writeManifest(
  manifest: ServicesManifest,
  path: string = SERVICES_MANIFEST_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}

export function upsertService(
  entry: ServiceEntry,
  path: string = SERVICES_MANIFEST_PATH,
): ServicesManifest {
  validateEntry(entry, "entry");
  const current = existsSync(path) ? readManifest(path) : structuredClone(EMPTY);
  const idx = current.services.findIndex((s) => s.name === entry.name);
  if (idx >= 0) {
    current.services[idx] = entry;
  } else {
    current.services.push(entry);
  }
  writeManifest(current, path);
  return current;
}

export function removeService(
  name: string,
  path: string = SERVICES_MANIFEST_PATH,
): ServicesManifest {
  if (!existsSync(path)) return structuredClone(EMPTY);
  const current = readManifest(path);
  const next: ServicesManifest = {
    services: current.services.filter((s) => s.name !== name),
  };
  writeManifest(next, path);
  return next;
}

export function findService(
  name: string,
  path: string = SERVICES_MANIFEST_PATH,
): ServiceEntry | undefined {
  if (!existsSync(path)) return undefined;
  return readManifest(path).services.find((s) => s.name === name);
}

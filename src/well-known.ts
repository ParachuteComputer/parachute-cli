import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import type { ServiceEntry } from "./services-manifest.ts";

export interface WellKnownServiceEntry {
  url: string;
  version: string;
}

export interface WellKnownVaultEntry {
  name: string;
  url: string;
  version: string;
}

/**
 * Flat service descriptor — one per installed service, used by the hub page
 * to iterate without having to know every service's shortName ahead of time.
 * `infoUrl` points at the service's `/.parachute/info` endpoint (relative to
 * its mount path) which the hub fetches client-side for displayName/tagline.
 */
export interface WellKnownServicesEntry {
  name: string;
  url: string;
  path: string;
  version: string;
  infoUrl: string;
}

/**
 * Canonical `/.well-known/parachute.json` shape.
 *
 * Three parts, all additive so old clients keep working:
 *   - `vaults: []` — always an array; vault is the ecosystem's only
 *     multi-tenant service.
 *   - `services: []` — flat list the hub page iterates. Scales to N frontends
 *     without the consumer needing to know every shortName.
 *   - Top-level flat keys (`notes`, `scribe`, …) — kept for back-compat with
 *     clients that predate `services[]`.
 */
export type WellKnownDocument = {
  vaults: WellKnownVaultEntry[];
  services: WellKnownServicesEntry[];
} & {
  [shortName: string]:
    | WellKnownVaultEntry[]
    | WellKnownServicesEntry[]
    | WellKnownServiceEntry
    | undefined;
};

export const WELL_KNOWN_DIR = join(CONFIG_DIR, "well-known");
export const WELL_KNOWN_PATH = join(WELL_KNOWN_DIR, "parachute.json");
export const WELL_KNOWN_MOUNT = "/.well-known/parachute.json";

const VAULT_MANIFEST_PREFIX = "parachute-vault";

/** Strip the conventional `parachute-` prefix for the well-known document's keys. */
export function shortName(manifestName: string): string {
  return manifestName.replace(/^parachute-/, "");
}

/**
 * True when this manifest entry is a vault instance. Any name that starts
 * with `parachute-vault` counts, so post-multi-tenancy names like
 * `parachute-vault-work` also route to the vaults array.
 */
export function isVaultEntry(entry: ServiceEntry): boolean {
  return entry.name === VAULT_MANIFEST_PREFIX || entry.name.startsWith(`${VAULT_MANIFEST_PREFIX}-`);
}

/**
 * Derive a vault instance name. Prefer a `/vault/<name>` path segment; fall
 * back to the manifest-name suffix (`parachute-vault-work` → `work`); last
 * resort is "default".
 */
export function vaultInstanceName(entry: ServiceEntry): string {
  const path = entry.paths[0];
  if (path) {
    const match = path.match(/^\/vault\/([^/]+)/);
    if (match?.[1]) return match[1];
  }
  if (entry.name.startsWith(`${VAULT_MANIFEST_PREFIX}-`)) {
    return entry.name.slice(VAULT_MANIFEST_PREFIX.length + 1);
  }
  return "default";
}

export interface BuildWellKnownOpts {
  services: readonly ServiceEntry[];
  canonicalOrigin: string;
}

/** Join a base origin and a path without double slashes — "/" stays "/". */
function joinInfoPath(path: string): string {
  const trimmed = path.replace(/\/$/, "");
  return `${trimmed}/.parachute/info`;
}

export function buildWellKnown(opts: BuildWellKnownOpts): WellKnownDocument {
  const base = opts.canonicalOrigin.replace(/\/$/, "");
  const doc: WellKnownDocument = { vaults: [], services: [] };
  for (const s of opts.services) {
    const path = s.paths[0] ?? "/";
    const url = new URL(path, `${base}/`).toString();
    const infoPath = joinInfoPath(path);
    const infoUrl = new URL(infoPath, `${base}/`).toString();
    doc.services.push({ name: s.name, url, path, version: s.version, infoUrl });
    if (isVaultEntry(s)) {
      doc.vaults.push({ name: vaultInstanceName(s), url, version: s.version });
    } else {
      doc[shortName(s.name)] = { url, version: s.version };
    }
  }
  return doc;
}

export function writeWellKnownFile(doc: WellKnownDocument, path: string = WELL_KNOWN_PATH): string {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

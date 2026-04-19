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
 * Canonical `/.well-known/parachute.json` shape.
 *
 * `vaults` is always an array — even for the single-default-vault case —
 * because vault is the only multi-tenant service in the ecosystem. Other
 * services are single-entry objects keyed by their short name.
 *
 * Example (launch-grade):
 * {
 *   "vaults": [{ "name": "default", "url": "https://host/vault/default", "version": "0.2.4" }],
 *   "notes":  { "url": "https://host/notes",  "version": "0.3.0" },
 *   "scribe": { "url": "https://host/scribe", "version": "0.1.0" }
 * }
 */
export type WellKnownDocument = {
  vaults: WellKnownVaultEntry[];
} & { [shortName: string]: WellKnownVaultEntry[] | WellKnownServiceEntry | undefined };

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

export function buildWellKnown(opts: BuildWellKnownOpts): WellKnownDocument {
  const base = opts.canonicalOrigin.replace(/\/$/, "");
  const doc: WellKnownDocument = { vaults: [] };
  for (const s of opts.services) {
    const path = s.paths[0] ?? "/";
    const url = new URL(path, `${base}/`).toString();
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

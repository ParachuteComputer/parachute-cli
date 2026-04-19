import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import type { ServiceEntry } from "./services-manifest.ts";

export interface WellKnownService {
  url: string;
  version: string;
}

export type WellKnownDocument = Record<string, WellKnownService>;

export const WELL_KNOWN_DIR = join(CONFIG_DIR, "well-known");
export const WELL_KNOWN_PATH = join(WELL_KNOWN_DIR, "parachute.json");
export const WELL_KNOWN_MOUNT = "/.well-known/parachute.json";

/** Strip the conventional `parachute-` prefix for the well-known document's keys. */
export function shortName(manifestName: string): string {
  return manifestName.replace(/^parachute-/, "");
}

export interface BuildWellKnownOpts {
  services: readonly ServiceEntry[];
  canonicalOrigin: string;
}

export function buildWellKnown(opts: BuildWellKnownOpts): WellKnownDocument {
  const base = opts.canonicalOrigin.replace(/\/$/, "");
  const doc: WellKnownDocument = {};
  for (const s of opts.services) {
    const key = shortName(s.name);
    const path = s.paths[0] ?? "/";
    const url = new URL(path, `${base}/`).toString();
    doc[key] = { url, version: s.version };
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

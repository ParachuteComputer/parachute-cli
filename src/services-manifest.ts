import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SERVICES_MANIFEST_PATH } from "./config.ts";

export interface ServiceEntry {
  name: string;
  port: number;
  paths: string[];
  health: string;
  version: string;
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
  return { name, port, paths: paths as string[], health, version };
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

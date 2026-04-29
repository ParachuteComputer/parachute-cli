/**
 * Hub config portal logic (#46) — pure functions over the module manifest +
 * filesystem. Render-side and HTTP-side helpers live in `admin-config-ui.ts`
 * and `admin-handlers.ts`; this file is io + validation.
 *
 * Design choices:
 *
 *   - **JSON-only at v1.** The team-lead's brief covers .env / YAML / TOML
 *     follow-ups; this commit ships the JSON path so the surface is real
 *     for at least one module. Each configurable module's values land at
 *     `<configDir>/<name>/config.json` — the same per-module config dir
 *     auto-wire and lifecycle already use.
 *
 *   - **Skip modules without a `configSchema`.** A module that hasn't
 *     declared its operator-editable keys gets no card on the portal, no
 *     empty form. This is the explicit edge case from the brief.
 *
 *   - **Atomic writes.** Same `tmp + rename` shape as
 *     `services-manifest.ts` and `auto-wire.ts` — a crash mid-write must
 *     not leave a half-truncated config.json next to a running module.
 *
 *   - **Validation = coercion + check.** HTML form values arrive as
 *     strings; `validateAndCoerce` coerces each per its declared type
 *     (and the `enum` allow-list, when present), reports the first error
 *     per field, and returns the typed object on success. Booleans
 *     follow the standard form convention: present (any non-empty value)
 *     = true, absent = false. Required booleans are accepted as either
 *     state — required means "the key is in the schema", not "must be
 *     truthy".
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ConfigSchema,
  type ConfigSchemaProperty,
  type ModuleManifest,
  readModuleManifest,
} from "./module-manifest.ts";
import type { ServiceEntry, ServicesManifest } from "./services-manifest.ts";

export interface ConfigurableModule {
  /** Stable ecosystem name (services.json key, route segment). */
  name: string;
  /** Operator-facing label rendered in the portal. */
  displayName: string;
  /** One-line subtitle if the manifest provides one. */
  tagline?: string;
  /** The validated schema from `.parachute/module.json`. */
  schema: ConfigSchema;
  /** Absolute path to `<configDir>/<name>/config.json`. */
  configPath: string;
}

export interface DiscoverDeps {
  /** Resolves installed services (production: `services-manifest.readManifest`). */
  loadServicesManifest: () => ServicesManifest;
  /** `~/.parachute` (or `$PARACHUTE_HOME`) — per-module config lives at `<configDir>/<name>/config.json`. */
  configDir: string;
  /** Test seam — defaults to `module-manifest.readModuleManifest`. */
  readManifest?: (installDir: string) => Promise<ModuleManifest | null>;
}

export function configPathFor(configDir: string, moduleName: string): string {
  return join(configDir, moduleName, "config.json");
}

/**
 * Walk services.json, read each module's `.parachute/module.json` (when its
 * row carries an `installDir`), keep only those with a `configSchema`. The
 * result is sorted by `displayName` so the portal renders deterministically.
 */
export async function discoverConfigurableModules(
  deps: DiscoverDeps,
): Promise<ConfigurableModule[]> {
  const reader = deps.readManifest ?? readModuleManifest;
  const manifest = deps.loadServicesManifest();
  const out: ConfigurableModule[] = [];
  for (const svc of manifest.services) {
    const mod = await readModuleFor(svc, reader);
    if (!mod || !mod.configSchema) continue;
    const entry: ConfigurableModule = {
      name: svc.name,
      displayName: svc.displayName ?? mod.displayName ?? mod.manifestName ?? svc.name,
      schema: mod.configSchema,
      configPath: configPathFor(deps.configDir, svc.name),
    };
    if (svc.tagline ?? mod.tagline) entry.tagline = svc.tagline ?? mod.tagline;
    out.push(entry);
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return out;
}

async function readModuleFor(
  svc: ServiceEntry,
  reader: (installDir: string) => Promise<ModuleManifest | null>,
): Promise<ModuleManifest | null> {
  if (!svc.installDir) return null;
  try {
    return await reader(svc.installDir);
  } catch {
    // A malformed third-party manifest shouldn't take down the whole portal —
    // skip the module and let the operator see the others. Logging the
    // skip is the lifecycle layer's job; this stays pure.
    return null;
  }
}

/**
 * Read `<configDir>/<name>/config.json`. Returns `{}` for a missing file,
 * `{}` for a malformed file (with a `parseError` flag) — the portal renders
 * defaults for missing keys either way; surfacing parse failures in the UI
 * without erroring the page lets the operator overwrite a corrupted file.
 */
export interface ReadConfigResult {
  data: Record<string, unknown>;
  parseError?: string;
}

export function readModuleConfig(configPath: string): ReadConfigResult {
  if (!existsSync(configPath)) return { data: {} };
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    return { data: {}, parseError: err instanceof Error ? err.message : String(err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { data: {}, parseError: "config.json must contain a JSON object" };
    }
    return { data: parsed as Record<string, unknown> };
  } catch (err) {
    return { data: {}, parseError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Atomic write: tmp file + rename, mkdir -p first. Same pattern as
 * services-manifest. Trailing newline so the file plays nice with
 * line-oriented tooling (`wc -l`, diffs).
 */
export function writeModuleConfig(configPath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, configPath);
}

export interface ValidateConfigResult {
  ok: boolean;
  /** Field-level errors; empty when ok === true. */
  errors: Record<string, string>;
  /** Coerced typed values; populated only when ok === true. */
  data?: Record<string, unknown>;
}

/**
 * Coerce + validate a form-data submission against `schema`. `formValues`
 * is keyed by property name; checkbox semantics are encoded in the caller
 * (booleans missing → false). The first failure per field is reported;
 * once any field fails, `data` is omitted.
 */
export function validateAndCoerce(
  formValues: Record<string, string | boolean | undefined>,
  schema: ConfigSchema,
): ValidateConfigResult {
  const errors: Record<string, string> = {};
  const data: Record<string, unknown> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, prop] of Object.entries(schema.properties)) {
    const raw = formValues[key];
    const present = raw !== undefined && raw !== "";
    if (!present) {
      if (prop.type === "boolean") {
        // Booleans are always "present" — checkbox absence = false.
        data[key] = false;
        continue;
      }
      if (required.has(key)) {
        errors[key] = "required";
        continue;
      }
      // Missing optional field → omit from output rather than write a null.
      continue;
    }
    const coerced = coerceValue(raw, prop);
    if ("error" in coerced) {
      errors[key] = coerced.error;
      continue;
    }
    if (prop.enum && !prop.enum.includes(coerced.value as string | number)) {
      errors[key] = `must be one of: ${prop.enum.join(", ")}`;
      continue;
    }
    data[key] = coerced.value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, errors, data };
}

function coerceValue(
  raw: string | boolean,
  prop: ConfigSchemaProperty,
): { value: string | number | boolean } | { error: string } {
  switch (prop.type) {
    case "string":
      return { value: typeof raw === "string" ? raw : String(raw) };
    case "boolean":
      if (typeof raw === "boolean") return { value: raw };
      return { value: raw.length > 0 && raw !== "false" && raw !== "0" };
    case "number": {
      const s = typeof raw === "string" ? raw : String(raw);
      const n = Number(s);
      if (!Number.isFinite(n)) return { error: "must be a number" };
      return { value: n };
    }
    case "integer": {
      const s = typeof raw === "string" ? raw : String(raw);
      const n = Number(s);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: "must be an integer" };
      return { value: n };
    }
  }
}

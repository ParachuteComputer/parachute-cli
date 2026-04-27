/**
 * `.parachute/module.json` — the contract that makes a package a Parachute
 * module. Author-controlled, shipped in the published artifact, read by the
 * CLI on `parachute install <package>`.
 *
 * The shape mirrors `parachute-patterns/patterns/module-json-extensibility.md`.
 * Third-party modules are first-class: no `@openparachute/` scope or
 * `parachute-*` prefix required — `module.json` is what makes a package a
 * module. First-party modules will eventually ship their own `module.json`
 * and the vendored fallbacks in `service-spec.ts` go away one by one.
 *
 * Design note — what's NOT in this manifest:
 *   - `version`: that's the package's own `package.json` version, not a
 *     module-protocol versioning lever. If we ever break the manifest shape
 *     we'll add `manifestVersion: 1` (deferred until v2 is real).
 *   - imperative behaviors like `init` argv, post-install footers, dynamic
 *     startCmd that needs per-install entry data: those live in the
 *     first-party fallback's `extras` block in `service-spec.ts` because
 *     they don't fit a static schema.
 *   - runtime metadata: `displayName`, `tagline`, capabilities etc. that the
 *     hub renders are at `/.parachute/info` (runtime, can change without
 *     reinstall). The boundary: install-time → here; runtime → there.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

export type ModuleKind = "api" | "frontend" | "tool";

export interface ModuleScopeBlock {
  /** OAuth scopes this module owns. Namespaced by `name` per oauth-scopes.md. */
  readonly defines?: readonly string[];
}

export interface ModuleDependency {
  /** True = absent dependency is fine; false = install fails without it. */
  readonly optional?: boolean;
  /** Scopes this module wants on the dependency, for auto-wired tokens. */
  readonly scopes?: readonly string[];
}

export interface ModuleManifest {
  /** Stable ecosystem identifier — `[a-z][a-z0-9-]*`, also the services.json key. */
  readonly name: string;
  /** User-facing manifest name (often === name). */
  readonly manifestName: string;
  /** Human label rendered on the hub card. */
  readonly displayName?: string;
  /** One-line subtitle rendered under displayName. */
  readonly tagline?: string;
  /** Drives card vs. iframe vs. launcher in the hub. */
  readonly kind: ModuleKind;
  /** Default loopback port. CLI warns on conflict, doesn't block. */
  readonly port: number;
  /** URL paths the module serves under the hub origin. */
  readonly paths: readonly string[];
  /** Path for liveness probes — must start with `/`. */
  readonly health: string;
  /** Argv the CLI invokes for `parachute start <name>`. Resolved relative to
   *  the installed package; static (not entry-aware). */
  readonly startCmd?: readonly string[];
  /** OAuth scopes block — see oauth-scopes.md. */
  readonly scopes?: ModuleScopeBlock;
  /** Auto-wire targets — see service-to-service-auth.md. */
  readonly dependencies?: Record<string, ModuleDependency>;
}

export class ModuleManifestError extends Error {
  override name = "ModuleManifestError";
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

function asString(v: unknown, where: string, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ModuleManifestError(`${where}: "${field}" must be a non-empty string`);
  }
  return v;
}

function asOptionalString(v: unknown, where: string, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new ModuleManifestError(`${where}: "${field}" must be a string if present`);
  }
  return v;
}

function asKind(v: unknown, where: string): ModuleKind {
  if (v !== "api" && v !== "frontend" && v !== "tool") {
    throw new ModuleManifestError(`${where}: "kind" must be "api" | "frontend" | "tool"`);
  }
  return v;
}

function asPort(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > 65535) {
    throw new ModuleManifestError(`${where}: "port" must be an integer 1..65535`);
  }
  return v;
}

function asStringArray(v: unknown, where: string, field: string): readonly string[] {
  if (!Array.isArray(v) || v.some((p) => typeof p !== "string")) {
    throw new ModuleManifestError(`${where}: "${field}" must be an array of strings`);
  }
  return v as readonly string[];
}

function asHealthPath(v: unknown, where: string): string {
  const s = asString(v, where, "health");
  if (!s.startsWith("/")) {
    throw new ModuleManifestError(`${where}: "health" must start with "/"`);
  }
  return s;
}

function asScopes(v: unknown, where: string): ModuleScopeBlock | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object") {
    throw new ModuleManifestError(`${where}: "scopes" must be an object if present`);
  }
  const defines = (v as Record<string, unknown>).defines;
  if (defines === undefined) return {};
  return { defines: asStringArray(defines, where, "scopes.defines") };
}

function asDependencies(v: unknown, where: string): Record<string, ModuleDependency> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new ModuleManifestError(`${where}: "dependencies" must be an object if present`);
  }
  const out: Record<string, ModuleDependency> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      throw new ModuleManifestError(`${where}: "dependencies.${k}" must be an object`);
    }
    const dep = raw as Record<string, unknown>;
    const entry: ModuleDependency = {};
    if (dep.optional !== undefined) {
      if (typeof dep.optional !== "boolean") {
        throw new ModuleManifestError(`${where}: "dependencies.${k}.optional" must be boolean`);
      }
      (entry as { optional?: boolean }).optional = dep.optional;
    }
    if (dep.scopes !== undefined) {
      (entry as { scopes?: readonly string[] }).scopes = asStringArray(
        dep.scopes,
        where,
        `dependencies.${k}.scopes`,
      );
    }
    out[k] = entry;
  }
  return out;
}

/**
 * Strict validator. Throws `ModuleManifestError` with the source path so
 * malformed third-party modules get a clear-enough error to fix. Required
 * fields are name, manifestName, kind, port, paths, health.
 */
export function validateModuleManifest(raw: unknown, where: string): ModuleManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModuleManifestError(`${where}: root must be an object`);
  }
  const m = raw as Record<string, unknown>;

  const name = asString(m.name, where, "name");
  if (!NAME_RE.test(name)) {
    throw new ModuleManifestError(
      `${where}: "name" must match ${NAME_RE} (lowercase letters, digits, hyphens; lead with a letter)`,
    );
  }
  const manifestName = asString(m.manifestName, where, "manifestName");
  const kind = asKind(m.kind, where);
  const port = asPort(m.port, where);
  const paths = asStringArray(m.paths, where, "paths");
  const health = asHealthPath(m.health, where);
  const displayName = asOptionalString(m.displayName, where, "displayName");
  const tagline = asOptionalString(m.tagline, where, "tagline");

  let startCmd: readonly string[] | undefined;
  if (m.startCmd !== undefined) {
    startCmd = asStringArray(m.startCmd, where, "startCmd");
    if (startCmd.length === 0) {
      throw new ModuleManifestError(`${where}: "startCmd" must be non-empty if present`);
    }
  }

  const scopes = asScopes(m.scopes, where);
  // Scope-namespace rule: `name:foo` scopes must match the module's name. This
  // prevents a third party from declaring `vault:read` and squatting on a
  // namespace the user already trusts for a different module.
  if (scopes?.defines) {
    for (const s of scopes.defines) {
      const colon = s.indexOf(":");
      if (colon <= 0) {
        throw new ModuleManifestError(
          `${where}: scope "${s}" must be namespaced as "<name>:<verb>"`,
        );
      }
      const ns = s.slice(0, colon);
      if (ns !== name) {
        throw new ModuleManifestError(
          `${where}: scope "${s}" namespace "${ns}" does not match module name "${name}"`,
        );
      }
    }
  }

  const dependencies = asDependencies(m.dependencies, where);

  const out: ModuleManifest = { name, manifestName, kind, port, paths, health };
  if (displayName !== undefined) (out as { displayName?: string }).displayName = displayName;
  if (tagline !== undefined) (out as { tagline?: string }).tagline = tagline;
  if (startCmd !== undefined) (out as { startCmd?: readonly string[] }).startCmd = startCmd;
  if (scopes !== undefined) (out as { scopes?: ModuleScopeBlock }).scopes = scopes;
  if (dependencies !== undefined) {
    (out as { dependencies?: Record<string, ModuleDependency> }).dependencies = dependencies;
  }
  return out;
}

/**
 * Read `<packageDir>/.parachute/module.json`. Returns null if the file is
 * absent (caller decides whether that's an error — first-party modules fall
 * back to the vendored manifest; third-party hard-errors). Throws
 * `ModuleManifestError` on parse / validation failure.
 */
export async function readModuleManifest(packageDir: string): Promise<ModuleManifest | null> {
  const path = join(packageDir, ".parachute", "module.json");
  let buf: string;
  try {
    buf = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf);
  } catch (err) {
    throw new ModuleManifestError(
      `${path}: failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateModuleManifest(parsed, path);
}

/**
 * Read-only probe of vault's auth state, for the post-exposure preflight
 * nudge. We don't want to lock the DB or mutate anything — this is a
 * one-shot "should we warn the user their vault is wide open on the public
 * internet?" check.
 *
 * Two sources:
 *   1. ~/.parachute/vault/config.yaml   → owner_password_hash + totp_secret
 *   2. ~/.parachute/vault/data/<name>/vault.db (SQLite) → tokens table count
 *
 * The YAML path uses line-anchored regex parsing that matches vault's own
 * `readGlobalConfig()` semantics (parachute-vault src/config.ts): keys are
 * optional, quoted scalars, and empty-string / missing-key both mean "not
 * configured." We mirror that rather than bringing in a YAML dependency.
 *
 * The SQLite path is best-effort: if the DB is missing, locked (vault is
 * writing), or the schema has drifted, `tokenCount` comes back as `null`
 * and the caller surfaces "token status unknown" rather than lying with a
 * false zero. The exposure flow has already succeeded by the time this
 * runs — a probe failure must never block the user's happy path.
 *
 * Schema coupling note: we read the `tokens` table by name with a bare
 * COUNT(*). If vault ever renames that table, that's a breaking change on
 * vault's side and this probe is the least of the fallout. Post-launch,
 * a public `/api/auth/status` endpoint on vault (tracked separately) would
 * let us drop this coupling entirely.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "../config.ts";

export interface VaultAuthStatus {
  hasOwnerPassword: boolean;
  hasTotp: boolean;
  /**
   * `null` means we couldn't read the SQLite DB — distinct from "0 tokens
   * exist." Callers branch the UI on this: `null` → "token status unknown,
   * run `parachute vault tokens list` to check"; `0` → loud "no auth at
   * all!" warning; `>0` → benign.
   */
  tokenCount: number | null;
  /** Vault instance names discovered under data/. Empty when vault has
   *  never been initialized (or the data dir is absent). */
  vaultNames: string[];
}

export interface AuthStatusOpts {
  /** Override `~/.parachute/vault` for tests. */
  vaultHome?: string;
  /** Read a YAML file; defaults to `readFileSync(path, "utf8")`. Missing
   *  file should return `undefined` (not throw) so callers can distinguish
   *  "no password configured" from "IO error." */
  readText?: (path: string) => string | undefined;
  /** List vault instance names. Defaults to `readdirSync(dataDir)` filtered
   *  to entries that look like vaults (contain `vault.yaml`). */
  listVaultNames?: (dataDir: string) => string[];
  /** Open the given DB path and return `SELECT COUNT(*) FROM tokens`. Any
   *  thrown error (missing, locked, schema drift) is caught by the caller
   *  and mapped to `tokenCount: null`. */
  countTokens?: (dbPath: string) => number;
}

interface Resolved {
  vaultHome: string;
  readText: (path: string) => string | undefined;
  listVaultNames: (dataDir: string) => string[];
  countTokens: (dbPath: string) => number;
}

function defaultVaultHome(): string {
  // Mirrors vault's own resolution: honors $PARACHUTE_HOME via configDir(),
  // then falls back to ~/.parachute. The `vault/` subdir is hard-coded on
  // vault's side too (src/config.ts `vaultHomePath()`), so we match literally.
  const root = configDir();
  return root.length > 0 ? join(root, "vault") : join(homedir(), ".parachute", "vault");
}

function defaultReadText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function defaultListVaultNames(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  try {
    return readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => existsSync(join(dataDir, name, "vault.yaml")));
  } catch {
    return [];
  }
}

function defaultCountTokens(dbPath: string): number {
  // Imported lazily so the module stays loadable in environments that stub
  // `bun:sqlite` (our own tests inject a fake `countTokens` and never hit
  // this path). `readonly: true` keeps us out of any write lock contention
  // with a live vault process.
  const { Database } = require("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM tokens").get() as { n: number } | null;
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

function resolve(opts: AuthStatusOpts): Resolved {
  return {
    vaultHome: opts.vaultHome ?? defaultVaultHome(),
    readText: opts.readText ?? defaultReadText,
    listVaultNames: opts.listVaultNames ?? defaultListVaultNames,
    countTokens: opts.countTokens ?? defaultCountTokens,
  };
}

/**
 * Mirrors vault's `readGlobalConfig()` regex on a single key, returning the
 * captured quoted string when present and non-empty, otherwise `undefined`.
 */
function matchQuotedKey(yaml: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*"([^"]*)"`, "m");
  const m = yaml.match(re);
  if (!m) return undefined;
  const captured = m[1];
  if (captured === undefined || captured.length === 0) return undefined;
  return captured;
}

function readGlobalAuth(r: Resolved): { hasOwnerPassword: boolean; hasTotp: boolean } {
  const yaml = r.readText(join(r.vaultHome, "config.yaml"));
  if (yaml === undefined) return { hasOwnerPassword: false, hasTotp: false };
  return {
    hasOwnerPassword: matchQuotedKey(yaml, "owner_password_hash") !== undefined,
    hasTotp: matchQuotedKey(yaml, "totp_secret") !== undefined,
  };
}

/**
 * Sum token counts across every vault instance found under data/. If any
 * probe throws (missing DB, locked, schema drift), the whole result
 * degrades to `null` — partial counts would mislead the caller more than
 * "unknown" does.
 */
function readTotalTokenCount(r: Resolved, vaultNames: string[]): number | null {
  if (vaultNames.length === 0) return 0;
  const dataDir = join(r.vaultHome, "data");
  let total = 0;
  for (const name of vaultNames) {
    const dbPath = join(dataDir, name, "vault.db");
    if (!existsSync(dbPath)) {
      // Vault initialized the yaml but hasn't created the DB yet (fresh
      // install). Count as zero for this vault; keep going.
      continue;
    }
    try {
      total += r.countTokens(dbPath);
    } catch {
      return null;
    }
  }
  return total;
}

export function readVaultAuthStatus(opts: AuthStatusOpts = {}): VaultAuthStatus {
  const r = resolve(opts);
  const { hasOwnerPassword, hasTotp } = readGlobalAuth(r);
  const dataDir = join(r.vaultHome, "data");
  const vaultNames = r.listVaultNames(dataDir);
  const tokenCount = readTotalTokenCount(r, vaultNames);
  return { hasOwnerPassword, hasTotp, tokenCount, vaultNames };
}

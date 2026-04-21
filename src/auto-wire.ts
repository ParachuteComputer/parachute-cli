import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Cross-service auto-wiring for shared secrets.
 *
 * Vault's transcription worker authenticates to scribe over loopback using a
 * shared bearer token. On install, when both services are present, we mint
 * one and write it to both sides so the operator never has to. Missing either
 * service → no-op; token already present in vault's .env → preserved.
 *
 * Storage locations (convention, matches what each service reads at boot):
 *   ~/.parachute/vault/.env        SCRIBE_AUTH_TOKEN=<value>
 *   ~/.parachute/scribe/config.json  { "auth": { "required_token": "<value>" } }
 *
 * Idempotency rule: we don't regenerate if vault's .env already carries the
 * var. This preserves operator-set overrides and keeps repeat installs from
 * churning the token (which would break an already-running vault worker).
 */

export const SCRIBE_AUTH_ENV_KEY = "SCRIBE_AUTH_TOKEN";

export interface AutoWireOpts {
  configDir: string;
  /** Override for tests; must return a hex string of any reasonable length. */
  randomToken?: () => string;
  log?: (line: string) => void;
  /**
   * Guard: if either service isn't installed, skip silently. The install
   * command owns this check (it reads services.json); the helper itself
   * trusts the caller and just writes.
   */
}

export interface AutoWireResult {
  /** True when a token was written this call (vs. preserved from a prior wire). */
  generated: boolean;
  /** The token value, whether newly minted or pre-existing. */
  token: string;
  vaultEnvPath: string;
  scribeConfigPath: string;
}

function defaultRandomToken(): string {
  // 32 bytes = 256 bits, hex-encoded. Matches the brief; width plenty for an
  // HMAC-grade shared secret without pulling in base64url concerns.
  return randomBytes(32).toString("hex");
}

function readVaultEnv(path: string): { lines: string[]; existingToken: string | undefined } {
  if (!existsSync(path)) return { lines: [], existingToken: undefined };
  const content = readFileSync(path, "utf8");
  const lines = content.length === 0 ? [] : content.split("\n");
  // Drop a trailing empty string from a file that ends in "\n" so we don't
  // double up newlines when we round-trip.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let existing: string | undefined;
  for (const line of lines) {
    if (line.startsWith(`${SCRIBE_AUTH_ENV_KEY}=`)) {
      existing = line.slice(SCRIBE_AUTH_ENV_KEY.length + 1);
      // Strip surrounding quotes if present — common .env style.
      if (
        existing.length >= 2 &&
        ((existing.startsWith('"') && existing.endsWith('"')) ||
          (existing.startsWith("'") && existing.endsWith("'")))
      ) {
        existing = existing.slice(1, -1);
      }
      break;
    }
  }
  return { lines, existingToken: existing };
}

function writeVaultEnv(path: string, lines: string[], token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const rendered = [...lines, `${SCRIBE_AUTH_ENV_KEY}=${token}`].join("\n");
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${rendered}\n`);
  renameSync(tmp, path);
}

function writeScribeConfig(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed config — overwrite. Auto-wire owns this file's auth block;
      // repairing a user-broken JSON is not our job.
    }
  }
  const existingAuth =
    typeof current.auth === "object" && current.auth !== null && !Array.isArray(current.auth)
      ? (current.auth as Record<string, unknown>)
      : {};
  const next = {
    ...current,
    auth: { ...existingAuth, required_token: token },
  };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Mint (or preserve) a shared secret and persist it to vault and scribe.
 * Caller has already confirmed both services are installed.
 */
export function autoWireScribeAuth(opts: AutoWireOpts): AutoWireResult {
  const random = opts.randomToken ?? defaultRandomToken;
  const log = opts.log ?? (() => {});
  const vaultEnvPath = join(opts.configDir, "vault", ".env");
  const scribeConfigPath = join(opts.configDir, "scribe", "config.json");

  const { lines, existingToken } = readVaultEnv(vaultEnvPath);
  if (existingToken !== undefined && existingToken.length > 0) {
    // Preserve whatever is already there — operator-set or previously wired.
    // Still re-assert scribe's copy in case the two drifted.
    writeScribeConfig(scribeConfigPath, existingToken);
    log(`${SCRIBE_AUTH_ENV_KEY} already set in vault .env — preserved. Synced scribe config.json.`);
    return { generated: false, token: existingToken, vaultEnvPath, scribeConfigPath };
  }

  const token = random();
  writeVaultEnv(vaultEnvPath, lines, token);
  writeScribeConfig(scribeConfigPath, token);
  log(
    `Auto-wired shared secret for vault → scribe transcription. Stored in ${vaultEnvPath} and ${scribeConfigPath}.`,
  );
  return { generated: true, token, vaultEnvPath, scribeConfigPath };
}

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { restart as lifecycleRestart } from "./commands/lifecycle.ts";
import { type AliveFn, defaultAlive, processState } from "./process-state.ts";
import { PORT_RESERVATIONS } from "./service-spec.ts";

/**
 * Cross-service auto-wiring for shared secrets.
 *
 * Vault's transcription worker authenticates to scribe over loopback using a
 * shared bearer token, and reaches scribe at SCRIBE_URL. On install, when both
 * services are present, we mint the secret and pin the URL on vault's side so
 * the operator never has to. Missing either service → no-op; values already
 * present in vault's .env → preserved.
 *
 * Storage locations (convention, matches what each service reads at boot):
 *   ~/.parachute/vault/.env        SCRIBE_AUTH_TOKEN=<value>
 *                                  SCRIBE_URL=http://127.0.0.1:1943
 *   ~/.parachute/scribe/config.json  { "auth": { "required_token": "<value>" } }
 *
 * Idempotency rule: we don't regenerate the token if vault's .env already
 * carries it, and we don't overwrite SCRIBE_URL if already set. This preserves
 * operator-set overrides and keeps repeat installs from churning state in a
 * way that would break an already-running vault worker.
 *
 * After writing, if vault is running, restart it so the worker re-reads the
 * .env. Without the restart vault keeps the old (or empty) values in process
 * env and voice memos sit with `_Transcript pending._` forever — exactly the
 * launch-day footgun this auto-wire exists to prevent.
 */

export const SCRIBE_AUTH_ENV_KEY = "SCRIBE_AUTH_TOKEN";
export const SCRIBE_URL_ENV_KEY = "SCRIBE_URL";

export interface AutoWireOpts {
  configDir: string;
  /** Override for tests; must return a hex string of any reasonable length. */
  randomToken?: () => string;
  log?: (line: string) => void;
  /** Test seam: liveness check used to decide whether to restart vault. */
  alive?: AliveFn;
  /**
   * Test seam: restart hook for vault. Defaults to `lifecycle.restart("vault")`.
   * Tests inject a fake to assert the call without spawning a real child.
   */
  restartService?: (short: string) => Promise<number>;
}

export interface AutoWireResult {
  /** True when a token was written this call (vs. preserved from a prior wire). */
  generated: boolean;
  /** The token value, whether newly minted or pre-existing. */
  token: string;
  /** The SCRIBE_URL value present in vault .env after this call. */
  scribeUrl: string;
  vaultEnvPath: string;
  scribeConfigPath: string;
  /** True when vault was running and we issued a restart. */
  restartedVault: boolean;
}

function defaultRandomToken(): string {
  return randomBytes(32).toString("hex");
}

function defaultScribeUrl(): string {
  // Pull scribe's canonical port from the single source of truth so a future
  // port change doesn't drift between auto-wire and the rest of the CLI.
  const port = PORT_RESERVATIONS.find((p) => p.name === "parachute-scribe")?.port ?? 1943;
  return `http://127.0.0.1:${port}`;
}

interface ParsedEnv {
  lines: string[];
  values: Record<string, string>;
}

function parseEnvLines(content: string): ParsedEnv {
  const raw = content.length === 0 ? [] : content.split("\n");
  // Drop a trailing empty string from a file that ends in "\n" so we don't
  // double up newlines when we round-trip.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const values: Record<string, string> = {};
  for (const line of raw) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return { lines: raw, values };
}

function readVaultEnv(path: string): ParsedEnv {
  if (!existsSync(path)) return { lines: [], values: {} };
  return parseEnvLines(readFileSync(path, "utf8"));
}

function upsertEnvLine(lines: string[], key: string, value: string): string[] {
  const next = [...lines];
  const prefix = `${key}=`;
  const idx = next.findIndex((line) => line.startsWith(prefix));
  if (idx >= 0) {
    next[idx] = `${key}=${value}`;
  } else {
    next.push(`${key}=${value}`);
  }
  return next;
}

function writeVaultEnv(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${lines.join("\n")}\n`);
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
 * Mint (or preserve) a shared secret and persist it to vault and scribe, plus
 * pin SCRIBE_URL on vault's side. Caller has already confirmed both services
 * are installed. Restarts vault if it's running so the worker re-reads .env.
 */
export async function autoWireScribeAuth(opts: AutoWireOpts): Promise<AutoWireResult> {
  const random = opts.randomToken ?? defaultRandomToken;
  const log = opts.log ?? (() => {});
  const alive = opts.alive ?? defaultAlive;
  const restartService =
    opts.restartService ??
    ((short: string) =>
      lifecycleRestart(short, {
        configDir: opts.configDir,
        log,
      }));

  const vaultEnvPath = join(opts.configDir, "vault", ".env");
  const scribeConfigPath = join(opts.configDir, "scribe", "config.json");

  const parsed = readVaultEnv(vaultEnvPath);
  let lines = parsed.lines;
  let didWriteEnv = false;

  const existingToken = parsed.values[SCRIBE_AUTH_ENV_KEY];
  const tokenAlreadySet = existingToken !== undefined && existingToken.length > 0;
  const token = tokenAlreadySet ? existingToken : random();
  if (!tokenAlreadySet) {
    lines = upsertEnvLine(lines, SCRIBE_AUTH_ENV_KEY, token);
    didWriteEnv = true;
  }

  const existingUrl = parsed.values[SCRIBE_URL_ENV_KEY];
  const urlAlreadySet = existingUrl !== undefined && existingUrl.length > 0;
  const scribeUrl = urlAlreadySet ? existingUrl : defaultScribeUrl();
  if (!urlAlreadySet) {
    lines = upsertEnvLine(lines, SCRIBE_URL_ENV_KEY, scribeUrl);
    didWriteEnv = true;
  }

  if (didWriteEnv) writeVaultEnv(vaultEnvPath, lines);
  writeScribeConfig(scribeConfigPath, token);

  if (tokenAlreadySet && urlAlreadySet) {
    log(
      `${SCRIBE_AUTH_ENV_KEY} and ${SCRIBE_URL_ENV_KEY} already set in vault .env — preserved. Synced scribe config.json.`,
    );
  } else if (tokenAlreadySet) {
    log(
      `${SCRIBE_AUTH_ENV_KEY} already set in vault .env — preserved. Wired ${SCRIBE_URL_ENV_KEY}=${scribeUrl}. Synced scribe config.json.`,
    );
  } else {
    log(
      `Auto-wired shared secret + ${SCRIBE_URL_ENV_KEY} for vault → scribe transcription. Stored in ${vaultEnvPath} and ${scribeConfigPath}.`,
    );
  }

  // Vault caches .env on process start; without a restart the worker keeps
  // running with stale (or absent) SCRIBE_URL/SCRIBE_AUTH_TOKEN and voice
  // memos never transcribe. Mirrors the auto-restart-on-expose pattern from
  // PR #39 — skip silently if vault isn't running.
  let restartedVault = false;
  if (didWriteEnv && processState("vault", opts.configDir, alive).status === "running") {
    log("Restarting vault to pick up new transcription wiring…");
    const code = await restartService("vault");
    if (code === 0) {
      restartedVault = true;
    } else {
      log(
        "⚠ vault restart failed. Run manually once the issue is resolved: parachute restart vault",
      );
    }
  }

  return {
    generated: !tokenAlreadySet,
    token,
    scribeUrl,
    vaultEnvPath,
    scribeConfigPath,
    restartedVault,
  };
}

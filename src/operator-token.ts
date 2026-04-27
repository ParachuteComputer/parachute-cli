/**
 * Operator token — long-lived hub-issued JWT that local CLI tools use to
 * authenticate against on-box services (vault / scribe / channel) without
 * running an interactive OAuth dance every time.
 *
 * Why this exists: modules require auth on every request — there is no
 * "loopback is trusted" bypass, because browser extensions and compromised
 * postinstalls can hit 127.0.0.1 too. The operator token is the on-box
 * caller's bearer credential; it lives in `~/.parachute/operator.token`
 * with mode 0600 so a different unix user can't read it.
 *
 * Browser apps follow the OAuth flow and never touch this file. Service
 * accounts (cron jobs, oncall scripts) read it; that's the whole point.
 *
 * Rotation: cheap. `parachute auth rotate-operator` mints a fresh token
 * and overwrites the file. The previous token is *not* revoked at the
 * issuer — the hub doesn't track operator-token jtis — so a leaked file
 * stays valid until its 1-year TTL elapses. Treat operator.token like an
 * SSH private key.
 */
import type { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.ts";
import { signAccessToken } from "./jwt-sign.ts";

export const OPERATOR_TOKEN_FILENAME = "operator.token";
export const OPERATOR_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
export const OPERATOR_TOKEN_AUDIENCE = "operator";
export const OPERATOR_TOKEN_CLIENT_ID = "parachute-hub";
export const OPERATOR_TOKEN_SCOPES = ["hub:admin", "vault:admin", "scribe:admin", "channel:send"];

export function operatorTokenPath(dir: string = configDir()): string {
  return join(dir, OPERATOR_TOKEN_FILENAME);
}

export interface MintOperatorTokenOpts {
  /** Override the JWT-sign clock — tests pin time. */
  now?: () => Date;
  /** Override the random jti — tests pin it. */
  jti?: string;
  /** Override the audience claim. Defaults to "operator". */
  audience?: string;
}

export async function mintOperatorToken(
  db: Database,
  userId: string,
  opts: MintOperatorTokenOpts = {},
): Promise<{ token: string; jti: string; expiresAt: string }> {
  return signAccessToken(db, {
    sub: userId,
    scopes: OPERATOR_TOKEN_SCOPES,
    audience: opts.audience ?? OPERATOR_TOKEN_AUDIENCE,
    clientId: OPERATOR_TOKEN_CLIENT_ID,
    ttlSeconds: OPERATOR_TOKEN_TTL_SECONDS,
    ...(opts.jti !== undefined ? { jti: opts.jti } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

/**
 * Atomically writes the token to `<dir>/operator.token` with mode 0600.
 * Atomic = write to `<path>.tmp` then rename, so a half-written file never
 * exists at the canonical path.
 */
export async function writeOperatorTokenFile(
  token: string,
  dir: string = configDir(),
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const path = operatorTokenPath(dir);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, `${token}\n`, { mode: 0o600 });
  await fs.rename(tmp, path);
  return path;
}

/**
 * Reads the operator token file, trims trailing whitespace. Returns null
 * if the file doesn't exist (caller decides whether that's an error). Any
 * other read error propagates.
 */
export async function readOperatorTokenFile(dir: string = configDir()): Promise<string | null> {
  const path = operatorTokenPath(dir);
  try {
    const buf = await fs.readFile(path, "utf8");
    const trimmed = buf.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface IssueOperatorTokenResult {
  token: string;
  jti: string;
  expiresAt: string;
  path: string;
}

/**
 * Mint + write in one call. Used by `parachute auth set-password` (after
 * password set) and `parachute auth rotate-operator`.
 */
export async function issueOperatorToken(
  db: Database,
  userId: string,
  opts: MintOperatorTokenOpts & { dir?: string } = {},
): Promise<IssueOperatorTokenResult> {
  const minted = await mintOperatorToken(db, userId, opts);
  const path = await writeOperatorTokenFile(minted.token, opts.dir);
  return { ...minted, path };
}

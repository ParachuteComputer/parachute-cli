/**
 * JWT issuance + verification for hub-issued access tokens, plus opaque
 * refresh-token minting that records hashes in the `tokens` table.
 *
 * Three pieces, deliberately separable:
 *   - `signAccessToken(db, opts)` — pure JWT signing. Looks up the active
 *     signing key from `signing_keys`, signs an RS256 JWT, returns the
 *     compact serialization plus jti + computed expiry. Does NOT write to
 *     `tokens` — the caller chooses whether to persist (PR (c) will).
 *   - `signRefreshToken(db, opts)` — generates an opaque hex token,
 *     SHA-256-hashes it, and inserts a `tokens` row. Returns the plaintext
 *     to hand to the client; the hash is what we'll compare on refresh.
 *   - `validateAccessToken(db, token)` — verifies the JWT signature against
 *     active + recently-retired keys (whatever's currently in JWKS), checks
 *     expiry. Read-only.
 *
 * Sliding refresh: PR (c) will rotate the row on a successful refresh; this
 * PR just sets up the storage shape. 30-day expiry is the *initial* TTL.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  type JWTPayload,
  SignJWT,
  decodeProtectedHeader,
  importPKCS8,
  importSPKI,
  jwtVerify,
} from "jose";
import { getActiveSigningKey, getAllPublicKeys } from "./signing-keys.ts";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SIGNING_ALGORITHM = "RS256";

export interface SignAccessTokenOpts {
  /** Subject — the user id. */
  sub: string;
  scopes: string[];
  /** Module short name (vault, notes, …) or "hub" — sets `aud`. */
  audience: string;
  clientId: string;
  /** Override the jti (defaults to random base64url(16)). Used by tests. */
  jti?: string;
  /**
   * Override the default 15-minute access-token TTL. Long-lived tokens
   * (operator-token, ~1y) pass an explicit value here.
   */
  ttlSeconds?: number;
  now?: () => Date;
}

export interface SignedAccessToken {
  token: string;
  jti: string;
  expiresAt: string;
}

export async function signAccessToken(
  db: Database,
  opts: SignAccessTokenOpts,
): Promise<SignedAccessToken> {
  const key = getActiveSigningKey(db);
  const priv = await importPKCS8(key.privateKeyPem, SIGNING_ALGORITHM);
  const jti = opts.jti ?? randomBytes(16).toString("base64url");
  const nowMs = (opts.now?.() ?? new Date()).getTime();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + (opts.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS);
  const token = await new SignJWT({
    scope: opts.scopes.join(" "),
    client_id: opts.clientId,
  })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: key.kid })
    .setSubject(opts.sub)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setAudience(opts.audience)
    .setJti(jti)
    .sign(priv);
  return { token, jti, expiresAt: new Date(exp * 1000).toISOString() };
}

export interface SignRefreshTokenOpts {
  /** Shared with the access token's jti — keys the `tokens` row. */
  jti: string;
  userId: string;
  clientId: string;
  scopes: string[];
  now?: () => Date;
}

export interface SignedRefreshToken {
  /** Opaque token to return to the client. NOT recoverable from the DB. */
  token: string;
  /** SHA-256 hex digest of `token`, stored in `tokens.refresh_token_hash`. */
  refreshTokenHash: string;
  expiresAt: string;
}

export function signRefreshToken(db: Database, opts: SignRefreshTokenOpts): SignedRefreshToken {
  const token = randomBytes(32).toString("base64url");
  const refreshTokenHash = createHash("sha256").update(token).digest("hex");
  const now = opts.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO tokens (jti, user_id, client_id, scopes, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.jti,
    opts.userId,
    opts.clientId,
    opts.scopes.join(" "),
    refreshTokenHash,
    expiresAt,
    now.toISOString(),
  );
  return { token, refreshTokenHash, expiresAt };
}

export interface ValidatedAccessToken {
  payload: JWTPayload;
  kid: string;
}

/**
 * Verifies a JWT against the kid declared in its protected header, looking
 * up the matching key from `signing_keys`. Active + recently-retired keys
 * (whatever's in JWKS) are accepted; older retired keys throw. Expiry is
 * checked by `jose` automatically.
 */
export async function validateAccessToken(
  db: Database,
  token: string,
): Promise<ValidatedAccessToken> {
  const header = decodeProtectedHeader(token);
  const kid = header.kid;
  if (!kid) throw new Error("validateAccessToken: token missing kid header");
  const match = getAllPublicKeys(db).find((k) => k.kid === kid);
  if (!match) throw new Error(`validateAccessToken: unknown or expired kid ${kid}`);
  const pub = await importSPKI(match.publicKeyPem, SIGNING_ALGORITHM);
  const { payload } = await jwtVerify(token, pub);
  return { payload, kid };
}

/**
 * Convenience for the `tokens` row matching a presented refresh token. Hash
 * the plaintext, look up by hash, return the row if it exists and isn't
 * expired/revoked. PR (c) will use this in the refresh-token grant handler.
 */
export interface RefreshTokenRow {
  jti: string;
  userId: string;
  clientId: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export function findRefreshToken(db: Database, plaintext: string): RefreshTokenRow | null {
  const refreshTokenHash = createHash("sha256").update(plaintext).digest("hex");
  const row = db
    .query<
      {
        jti: string;
        user_id: string;
        client_id: string;
        scopes: string;
        expires_at: string;
        revoked_at: string | null;
        created_at: string;
      },
      [string]
    >("SELECT * FROM tokens WHERE refresh_token_hash = ? LIMIT 1")
    .get(refreshTokenHash);
  if (!row) return null;
  return {
    jti: row.jti,
    userId: row.user_id,
    clientId: row.client_id,
    scopes: row.scopes.split(" ").filter((s) => s.length > 0),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

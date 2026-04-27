/**
 * OAuth client registry. Backs the `/oauth/register` endpoint (RFC 7591
 * Dynamic Client Registration) and the client-lookup side of
 * `/oauth/authorize` and `/oauth/token`.
 *
 * Two flavors:
 *   - **Public clients** (PKCE-only): no `client_secret`. Browser-side apps
 *     register themselves with one or more `redirect_uris` and rely on PKCE
 *     for the auth-code exchange. `client_secret_hash` is NULL for these.
 *   - **Confidential clients**: server-side apps. We mint a random
 *     `client_secret` on registration, store its sha256 hash, return the
 *     plaintext exactly once. PR (c) doesn't yet enforce client_secret on
 *     the token endpoint — that's a follow-up; for now confidential clients
 *     work the same as public ones plus an opaque secret they can present.
 *
 * Self-registration is open. The brief defers consent gating (admin-approve
 * for new clients) to a later PR; today, any client_id seen for the first
 * time gets a row.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface OAuthClient {
  clientId: string;
  /** SHA-256 hex digest of the client secret. Null for public clients. */
  clientSecretHash: string | null;
  redirectUris: string[];
  scopes: string[];
  clientName: string | null;
  registeredAt: string;
}

export class ClientNotFoundError extends Error {
  constructor(clientId: string) {
    super(`oauth client "${clientId}" is not registered`);
    this.name = "ClientNotFoundError";
  }
}

export class InvalidRedirectUriError extends Error {
  constructor(uri: string) {
    super(`redirect_uri "${uri}" is not registered for this client`);
    this.name = "InvalidRedirectUriError";
  }
}

interface Row {
  client_id: string;
  client_secret_hash: string | null;
  redirect_uris: string;
  scopes: string;
  client_name: string | null;
  registered_at: string;
}

function rowToClient(r: Row): OAuthClient {
  return {
    clientId: r.client_id,
    clientSecretHash: r.client_secret_hash,
    redirectUris: JSON.parse(r.redirect_uris) as string[],
    scopes: r.scopes.split(" ").filter((s) => s.length > 0),
    clientName: r.client_name,
    registeredAt: r.registered_at,
  };
}

export interface RegisterClientOpts {
  redirectUris: string[];
  scopes?: string[];
  clientName?: string;
  /** Defaults to public (PKCE-only). Set to true for a server-side client. */
  confidential?: boolean;
  /** Override the generated client_id. Mostly for tests + first-party seeds. */
  clientId?: string;
  now?: () => Date;
}

export interface RegisteredClient {
  client: OAuthClient;
  /** Plaintext secret for confidential clients. NOT recoverable from the DB. */
  clientSecret: string | null;
}

export function registerClient(db: Database, opts: RegisterClientOpts): RegisteredClient {
  if (opts.redirectUris.length === 0) {
    throw new Error("registerClient: at least one redirect_uri is required");
  }
  for (const uri of opts.redirectUris) {
    if (!isValidRedirectUri(uri)) {
      throw new Error(`registerClient: invalid redirect_uri "${uri}"`);
    }
  }
  const clientId = opts.clientId ?? randomUUID();
  const clientSecret = opts.confidential ? randomBytes(32).toString("base64url") : null;
  const clientSecretHash = clientSecret
    ? createHash("sha256").update(clientSecret).digest("hex")
    : null;
  const registeredAt = (opts.now?.() ?? new Date()).toISOString();
  const scopes = (opts.scopes ?? []).join(" ");
  db.prepare(
    `INSERT INTO clients
     (client_id, client_secret_hash, redirect_uris, scopes, client_name, registered_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    clientId,
    clientSecretHash,
    JSON.stringify(opts.redirectUris),
    scopes,
    opts.clientName ?? null,
    registeredAt,
  );
  return {
    client: {
      clientId,
      clientSecretHash,
      redirectUris: opts.redirectUris,
      scopes: opts.scopes ?? [],
      clientName: opts.clientName ?? null,
      registeredAt,
    },
    clientSecret,
  };
}

export function getClient(db: Database, clientId: string): OAuthClient | null {
  const row = db.query<Row, [string]>("SELECT * FROM clients WHERE client_id = ?").get(clientId);
  return row ? rowToClient(row) : null;
}

/**
 * Returns the registered redirect URI matching `candidate` exactly, or throws.
 * RFC 8252 + 6749 require exact-match for redirect URIs (no wildcards, no
 * loose comparison) — anything looser is an open-redirect waiting to happen.
 */
export function requireRegisteredRedirectUri(client: OAuthClient, candidate: string): string {
  if (!client.redirectUris.includes(candidate)) {
    throw new InvalidRedirectUriError(candidate);
  }
  return candidate;
}

export function verifyClientSecret(client: OAuthClient, presented: string): boolean {
  if (!client.clientSecretHash) return false;
  const presentedHash = createHash("sha256").update(presented).digest("hex");
  return timingSafeEqualHex(client.clientSecretHash, presentedHash);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Light validation — refuses obviously-wrong shapes (relative paths, javascript:
 * URIs). Doesn't try to match a registered URI; that's `requireRegisteredRedirectUri`.
 */
export function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "javascript:" || u.protocol === "data:") return false;
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

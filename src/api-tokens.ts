/**
 * `GET /api/auth/tokens` — paginated list of the hub's `tokens` registry,
 * for the future admin UI's token-management view (Phase 2 of hub#212).
 *
 * Same auth shape as the rest of `/api/auth/*`: bearer-gated on
 * `parachute:host:auth`. The list is intentionally rich — every column
 * the registry holds is surfaced, since the consumer (admin UI) needs
 * status pills, sort, filter, and per-row revoke actions, all of which
 * key off these fields.
 *
 * Wire shape:
 *
 *   GET /api/auth/tokens?revoked=true|false|all&subject=...&cursor=...
 *   →
 *   {
 *     "tokens": [
 *       {
 *         "jti": "...",
 *         "user_id": "..." | null,
 *         "subject": "..." | null,
 *         "client_id": "...",
 *         "scopes": [...],
 *         "expires_at": "ISO-8601",
 *         "revoked_at": "ISO-8601" | null,
 *         "created_at": "ISO-8601",
 *         "created_via": "oauth_refresh" | "cli_mint" | "operator_mint",
 *         "permissions": "<json-string>" | null
 *       }
 *     ],
 *     "next_cursor": "<opaque>" | null
 *   }
 *
 * Pagination is opaque cursor (newest-first; cursor encodes the previous
 * page's last `(created_at, jti)` composite). Default page size 50,
 * cap 200 — see `listTokens` in `jwt-sign.ts`.
 *
 * Filter semantics:
 *   - `revoked=true`  — only revoked rows.
 *   - `revoked=false` — only un-revoked rows.
 *   - `revoked=all` (or omitted) — all rows.
 *   - `subject=<value>` — exact match against either `user_id` (OAuth
 *     rows) or `subject` (CLI / operator / service mint rows). The
 *     consumer doesn't need to know which column to query; the helper
 *     handles both.
 *
 * Why bearer-gated rather than session-cookie-gated: matches the rest
 * of `/api/auth/*` (mint-token, revoke-token), so an automation client
 * holding a `parachute:host:auth` bearer can read the registry without
 * juggling browser session state. The admin UI mints its bearer via
 * the same `getHostAdminToken()` helper that powers the existing
 * `/vaults` and `/api/grants` calls.
 */
import type { Database } from "bun:sqlite";
import { listTokens, validateAccessToken } from "./jwt-sign.ts";

/** Scope required on the bearer token to call this endpoint. */
export const API_TOKENS_REQUIRED_SCOPE = "parachute:host:auth";

export interface ApiTokensDeps {
  db: Database;
  /** Hub origin — used to validate the bearer's `iss`. */
  issuer: string;
}

interface TokenWireShape {
  jti: string;
  user_id: string | null;
  subject: string | null;
  client_id: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  created_via: string;
  permissions: string | null;
}

interface TokensListResponse {
  tokens: TokenWireShape[];
  next_cursor: string | null;
}

export async function handleApiTokens(req: Request, deps: ApiTokensDeps): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }

  // 1. Bearer presence + parsing.
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError(401, "unauthenticated", "Authorization: Bearer <token> required");
  }
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer) {
    return jsonError(401, "unauthenticated", "empty bearer token");
  }

  // 2. Bearer validation.
  let bearerScopes: string[];
  try {
    const validated = await validateAccessToken(deps.db, bearer, deps.issuer);
    if (typeof validated.payload.sub !== "string" || validated.payload.sub.length === 0) {
      return jsonError(401, "unauthenticated", "bearer token has no sub claim");
    }
    bearerScopes =
      typeof validated.payload.scope === "string"
        ? validated.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }

  // 3. Scope gate.
  if (!bearerScopes.includes(API_TOKENS_REQUIRED_SCOPE)) {
    return jsonError(403, "insufficient_scope", `bearer token lacks ${API_TOKENS_REQUIRED_SCOPE}`);
  }

  // 4. Query-string parsing. All filters are optional; defaults match
  // listTokens (`revoked=all`, no subject filter, default page size).
  const url = new URL(req.url);
  const revokedParam = url.searchParams.get("revoked");
  let revoked: "true" | "false" | "all" | undefined;
  if (revokedParam === "true" || revokedParam === "false" || revokedParam === "all") {
    revoked = revokedParam;
  } else if (revokedParam !== null) {
    return jsonError(400, "invalid_request", "revoked must be one of: true | false | all");
  }
  const subjectParam = url.searchParams.get("subject");
  const subject =
    typeof subjectParam === "string" && subjectParam.length > 0 ? subjectParam : undefined;
  const cursor = url.searchParams.get("cursor");

  // 5. Query.
  const page = listTokens(deps.db, {
    filter: { ...(revoked ? { revoked } : {}), ...(subject ? { subject } : {}) },
    cursor,
  });

  const body: TokensListResponse = {
    tokens: page.rows.map((r) => ({
      jti: r.jti,
      user_id: r.userId,
      subject: r.subject,
      client_id: r.clientId,
      scopes: r.scopes,
      expires_at: r.expiresAt,
      revoked_at: r.revokedAt,
      created_at: r.createdAt,
      created_via: r.createdVia,
      permissions: r.permissions,
    })),
    next_cursor: page.nextCursor,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

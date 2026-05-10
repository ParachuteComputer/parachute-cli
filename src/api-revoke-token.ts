/**
 * `POST /api/auth/revoke-token` — HTTP companion to `parachute auth
 * revoke-token <jti>` (hub#221) and the missing piece behind the future
 * admin UI's revoke action.
 *
 * Same auth shape as `POST /api/auth/mint-token`: bearer-gated on
 * `parachute:host:auth` (admin scope-set tokens carry it as a superset;
 * narrow `--scope-set auth` operator tokens carry it directly). Closes
 * hub#220.
 *
 * Body: `{ jti: string }`.
 *
 * Responses (matching the OAuth 2.0 error-shape vocabulary used by
 * mint-token and the rest of the hub's bearer-protected admin API):
 *
 *   - 200 `{ jti, revoked_at }` — success. Idempotent: re-revoking an
 *     already-revoked jti returns the existing `revoked_at` and 200,
 *     same as the CLI's exit-0-with-existing-timestamp behavior.
 *   - 400 `invalid_request` — missing/malformed body, missing jti.
 *   - 401 `unauthenticated` — missing or invalid bearer.
 *   - 403 `insufficient_scope` — bearer lacks `parachute:host:auth`.
 *   - 404 `not_found` — no `tokens` row matches the jti.
 *   - 405 `method_not_allowed` — non-POST.
 *
 * Identity field in audit-friendly success: not echoed in the response
 * body (the JSON shape is intentionally minimal — `jti` + `revoked_at`
 * is all a UI consumer needs); operator-side audit lives in hub logs.
 * Mirrors the CLI's design where `identity=` was added for stdout but
 * the wire response stays narrow.
 */
import type { Database } from "bun:sqlite";
import { findTokenRowByJti, revokeTokenByJti, validateAccessToken } from "./jwt-sign.ts";

/** Scope required on the bearer token to call this endpoint. */
export const API_REVOKE_TOKEN_REQUIRED_SCOPE = "parachute:host:auth";

export interface ApiRevokeTokenDeps {
  db: Database;
  /** Hub origin — used to validate the bearer's `iss`. */
  issuer: string;
  /** Test seam for time. */
  now?: () => Date;
}

interface RevokeTokenRequest {
  jti?: unknown;
}

export async function handleApiRevokeToken(
  req: Request,
  deps: ApiRevokeTokenDeps,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonError(405, "method_not_allowed", "use POST");
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

  // 2. Bearer validation (signature, issuer, expiry, hub-side revocation).
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
  if (!bearerScopes.includes(API_REVOKE_TOKEN_REQUIRED_SCOPE)) {
    return jsonError(
      403,
      "insufficient_scope",
      `bearer token lacks ${API_REVOKE_TOKEN_REQUIRED_SCOPE}`,
    );
  }

  // 4. Body parsing + field extraction.
  let body: RevokeTokenRequest;
  try {
    body = (await req.json()) as RevokeTokenRequest;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(400, "invalid_request", `body must be valid JSON — ${msg}`);
  }
  if (typeof body !== "object" || body === null) {
    return jsonError(400, "invalid_request", "body must be a JSON object");
  }
  if (typeof body.jti !== "string" || body.jti.length === 0) {
    return jsonError(400, "invalid_request", "jti is required and must be a non-empty string");
  }
  const jti = body.jti;

  // 5. Lookup + revoke. Order: row-existence first (404 if missing), then
  // attempt revoke. Idempotent: if already revoked, surface the existing
  // revoked_at — same CLI semantics from hub#221.
  const existing = findTokenRowByJti(deps.db, jti);
  if (!existing) {
    return jsonError(404, "not_found", `no token with jti ${jti} found in registry`);
  }
  if (existing.revokedAt) {
    return ok({ jti, revoked_at: existing.revokedAt });
  }

  const now = deps.now?.() ?? new Date();
  const flipped = revokeTokenByJti(deps.db, jti, now);
  if (!flipped) {
    // Race: row vanished or was concurrently revoked between our lookup
    // and the UPDATE. Re-read to surface the now-current revoked_at if
    // someone else won. If still nothing, 404 (the row genuinely went
    // away — a concurrent prune, perhaps).
    const reRead = findTokenRowByJti(deps.db, jti);
    if (reRead?.revokedAt) {
      return ok({ jti, revoked_at: reRead.revokedAt });
    }
    return jsonError(404, "not_found", `no token with jti ${jti} found in registry`);
  }
  return ok({ jti, revoked_at: now.toISOString() });
}

function ok(body: { jti: string; revoked_at: string }): Response {
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

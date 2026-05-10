/**
 * Tests for the SPA's session→bearer mint endpoint. Covers:
 *   - 401 when no admin session cookie is present.
 *   - 401 when the cookie names a deleted/expired session.
 *   - 200 + JWT carrying parachute:host:admin AND parachute:host:auth.
 *   - Token validates against the hub's own keys and the configured issuer.
 *   - Method-not-allowed on POST.
 *   - End-to-end regression: the minted JWT actually unlocks the new
 *     `/api/auth/tokens` endpoint (hub#212 Phase 2 backend) — the bug from
 *     end-to-end testing that motivated adding `parachute:host:auth` here.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ADMIN_TOKEN_TTL_SECONDS, handleHostAdminToken } from "../admin-host-admin-token.ts";
import { handleApiTokens } from "../api-tokens.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession, deleteSession } from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-host-admin-token-"));
  const db = openHubDb(hubDbPath(dir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

async function withSession(): Promise<{ cookie: string; userId: string }> {
  const user = await createUser(harness.db, "operator", "hunter2");
  const session = createSession(harness.db, { userId: user.id });
  const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
  return { cookie, userId: user.id };
}

describe("handleHostAdminToken", () => {
  test("401 when no session cookie is present", async () => {
    const req = new Request(`${ISSUER}/admin/host-admin-token`);
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("401 when the cookie names a deleted session", async () => {
    const { cookie } = await withSession();
    // Pluck the session id back out of the cookie + delete its row.
    const sid = cookie.match(/parachute_hub_session=([^;]+)/)?.[1] ?? "";
    deleteSession(harness.db, sid);
    const req = new Request(`${ISSUER}/admin/host-admin-token`, {
      headers: { cookie },
    });
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
  });

  test("405 on POST", async () => {
    const { cookie } = await withSession();
    const req = new Request(`${ISSUER}/admin/host-admin-token`, {
      method: "POST",
      headers: { cookie },
    });
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
  });

  test("200 mints a JWT carrying parachute:host:admin + parachute:host:auth and the configured issuer", async () => {
    const { cookie, userId } = await withSession();
    rotateSigningKey(harness.db);
    const req = new Request(`${ISSUER}/admin/host-admin-token`, {
      headers: { cookie },
    });
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      token: string;
      expires_at: string;
      scopes: string[];
    };
    // Both scopes — the SPA now needs `:host:auth` for the hub#212 Phase 2
    // token-registry endpoints alongside the existing `:host:admin` for
    // vault provisioning + grant management.
    expect(body.scopes).toEqual(["parachute:host:admin", "parachute:host:auth"]);
    expect(body.token.length).toBeGreaterThan(20);

    // expires_at is roughly TTL_SECONDS in the future.
    const expMs = new Date(body.expires_at).getTime();
    const skew = expMs - Date.now();
    expect(skew).toBeGreaterThan((HOST_ADMIN_TOKEN_TTL_SECONDS - 30) * 1000);
    expect(skew).toBeLessThan((HOST_ADMIN_TOKEN_TTL_SECONDS + 30) * 1000);

    // JWT verifies against the hub's own signing key + issuer.
    const validated = await validateAccessToken(harness.db, body.token, ISSUER);
    expect(validated.payload.sub).toBe(userId);
    expect(validated.payload.iss).toBe(ISSUER);
    const scopeClaim = (validated.payload as { scope?: string }).scope ?? "";
    const scopes = scopeClaim.split(/\s+/);
    expect(scopes).toContain("parachute:host:admin");
    expect(scopes).toContain("parachute:host:auth");
  });

  // Regression for the end-to-end bug that motivated adding `:host:auth`
  // here: the SPA's session-bearer was rejected by `/api/auth/tokens` (and
  // its peers) because it carried `:host:admin` only. This test mints
  // through the SPA path and exercises one of the new endpoints
  // end-to-end — the Phase 2 backend tests only minted operator-style
  // tokens with `:host:auth` directly, leaving the SPA-flow gap uncaught.
  test("regression: the minted SPA bearer is accepted by /api/auth/tokens", async () => {
    const { cookie } = await withSession();
    rotateSigningKey(harness.db);

    // Step 1: SPA grabs its bearer via the cookie path.
    const mintRes = await handleHostAdminToken(
      new Request(`${ISSUER}/admin/host-admin-token`, { headers: { cookie } }),
      { db: harness.db, issuer: ISSUER },
    );
    expect(mintRes.status).toBe(200);
    const { token } = (await mintRes.json()) as { token: string };

    // Step 2: SPA hits /api/auth/tokens with that bearer. Pre-fix this
    // returned 403 `bearer token lacks parachute:host:auth`; post-fix it
    // returns 200 with the (empty-by-default) tokens list.
    const tokensRes = await handleApiTokens(
      new Request(`${ISSUER}/api/auth/tokens`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }),
      { db: harness.db, issuer: ISSUER },
    );
    expect(tokensRes.status).toBe(200);
    const tokensBody = (await tokensRes.json()) as {
      tokens: unknown[];
      next_cursor: string | null;
    };
    expect(Array.isArray(tokensBody.tokens)).toBe(true);
    expect(tokensBody.next_cursor).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerClient } from "../clients.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import {
  authorizationServerMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleToken,
} from "../oauth-handlers.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.example";

async function makeDb() {
  const configDir = mkdtempSync(join(tmpdir(), "phub-oauth-"));
  const db = openHubDb(hubDbPath(configDir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

function makePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeUrl(params: Record<string, string>): string {
  const u = new URL("/oauth/authorize", ISSUER);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

describe("authorizationServerMetadata", () => {
  test("emits RFC 8414 fields rooted at the issuer", async () => {
    const res = authorizationServerMetadata({ issuer: ISSUER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(body.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.grant_types_supported).toContain("refresh_token");
    // closes #68 — scopes_supported populated from FIRST_PARTY_SCOPES
    const scopesSupported = body.scopes_supported as string[];
    expect(scopesSupported).toContain("vault:read");
    expect(scopesSupported).toContain("vault:admin");
    expect(scopesSupported).toContain("scribe:transcribe");
    expect(scopesSupported).toContain("hub:admin");
  });
});

describe("handleAuthorizeGet", () => {
  test("renders login form when no session cookie is present", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:read",
          state: "xyz",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Sign in");
      expect(html).toContain('name="__action" value="login"');
      // State + redirect_uri must be echoed via hidden inputs.
      expect(html).toContain('name="state" value="xyz"');
      expect(html).toContain('name="redirect_uri" value="https://app.example/cb"');
    } finally {
      cleanup();
    }
  });

  test("renders consent screen when session is valid", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "MyApp",
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:read",
        }),
        {
          headers: {
            cookie: buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)),
          },
        },
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Authorize");
      expect(html).toContain("MyApp");
      expect(html).toContain("vault:read");
      expect(html).toContain('name="__action" value="consent"');
    } finally {
      cleanup();
    }
  });

  test("rejects unknown client_id with 400", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: "no-such-client",
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("rejects redirect_uri not registered for this client", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://evil.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("rejects code_challenge_method=plain (PKCE S256 mandatory)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: "challenge",
          code_challenge_method: "plain",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      const loc = res.headers.get("location");
      expect(loc).toContain("error=invalid_request");
    } finally {
      cleanup();
    }
  });
});

describe("handleAuthorizePost — login submit", () => {
  test("sets session cookie and redirects to GET on valid credentials", async () => {
    const { db, cleanup } = await makeDb();
    try {
      await createUser(db, "owner", "hunter2");
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "login",
        username: "owner",
        password: "hunter2",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/oauth/authorize?");
      const cookie = res.headers.get("set-cookie");
      expect(cookie).toContain("parachute_hub_session=");
      expect(cookie).toContain("HttpOnly");
    } finally {
      cleanup();
    }
  });

  test("rejects bad password with 401, no cookie", async () => {
    const { db, cleanup } = await makeDb();
    try {
      await createUser(db, "owner", "hunter2");
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "login",
        username: "owner",
        password: "wrong",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("handleAuthorizePost — consent submit", () => {
  test("approve issues an auth code and redirects to redirect_uri", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "consent",
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "abc123",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: buildSessionCookie(session.id, 86400),
        },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.origin + loc.pathname).toBe("https://app.example/cb");
      expect(loc.searchParams.get("code")?.length).toBeGreaterThan(20);
      expect(loc.searchParams.get("state")).toBe("abc123");
    } finally {
      cleanup();
    }
  });

  test("deny returns access_denied with state echoed", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "consent",
        approve: "no",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "abc",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: buildSessionCookie(session.id, 86400),
        },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.searchParams.get("error")).toBe("access_denied");
      expect(loc.searchParams.get("state")).toBe("abc");
    } finally {
      cleanup();
    }
  });
});

describe("handleToken — full OAuth dance", () => {
  test("authorize → token → validate JWT", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();

      // Approve consent → auth code lands in redirect_uri.
      const consentForm = new URLSearchParams({
        __action: "consent",
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentReq = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: buildSessionCookie(session.id, 86400),
        },
      });
      const consentRes = await handleAuthorizePost(db, consentReq, { issuer: ISSUER });
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      expect(code).toBeTruthy();

      // Redeem.
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const tokenReq = new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        body: tokenForm,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const tokenRes = await handleToken(db, tokenReq, { issuer: ISSUER });
      expect(tokenRes.status).toBe(200);
      const tokenBody = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
        scope: string;
      };
      expect(tokenBody.token_type).toBe("Bearer");
      expect(tokenBody.scope).toBe("vault:read");
      expect(tokenBody.refresh_token.length).toBeGreaterThan(20);

      // JWT must verify against the hub's signing keys, with the right sub +
      // aud (vault:read → "vault").
      const { payload } = await validateAccessToken(db, tokenBody.access_token);
      expect(payload.sub).toBe(user.id);
      expect(payload.aud).toBe("vault");
      expect(payload.scope).toBe("vault:read");
      expect(payload.client_id).toBe(reg.client.clientId);
    } finally {
      cleanup();
    }
  });

  test("auth code is single-use (replay returns invalid_grant)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentReq = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: buildSessionCookie(session.id, 86400),
        },
      });
      const consentRes = await handleAuthorizePost(db, consentReq, { issuer: ISSUER });
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");

      const exchange = () => {
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          code: code ?? "",
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          code_verifier: verifier,
        });
        const req = new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: form,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        });
        return handleToken(db, req, { issuer: ISSUER });
      };

      const first = await exchange();
      expect(first.status).toBe(200);
      const second = await exchange();
      expect(second.status).toBe(400);
      const err = (await second.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_grant");
    } finally {
      cleanup();
    }
  });

  test("refresh_token grant rotates the pair and revokes the old refresh", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentReq = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: buildSessionCookie(session.id, 86400),
        },
      });
      const consentRes = await handleAuthorizePost(db, consentReq, { issuer: ISSUER });
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const tokenRes = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      const initial = (await tokenRes.json()) as { refresh_token: string };

      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: reg.client.clientId,
      });
      const refreshRes = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: refreshForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      expect(refreshRes.status).toBe(200);
      const rotated = (await refreshRes.json()) as { refresh_token: string };
      expect(rotated.refresh_token).not.toBe(initial.refresh_token);

      // Old refresh token should now fail (revoked).
      const replayRes = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: refreshForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      expect(replayRes.status).toBe(400);
      const err = (await replayRes.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_grant");
    } finally {
      cleanup();
    }
  });

  test("client_credentials returns unsupported_grant_type", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const form = new URLSearchParams({ grant_type: "client_credentials" });
      const req = new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        body: form,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const res = await handleToken(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("unsupported_grant_type");
    } finally {
      cleanup();
    }
  });

  test("PKCE verifier mismatch returns invalid_grant", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentRes = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: buildSessionCookie(session.id, 86400),
          },
        }),
        { issuer: ISSUER },
      );
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: "wrong-verifier",
      });
      const res = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_grant");
    } finally {
      cleanup();
    }
  });

  // cli#71 — scope-validation gate at /oauth/token. The hub must not sign a
  // JWT carrying scopes the issuer never declared.
  test("unknown scope at /oauth/token returns invalid_scope (400)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read frobnicate:everything",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentRes = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: buildSessionCookie(session.id, 86400),
          },
        }),
        { issuer: ISSUER },
      );
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const res = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_scope");
      expect(err.error_description).toMatch(/frobnicate:everything/);
      expect(err.invalid_scopes).toEqual(["frobnicate:everything"]);
    } finally {
      cleanup();
    }
  });

  test("third-party scope from injected declared set is accepted", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "widget:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentRes = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: buildSessionCookie(session.id, 86400),
          },
        }),
        { issuer: ISSUER },
      );
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const declared = new Set(["widget:read"]);
      const res = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER, loadDeclaredScopes: () => declared },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { scope: string };
      expect(body.scope).toBe("widget:read");
    } finally {
      cleanup();
    }
  });

  test("per-resource narrowing (vault:work:read against declared vault:read)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:work:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentRes = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: buildSessionCookie(session.id, 86400),
          },
        }),
        { issuer: ISSUER },
      );
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const res = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { scope: string };
      expect(body.scope).toBe("vault:work:read");
    } finally {
      cleanup();
    }
  });
});

describe("handleRegister — RFC 7591 DCR", () => {
  test("registers a public client and returns 201 with client_id (no secret)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({
          redirect_uris: ["https://app.example/cb"],
          scope: "vault:read",
          client_name: "MyApp",
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.client_id).toBe("string");
      expect(body.client_secret).toBeUndefined();
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.redirect_uris).toEqual(["https://app.example/cb"]);
      expect(body.client_name).toBe("MyApp");
    } finally {
      cleanup();
    }
  });

  test("registers a confidential client and returns plaintext client_secret", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({
          redirect_uris: ["https://app.example/cb"],
          token_endpoint_auth_method: "client_secret_post",
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.client_secret).toBe("string");
      expect(body.token_endpoint_auth_method).toBe("client_secret_post");
    } finally {
      cleanup();
    }
  });

  test("rejects empty redirect_uris with invalid_redirect_uri", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: [] }),
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_redirect_uri");
    } finally {
      cleanup();
    }
  });

  test("rejects javascript: redirect_uri", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }),
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_redirect_uri");
    } finally {
      cleanup();
    }
  });

  test("rejects non-JSON body", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: "not json",
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });
});

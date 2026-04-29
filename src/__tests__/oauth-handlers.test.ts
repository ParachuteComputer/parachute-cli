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
  buildServicesCatalog,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleToken,
} from "../oauth-handlers.ts";
import type { ServicesManifest } from "../services-manifest.ts";
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

const FIXTURE_MANIFEST: ServicesManifest = {
  services: [
    {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/health",
      version: "0.3.0",
    },
    {
      name: "parachute-scribe",
      port: 1943,
      paths: ["/scribe"],
      health: "/health",
      version: "0.3.0-rc.1",
    },
    {
      name: "parachute-notes",
      port: 1942,
      paths: ["/notes"],
      health: "/notes/health",
      version: "0.3.0",
    },
  ],
};

function fixtureLoadServicesManifest(): ServicesManifest {
  return FIXTURE_MANIFEST;
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

  test("does NOT advertise non-requestable operator-only scopes", async () => {
    // #96: parachute:host:admin is operator-only. RFC 8414 §2 frames
    // scopes_supported as scopes a client *can* request — advertising what
    // we always reject would mislead clients.
    const res = authorizationServerMetadata({ issuer: ISSUER });
    const body = (await res.json()) as Record<string, unknown>;
    const scopesSupported = body.scopes_supported as string[];
    expect(scopesSupported).not.toContain("parachute:host:admin");
  });

  test("advertises third-party module scopes from loadDeclaredScopes", async () => {
    // #91: scopes_supported pulls from `loadDeclaredScopes()` (FIRST_PARTY ∪
    // each registered module's `scopes.defines`) so standards-following
    // clients discover third-party scopes the same way they discover
    // first-party ones. The token-issuance path already uses
    // loadDeclaredScopes (#90); the AS metadata had to follow or its public
    // advertisement would be a strict subset of what it'll actually sign.
    const declared = new Set<string>([
      "vault:read",
      "vault:admin",
      "hub:admin",
      "parachute:host:admin", // declared but operator-only — must still be filtered
      "claw:read",
      "claw:write",
      "mymodule:do-thing",
    ]);
    const res = authorizationServerMetadata({
      issuer: ISSUER,
      loadDeclaredScopes: () => declared,
    });
    const body = (await res.json()) as Record<string, unknown>;
    const scopesSupported = body.scopes_supported as string[];
    // Third-party scopes show up
    expect(scopesSupported).toContain("claw:read");
    expect(scopesSupported).toContain("claw:write");
    expect(scopesSupported).toContain("mymodule:do-thing");
    // First-party still advertised — no regression
    expect(scopesSupported).toContain("vault:read");
    expect(scopesSupported).toContain("vault:admin");
    expect(scopesSupported).toContain("hub:admin");
    // NON_REQUESTABLE filter still applies even when the scope is declared
    expect(scopesSupported).not.toContain("parachute:host:admin");
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

  test("rejects parachute:host:admin scope with invalid_scope redirect (#96)", async () => {
    // Operator-only scopes — third-party apps cannot mint them via the
    // public flow. Per RFC 6749 §4.1.2.1, scope failures redirect to the
    // registered redirect_uri with error=invalid_scope, not an HTML error.
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
          scope: "vault:read parachute:host:admin",
          state: "abc",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.origin + loc.pathname).toBe("https://app.example/cb");
      expect(loc.searchParams.get("error")).toBe("invalid_scope");
      expect(loc.searchParams.get("error_description")).toContain("parachute:host:admin");
      expect(loc.searchParams.get("state")).toBe("abc");
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

// Q1 of 2026-04-28-vault-config-and-scopes.md: an unnamed `vault:<verb>` is
// ambiguous, so the consent screen forces the operator to pick a vault before
// the JWT is minted. Picked vault rewrites the scope to `vault:<picked>:<verb>`
// and stamps `aud=vault.<picked>` so vault's strict per-resource enforcement
// (Phase 1) can match the audience against the URL-derived vault name.
describe("handleAuthorizeGet — vault picker", () => {
  test("renders the picker when scope is unnamed vault:<verb>", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
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
        }),
        {
          headers: {
            cookie: buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)),
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Pick a vault");
      // The fixture manifest's `parachute-vault` has paths `["/vault/default"]`
      // — that's the one available vault in the picker.
      expect(html).toContain('name="vault_pick" value="default"');
    } finally {
      cleanup();
    }
  });

  test("picker is omitted when scope is already named vault:<name>:<verb>", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:work:read",
        }),
        {
          headers: {
            cookie: buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)),
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("Pick a vault");
      expect(html).not.toContain('name="vault_pick"');
    } finally {
      cleanup();
    }
  });

  test("picker shows a help message and disables Approve when no vaults exist", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
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
        }),
        {
          headers: {
            cookie: buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)),
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: () => ({ services: [] }),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Pick a vault");
      expect(html).toContain("no vaults exist");
      expect(html).toContain('name="approve" value="yes" class="btn btn-primary" disabled');
    } finally {
      cleanup();
    }
  });
});

describe("handleAuthorizePost — vault picker", () => {
  test("approve with vault_pick narrows vault:read → vault:<picked>:read in the issued JWT", async () => {
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
        vault_pick: "default",
      });
      const consentReq = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: buildSessionCookie(session.id, 86400),
        },
      });
      const consentRes = await handleAuthorizePost(db, consentReq, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(consentRes.status).toBe(302);
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      expect(code).toBeTruthy();

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
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(tokenRes.status).toBe(200);
      const body = (await tokenRes.json()) as { access_token: string; scope: string };
      expect(body.scope).toBe("vault:default:read");

      const { payload } = await validateAccessToken(db, body.access_token, ISSUER);
      expect(payload.aud).toBe("vault.default");
      expect(payload.scope).toBe("vault:default:read");
    } finally {
      cleanup();
    }
  });

  test("approve without vault_pick on unnamed vault scope fails 400", async () => {
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
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const res = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: buildSessionCookie(session.id, 86400),
          },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Pick a vault");
    } finally {
      cleanup();
    }
  });

  test("approve with vault_pick that names an unknown vault fails 400", async () => {
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
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
        vault_pick: "evil-vault",
      });
      const res = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: buildSessionCookie(session.id, 86400),
          },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Unknown vault");
    } finally {
      cleanup();
    }
  });

  test("multiple unnamed verbs are all narrowed to the picked vault", async () => {
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
        scope: "vault:read vault:write",
        code_challenge: challenge,
        code_challenge_method: "S256",
        vault_pick: "default",
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
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenRes = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code ?? "",
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            code_verifier: verifier,
          }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(tokenRes.status).toBe(200);
      const body = (await tokenRes.json()) as { scope: string };
      expect(body.scope).toBe("vault:default:read vault:default:write");
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
        scope: "vault:default:read",
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

  test("rejects parachute:host:admin in form scope (defense-in-depth, #96)", async () => {
    // GET-time gate already rejects, but a hand-crafted POST could carry
    // an operator-only scope. Consent submit must independently reject.
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
        scope: "parachute:host:admin",
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
      expect(loc.searchParams.get("error")).toBe("invalid_scope");
      expect(loc.searchParams.get("error_description")).toContain("parachute:host:admin");
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
        scope: "vault:default:read",
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
      const tokenRes = await handleToken(db, tokenReq, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(tokenRes.status).toBe(200);
      const tokenBody = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
        scope: string;
        services: Record<string, { url: string; version: string }>;
      };
      expect(tokenBody.token_type).toBe("Bearer");
      expect(tokenBody.scope).toBe("vault:default:read");
      expect(tokenBody.refresh_token.length).toBeGreaterThan(20);

      // JWT must verify against the hub's signing keys, with the right sub +
      // aud (named `vault:default:read` → "vault.default" — RFC 8707-style
      // resource binding from the vault-config-and-scopes Phase 1+2 design)
      // and iss matching the configured issuer (closes #77 — vault rejects
      // tokens with a missing or mismatched iss).
      const { payload } = await validateAccessToken(db, tokenBody.access_token, ISSUER);
      expect(payload.sub).toBe(user.id);
      expect(payload.aud).toBe("vault.default");
      expect(payload.iss).toBe(ISSUER);
      expect(payload.scope).toBe("vault:default:read");
      expect(payload.client_id).toBe(reg.client.clientId);

      // closes #81 — services catalog tells the client where vault lives so
      // notes doesn't have to re-probe /.well-known/parachute.json. A
      // vault:read token only sees the vault entry.
      expect(tokenBody.services).toEqual({
        vault: { url: `${ISSUER}/vault/default`, version: "0.3.0" },
      });
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
        scope: "vault:default:read",
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
        scope: "vault:default:read frobnicate:everything",
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

  // closes #81 — services-catalog filtering + multi-service shape.
  test("services catalog omits services the token has no scope for", async () => {
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
        scope: "scribe:transcribe",
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
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        services: Record<string, { url: string; version: string }>;
      };
      expect(body.services).toEqual({
        scribe: { url: `${ISSUER}/scribe`, version: "0.3.0-rc.1" },
      });
      expect(body.services.vault).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("services catalog includes every service the token has a scope for", async () => {
    // buildServicesCatalog is a pure helper — exercise the multi-scope shape
    // here without re-running the full PKCE dance.
    const catalog = buildServicesCatalog(FIXTURE_MANIFEST, ISSUER, [
      "vault:read",
      "scribe:transcribe",
    ]);
    expect(catalog).toEqual({
      vault: { url: `${ISSUER}/vault/default`, version: "0.3.0" },
      scribe: { url: `${ISSUER}/scribe`, version: "0.3.0-rc.1" },
    });
  });

  test("services catalog is empty when the token has no resource-prefixed scopes", () => {
    expect(buildServicesCatalog(FIXTURE_MANIFEST, ISSUER, [])).toEqual({});
    // hub-only scopes don't reference any installed module catalog entry.
    expect(buildServicesCatalog(FIXTURE_MANIFEST, ISSUER, ["hub:admin"])).toEqual({});
  });

  // closes #81 — vault URL must follow paths[0] from services.json, NOT a
  // hardcoded `/vault/default`. Users who installed with `--vault-name work`
  // have `paths: ["/vault/work"]` and the catalog must reflect that.
  test("services catalog reads paths[0] verbatim — handles custom vault names", () => {
    const customManifest: ServicesManifest = {
      services: [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/work"],
          health: "/health",
          version: "0.3.0",
        },
      ],
    };
    expect(buildServicesCatalog(customManifest, ISSUER, ["vault:read"])).toEqual({
      vault: { url: `${ISSUER}/vault/work`, version: "0.3.0" },
    });
  });
});

// closes #72 — RFC 6749 §3.2.1 + §2.3.1: confidential clients must
// authenticate at /oauth/token via Authorization: Basic header (preferred)
// or form-body client_secret. Public clients (PKCE-only) are unaffected
// because PKCE replaces the secret for them.
describe("handleToken — confidential client authentication (#72)", () => {
  // Helper: drive the consent screen for `clientId` to a fresh auth code.
  // Returns the code + the verifier so the caller can hit /oauth/token.
  async function consentAndGetCode(
    db: Awaited<ReturnType<typeof makeDb>>["db"],
    clientId: string,
    sessionId: string,
  ): Promise<{ code: string; verifier: string }> {
    const { verifier, challenge } = makePkce();
    const consentForm = new URLSearchParams({
      __action: "consent",
      approve: "yes",
      client_id: clientId,
      redirect_uri: "https://app.example/cb",
      response_type: "code",
      scope: "vault:default:read",
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
          cookie: buildSessionCookie(sessionId, 86400),
        },
      }),
      { issuer: ISSUER },
    );
    const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
    return { code: code ?? "", verifier };
  }

  function tokenRequest(form: URLSearchParams, headers: Record<string, string> = {}): Request {
    return new Request(`${ISSUER}/oauth/token`, {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    });
  }

  test("authorization_code: confidential client + correct secret in form body → 200", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      expect(reg.clientSecret).not.toBeNull();
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
        client_secret: reg.clientSecret ?? "",
      });
      const res = await handleToken(db, tokenRequest(tokenForm), {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("authorization_code: confidential client + correct secret in Authorization: Basic header → 200", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
        // No client_secret in the body — the header carries it.
      });
      // RFC 6749 §2.3.1 requires form-encoding the credentials before base64.
      const basic = btoa(
        `${encodeURIComponent(reg.client.clientId)}:${encodeURIComponent(reg.clientSecret ?? "")}`,
      );
      const res = await handleToken(
        db,
        tokenRequest(tokenForm, { authorization: `Basic ${basic}` }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(res.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("authorization_code: confidential client + wrong secret → 401 + WWW-Authenticate Basic", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
        client_secret: "definitely-not-the-real-secret",
      });
      const res = await handleToken(db, tokenRequest(tokenForm), { issuer: ISSUER });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic\b/i);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_client");
    } finally {
      cleanup();
    }
  });

  test("authorization_code: confidential client + missing secret → 401 + WWW-Authenticate Basic", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      // No client_secret in form, no Authorization header.
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const res = await handleToken(db, tokenRequest(tokenForm), { issuer: ISSUER });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic\b/i);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_client");
      expect(err.error_description).toMatch(/required/);
    } finally {
      cleanup();
    }
  });

  test("authorization_code: Basic header client_id mismatch with body → 401", async () => {
    // Defensive: a header authenticating as one client while the body claims
    // another is a confused or hostile request — refuse rather than guess.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const basic = btoa(
        `${encodeURIComponent("some-other-client")}:${encodeURIComponent(reg.clientSecret ?? "")}`,
      );
      const res = await handleToken(
        db,
        tokenRequest(tokenForm, { authorization: `Basic ${basic}` }),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(401);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_client");
      expect(err.error_description).toMatch(/header client_id/);
    } finally {
      cleanup();
    }
  });

  test("authorization_code: public client unaffected (no secret required) → 200", async () => {
    // Regression: PKCE-only clients must keep working with no client_secret.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      expect(reg.clientSecret).toBeNull();
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const res = await handleToken(db, tokenRequest(tokenForm), {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("refresh_token: confidential client + correct secret rotates the pair", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      // Mint an initial refresh token (one full dance with the secret).
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const initialTokenRes = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            code_verifier: verifier,
            client_secret: reg.clientSecret ?? "",
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const initial = (await initialTokenRes.json()) as { refresh_token: string };

      // Refresh with secret → 200.
      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: reg.client.clientId,
        client_secret: reg.clientSecret ?? "",
      });
      const refreshRes = await handleToken(db, tokenRequest(refreshForm), {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(refreshRes.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("refresh_token: confidential client + missing secret → 401", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const initialTokenRes = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            code_verifier: verifier,
            client_secret: reg.clientSecret ?? "",
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const initial = (await initialTokenRes.json()) as { refresh_token: string };

      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: reg.client.clientId,
        // No client_secret.
      });
      const res = await handleToken(db, tokenRequest(refreshForm), { issuer: ISSUER });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic\b/i);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_client");
    } finally {
      cleanup();
    }
  });

  test("refresh_token: confidential client + wrong secret → 401", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const initialTokenRes = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            code_verifier: verifier,
            client_secret: reg.clientSecret ?? "",
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const initial = (await initialTokenRes.json()) as { refresh_token: string };

      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: reg.client.clientId,
        client_secret: "wrong-secret",
      });
      const res = await handleToken(db, tokenRequest(refreshForm), { issuer: ISSUER });
      expect(res.status).toBe(401);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_client");
    } finally {
      cleanup();
    }
  });

  test("refresh_token: public client unaffected (no secret required) → 200", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const initialTokenRes = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            code_verifier: verifier,
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const initial = (await initialTokenRes.json()) as { refresh_token: string };

      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: reg.client.clientId,
      });
      const res = await handleToken(db, tokenRequest(refreshForm), {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
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

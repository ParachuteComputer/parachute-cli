/**
 * Native OAuth handlers for the hub. Each handler is a pure function over
 * `(db, req)` returning a `Response` — no global state, no side channels —
 * so the test harness can drive the full OAuth dance without standing up
 * `Bun.serve` or going near the network.
 *
 * Endpoints implemented:
 *   - GET  /.well-known/oauth-authorization-server  (RFC 8414 metadata)
 *   - GET  /oauth/authorize                          (login → consent → code)
 *   - POST /oauth/authorize                          (form posts: login + consent)
 *   - POST /oauth/token                              (grant_type=authorization_code | refresh_token)
 *   - POST /oauth/register                           (RFC 7591 DCR)
 *
 * `client_credentials` is intentionally unimplemented — it's not in the
 * launch surface (no machine-to-machine clients yet); the token endpoint
 * stubs it with `unsupported_grant_type`.
 *
 * HTML for login + consent + error views lives in `oauth-ui.ts` so the
 * handlers stay focused on protocol logic and the templates stay focused
 * on presentation.
 */
import type { Database } from "bun:sqlite";
import {
  AuthCodeExpiredError,
  AuthCodeNotFoundError,
  AuthCodePkceMismatchError,
  AuthCodeRedirectMismatchError,
  AuthCodeUsedError,
  issueAuthCode,
  redeemAuthCode,
} from "./auth-codes.ts";
import {
  type OAuthClient,
  type RegisteredClient,
  getClient,
  isValidRedirectUri,
  registerClient,
  requireRegisteredRedirectUri,
} from "./clients.ts";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  findRefreshToken,
  signAccessToken,
  signRefreshToken,
} from "./jwt-sign.ts";
import { type AuthorizeFormParams, renderConsent, renderError, renderLogin } from "./oauth-ui.ts";
import { FIRST_PARTY_SCOPES } from "./scope-explanations.ts";
import { findUnknownScopes, loadDeclaredScopes } from "./scope-registry.ts";
import {
  SESSION_TTL_MS,
  buildSessionCookie,
  createSession,
  findSession,
  parseSessionCookie,
} from "./sessions.ts";
import { getUserByUsername, verifyPassword } from "./users.ts";

export interface OAuthDeps {
  /** Hub origin used for `iss`, `authorization_endpoint`, etc. */
  issuer: string;
  /** Override the clock for deterministic tests. */
  now?: () => Date;
  /**
   * Resolve the declared-scope set the issuer is willing to sign. Production
   * walks `services.json` + each module's `.parachute/module.json`
   * `scopes.defines` and unions with `FIRST_PARTY_SCOPES`. Tests inject a
   * pinned set so the gate is deterministic without a fixture services.json.
   * See cli#71 + `oauth-scopes.md`.
   */
  loadDeclaredScopes?: () => ReadonlySet<string>;
}

// --- helpers ---------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extra },
  });
}

function redirectResponse(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...extra } });
}

function htmlError(title: string, message: string, status: number): Response {
  return htmlResponse(renderError({ title, message, status }), status);
}

function oauthErrorRedirect(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return redirectResponse(u.toString());
}

// --- /.well-known/oauth-authorization-server -------------------------------

export function authorizationServerMetadata(deps: OAuthDeps): Response {
  const iss = deps.issuer;
  return jsonResponse({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: FIRST_PARTY_SCOPES,
  });
}

// --- /oauth/authorize ------------------------------------------------------

function parseAuthorizeFormParams(url: URL): AuthorizeFormParams | { error: string } {
  const required = (k: string) => {
    const v = url.searchParams.get(k);
    return v && v.length > 0 ? v : null;
  };
  const clientId = required("client_id");
  const redirectUri = required("redirect_uri");
  const responseType = required("response_type");
  const scope = url.searchParams.get("scope") ?? "";
  const codeChallenge = required("code_challenge");
  const codeChallengeMethod = required("code_challenge_method");
  if (!clientId) return { error: "missing client_id" };
  if (!redirectUri) return { error: "missing redirect_uri" };
  if (!responseType) return { error: "missing response_type" };
  if (!codeChallenge) return { error: "missing code_challenge" };
  if (!codeChallengeMethod) return { error: "missing code_challenge_method" };
  return {
    clientId,
    redirectUri,
    responseType,
    scope,
    codeChallenge,
    codeChallengeMethod,
    state: url.searchParams.get("state"),
  };
}

/**
 * GET /oauth/authorize — entrypoint. Validates client + redirect_uri, then
 * either renders the login form (no session) or the consent screen (session
 * present). All authorize-time params are echoed back via hidden inputs so
 * the form POST keeps the binding intact.
 */
export function handleAuthorizeGet(db: Database, req: Request, _deps: OAuthDeps): Response {
  const url = new URL(req.url);
  const parsed = parseAuthorizeFormParams(url);
  if ("error" in parsed) {
    return htmlError("Invalid authorization request", parsed.error, 400);
  }
  if (parsed.responseType !== "code") {
    return oauthErrorRedirect(
      parsed.redirectUri,
      "unsupported_response_type",
      "only response_type=code is supported",
      parsed.state,
    );
  }
  if (parsed.codeChallengeMethod !== "S256") {
    return oauthErrorRedirect(
      parsed.redirectUri,
      "invalid_request",
      "PKCE S256 is required",
      parsed.state,
    );
  }
  const client = getClient(db, parsed.clientId);
  if (!client) {
    // Can't safely redirect — we don't trust the redirect_uri until we've
    // matched it against a registered client. Render an HTML error.
    return htmlError("Unknown application", "This client_id is not registered with this hub.", 400);
  }
  try {
    requireRegisteredRedirectUri(client, parsed.redirectUri);
  } catch {
    return htmlError(
      "Redirect mismatch",
      "The redirect_uri does not match any URI registered for this app.",
      400,
    );
  }

  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? findSession(db, sessionId) : null;
  if (!session) {
    return htmlResponse(renderLogin({ params: parsed }));
  }
  return htmlResponse(renderConsent(consentProps(client, parsed)));
}

/**
 * POST /oauth/authorize — handles two distinct submissions:
 *   - login form: `__action=login` with username + password. On success,
 *     create a session, set the cookie, redirect back to GET /oauth/authorize
 *     so the user lands on the consent screen.
 *   - consent submission: `__action=consent` with `approve=yes|no`. On
 *     approve, mint an auth code and redirect to the client's redirect_uri.
 *     On deny, redirect with `error=access_denied`.
 */
export async function handleAuthorizePost(
  db: Database,
  req: Request,
  deps: OAuthDeps,
): Promise<Response> {
  const form = await req.formData();
  const action = String(form.get("__action") ?? "");
  if (action === "login") return await handleLoginSubmit(db, req, form, deps);
  if (action === "consent") return await handleConsentSubmit(db, req, form, deps);
  return htmlError("Invalid form submission", "Unknown form action.", 400);
}

async function handleLoginSubmit(
  db: Database,
  _req: Request,
  form: Awaited<ReturnType<Request["formData"]>>,
  _deps: OAuthDeps,
): Promise<Response> {
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  const params = paramsFromForm(form);
  if (!username || !password) {
    return htmlResponse(
      renderLogin({ params, errorMessage: "Username and password are required." }),
      400,
    );
  }
  const user = getUserByUsername(db, username);
  if (!user) {
    return htmlResponse(renderLogin({ params, errorMessage: "Invalid credentials." }), 401);
  }
  const ok = await verifyPassword(user, password);
  if (!ok) {
    return htmlResponse(renderLogin({ params, errorMessage: "Invalid credentials." }), 401);
  }
  const session = createSession(db, { userId: user.id });
  const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
  // Redirect back to GET /oauth/authorize with the original query string so
  // the user lands on the consent screen with full params re-validated.
  const u = new URL("/oauth/authorize", "http://placeholder");
  for (const [k, v] of Object.entries(authorizeParamsToQuery(params))) {
    u.searchParams.set(k, v);
  }
  return redirectResponse(`${u.pathname}${u.search}`, { "set-cookie": cookie });
}

async function handleConsentSubmit(
  db: Database,
  req: Request,
  form: Awaited<ReturnType<Request["formData"]>>,
  deps: OAuthDeps,
): Promise<Response> {
  const params = paramsFromForm(form);
  const approve = String(form.get("approve") ?? "") === "yes";
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? findSession(db, sessionId) : null;
  if (!session) {
    // Session expired between login and consent submit. Send back to login.
    return htmlResponse(
      renderLogin({ params, errorMessage: "Your session expired — please sign in again." }),
      401,
    );
  }
  const client = getClient(db, params.clientId);
  if (!client) {
    return htmlError("Unknown application", "This client_id is not registered with this hub.", 400);
  }
  try {
    requireRegisteredRedirectUri(client, params.redirectUri);
  } catch {
    return htmlError(
      "Redirect mismatch",
      "The redirect_uri does not match any URI registered for this app.",
      400,
    );
  }
  if (!approve) {
    return oauthErrorRedirect(
      params.redirectUri,
      "access_denied",
      "user denied the authorization request",
      params.state,
    );
  }
  const scopes = params.scope.split(" ").filter((s) => s.length > 0);
  // Record the grant — gives PR (d) a place to skip the consent screen on
  // re-authorization for already-granted scopes.
  db.prepare(
    `INSERT OR REPLACE INTO grants (user_id, client_id, scopes, granted_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    session.userId,
    client.clientId,
    scopes.join(" "),
    (deps.now?.() ?? new Date()).toISOString(),
  );
  const code = issueAuthCode(db, {
    clientId: client.clientId,
    userId: session.userId,
    redirectUri: params.redirectUri,
    scopes,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    now: deps.now,
  });
  const u = new URL(params.redirectUri);
  u.searchParams.set("code", code.code);
  if (params.state) u.searchParams.set("state", params.state);
  return redirectResponse(u.toString());
}

function paramsFromForm(form: Awaited<ReturnType<Request["formData"]>>): AuthorizeFormParams {
  return {
    clientId: String(form.get("client_id") ?? ""),
    redirectUri: String(form.get("redirect_uri") ?? ""),
    responseType: String(form.get("response_type") ?? "code"),
    scope: String(form.get("scope") ?? ""),
    codeChallenge: String(form.get("code_challenge") ?? ""),
    codeChallengeMethod: String(form.get("code_challenge_method") ?? "S256"),
    state: (form.get("state") as string | null) ?? null,
  };
}

function authorizeParamsToQuery(p: AuthorizeFormParams): Record<string, string> {
  const q: Record<string, string> = {
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: p.responseType,
    scope: p.scope,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
  };
  if (p.state) q.state = p.state;
  return q;
}

// --- /oauth/token ----------------------------------------------------------

/**
 * POST /oauth/token — supports `authorization_code` + `refresh_token`.
 * Confidential clients may pass `client_secret` in the body; for public
 * clients the binding is PKCE alone. Errors return the RFC 6749 §5.2
 * shape: 400 + `{error, error_description}`.
 */
export async function handleToken(db: Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const form = await req.formData();
  const grantType = String(form.get("grant_type") ?? "");
  if (grantType === "authorization_code") return await handleTokenAuthorizationCode(db, form, deps);
  if (grantType === "refresh_token") return await handleTokenRefresh(db, form, deps);
  return jsonResponse(
    {
      error: "unsupported_grant_type",
      error_description: `grant_type "${grantType}" is not supported`,
    },
    400,
  );
}

async function handleTokenAuthorizationCode(
  db: Database,
  form: Awaited<ReturnType<Request["formData"]>>,
  deps: OAuthDeps,
): Promise<Response> {
  const code = String(form.get("code") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const codeVerifier = String(form.get("code_verifier") ?? "");
  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return jsonResponse(
      { error: "invalid_request", error_description: "missing required parameter" },
      400,
    );
  }
  const client = getClient(db, clientId);
  if (!client) {
    return jsonResponse({ error: "invalid_client", error_description: "unknown client_id" }, 401);
  }
  let redeemed: ReturnType<typeof redeemAuthCode>;
  try {
    redeemed = redeemAuthCode(db, { code, clientId, redirectUri, codeVerifier, now: deps.now });
  } catch (err) {
    return mapAuthCodeError(err);
  }
  // Scope-validation gate (cli#71). Reject any requested scope that the
  // issuer never declared — `FIRST_PARTY_SCOPES` ∪ each module's `module.json`
  // `scopes.defines`. Per RFC 6749 §5.2: `error: "invalid_scope"`. We add
  // `invalid_scopes: [...]` as an extension field so clients can report the
  // exact culprits without re-parsing the description string.
  const declared = (deps.loadDeclaredScopes ?? loadDeclaredScopes)();
  const unknown = findUnknownScopes(redeemed.scopes, declared);
  if (unknown.length > 0) {
    return jsonResponse(
      {
        error: "invalid_scope",
        error_description: `unknown scopes: ${unknown.join(", ")}`,
        invalid_scopes: unknown,
      },
      400,
    );
  }
  const audience = inferAudience(redeemed.scopes);
  const access = await signAccessToken(db, {
    sub: redeemed.userId,
    scopes: redeemed.scopes,
    audience,
    clientId: redeemed.clientId,
    issuer: deps.issuer,
    now: deps.now,
  });
  const refresh = signRefreshToken(db, {
    jti: access.jti,
    userId: redeemed.userId,
    clientId: redeemed.clientId,
    scopes: redeemed.scopes,
    now: deps.now,
  });
  return jsonResponse({
    access_token: access.token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.token,
    scope: redeemed.scopes.join(" "),
  });
}

async function handleTokenRefresh(
  db: Database,
  form: Awaited<ReturnType<Request["formData"]>>,
  deps: OAuthDeps,
): Promise<Response> {
  const refreshToken = String(form.get("refresh_token") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  if (!refreshToken || !clientId) {
    return jsonResponse(
      { error: "invalid_request", error_description: "missing required parameter" },
      400,
    );
  }
  const client = getClient(db, clientId);
  if (!client) {
    return jsonResponse({ error: "invalid_client", error_description: "unknown client_id" }, 401);
  }
  const row = findRefreshToken(db, refreshToken);
  if (!row) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "refresh_token not found" },
      400,
    );
  }
  if (row.clientId !== clientId) {
    return jsonResponse({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
  }
  if (row.revokedAt) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "refresh_token revoked" },
      400,
    );
  }
  const now = deps.now?.() ?? new Date();
  if (now.getTime() > new Date(row.expiresAt).getTime()) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "refresh_token expired" },
      400,
    );
  }
  // Rotate: revoke the old refresh row, mint a new access + refresh pair.
  db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ?").run(now.toISOString(), row.jti);
  const audience = inferAudience(row.scopes);
  const access = await signAccessToken(db, {
    sub: row.userId,
    scopes: row.scopes,
    audience,
    clientId: row.clientId,
    issuer: deps.issuer,
    now: deps.now,
  });
  const refresh = signRefreshToken(db, {
    jti: access.jti,
    userId: row.userId,
    clientId: row.clientId,
    scopes: row.scopes,
    now: deps.now,
  });
  return jsonResponse({
    access_token: access.token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.token,
    scope: row.scopes.join(" "),
  });
}

function mapAuthCodeError(err: unknown): Response {
  if (err instanceof AuthCodeNotFoundError) {
    return jsonResponse({ error: "invalid_grant", error_description: "code not found" }, 400);
  }
  if (err instanceof AuthCodeExpiredError) {
    return jsonResponse({ error: "invalid_grant", error_description: "code expired" }, 400);
  }
  if (err instanceof AuthCodeUsedError) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "code already redeemed" },
      400,
    );
  }
  if (err instanceof AuthCodePkceMismatchError) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "code_verifier mismatch" },
      400,
    );
  }
  if (err instanceof AuthCodeRedirectMismatchError) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "redirect_uri mismatch" },
      400,
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: "server_error", error_description: msg }, 500);
}

/**
 * Picks the JWT `aud` claim based on the requested scopes. `vault:*` →
 * "vault", `scribe:*` → "scribe", etc. Falls back to "hub" for hub-only
 * scopes or empty scopes. The split character is `:` per
 * `parachute-patterns/patterns/oauth-scopes.md`; the previous `.` form was
 * never canonical (cli#71 caught it during the scope-validation cutover).
 */
function inferAudience(scopes: string[]): string {
  for (const s of scopes) {
    const colon = s.indexOf(":");
    if (colon > 0) return s.slice(0, colon);
  }
  return "hub";
}

// --- /oauth/register -------------------------------------------------------

interface RegisterRequestBody {
  redirect_uris?: string[];
  scope?: string;
  client_name?: string;
  token_endpoint_auth_method?: string;
}

/**
 * POST /oauth/register — RFC 7591 Dynamic Client Registration. Self-serve.
 * Returns the assigned `client_id` (and `client_secret` for confidential
 * clients). The brief defers admin-gating; today, any caller gets a row.
 */
export async function handleRegister(
  db: Database,
  req: Request,
  deps: OAuthDeps,
): Promise<Response> {
  let body: RegisterRequestBody;
  try {
    body = (await req.json()) as RegisterRequestBody;
  } catch {
    return jsonResponse(
      { error: "invalid_client_metadata", error_description: "body must be JSON" },
      400,
    );
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    return jsonResponse(
      {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required and must be non-empty",
      },
      400,
    );
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isValidRedirectUri(uri)) {
      return jsonResponse(
        { error: "invalid_redirect_uri", error_description: `invalid redirect_uri "${uri}"` },
        400,
      );
    }
  }
  const confidential = body.token_endpoint_auth_method === "client_secret_post";
  const scopes = (body.scope ?? "").split(" ").filter((s) => s.length > 0);
  let registered: RegisteredClient;
  try {
    registered = registerClient(db, {
      redirectUris,
      scopes,
      clientName: body.client_name,
      confidential,
      now: deps.now,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: "invalid_client_metadata", error_description: msg }, 400);
  }
  const respBody: Record<string, unknown> = {
    client_id: registered.client.clientId,
    redirect_uris: registered.client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: confidential ? "client_secret_post" : "none",
    client_id_issued_at: Math.floor(new Date(registered.client.registeredAt).getTime() / 1000),
  };
  if (registered.client.scopes.length > 0) respBody.scope = registered.client.scopes.join(" ");
  if (registered.client.clientName) respBody.client_name = registered.client.clientName;
  if (registered.clientSecret) respBody.client_secret = registered.clientSecret;
  return jsonResponse(respBody, 201);
}

function consentProps(client: OAuthClient, params: AuthorizeFormParams) {
  return {
    params,
    clientId: client.clientId,
    clientName: client.clientName ?? client.clientId,
    scopes: params.scope.split(" ").filter((s) => s.length > 0),
  };
}

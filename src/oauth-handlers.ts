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
 * Login + consent screens are minimal HTML — functional, not pretty. PR (d)
 * is the polish pass.
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    scopes_supported: [],
  });
}

// --- /oauth/authorize ------------------------------------------------------

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string | null;
}

function parseAuthorizeParams(url: URL): AuthorizeParams | { error: string } {
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
  const parsed = parseAuthorizeParams(url);
  if ("error" in parsed) {
    return htmlResponse(`<h1>OAuth error</h1><p>${escapeHtml(parsed.error)}</p>`, 400);
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
    return htmlResponse("<h1>OAuth error</h1><p>unknown client_id</p>", 400);
  }
  try {
    requireRegisteredRedirectUri(client, parsed.redirectUri);
  } catch {
    return htmlResponse(
      "<h1>OAuth error</h1><p>redirect_uri is not registered for this client</p>",
      400,
    );
  }

  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? findSession(db, sessionId) : null;
  if (!session) {
    return htmlResponse(renderLoginForm(parsed));
  }
  return htmlResponse(renderConsentScreen(client, parsed));
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
  return htmlResponse("<h1>OAuth error</h1><p>unknown form action</p>", 400);
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
    return htmlResponse(renderLoginForm(params, "username and password are required"), 400);
  }
  const user = getUserByUsername(db, username);
  if (!user) {
    return htmlResponse(renderLoginForm(params, "invalid credentials"), 401);
  }
  const ok = await verifyPassword(user, password);
  if (!ok) {
    return htmlResponse(renderLoginForm(params, "invalid credentials"), 401);
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
    return htmlResponse(renderLoginForm(params, "session expired; please sign in again"), 401);
  }
  const client = getClient(db, params.clientId);
  if (!client) return htmlResponse("<h1>OAuth error</h1><p>unknown client_id</p>", 400);
  try {
    requireRegisteredRedirectUri(client, params.redirectUri);
  } catch {
    return htmlResponse("<h1>OAuth error</h1><p>redirect_uri mismatch</p>", 400);
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

function paramsFromForm(form: Awaited<ReturnType<Request["formData"]>>): AuthorizeParams {
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

function authorizeParamsToQuery(p: AuthorizeParams): Record<string, string> {
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
  const audience = inferAudience(redeemed.scopes);
  const access = await signAccessToken(db, {
    sub: redeemed.userId,
    scopes: redeemed.scopes,
    audience,
    clientId: redeemed.clientId,
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
 * Picks the JWT `aud` claim based on the requested scopes. `vault.*` →
 * "vault", `notes.*` → "notes", etc. Falls back to "hub" for hub-only
 * scopes or empty scopes. This will become a more deliberate scope
 * registry in PR (d) / cli#56; for now, prefix-match is enough.
 */
function inferAudience(scopes: string[]): string {
  for (const s of scopes) {
    const dot = s.indexOf(".");
    if (dot > 0) return s.slice(0, dot);
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

// --- HTML templates --------------------------------------------------------

function renderLoginForm(params: AuthorizeParams, errorMessage?: string): string {
  const hidden = renderHiddenInputs(params);
  const err = errorMessage ? `<p class="err">${escapeHtml(errorMessage)}</p>` : "";
  return baseDocument(
    "Sign in to Parachute Hub",
    `
    <h1>Sign in</h1>
    ${err}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="__action" value="login" />
      ${hidden}
      <label>Username<br/><input type="text" name="username" autofocus required /></label>
      <label>Password<br/><input type="password" name="password" required /></label>
      <button type="submit">Sign in</button>
    </form>
    `,
  );
}

function renderConsentScreen(client: OAuthClient, params: AuthorizeParams): string {
  const hidden = renderHiddenInputs(params);
  const scopes = params.scope.split(" ").filter((s) => s.length > 0);
  const clientName = client.clientName ?? client.clientId;
  const scopeList =
    scopes.length === 0
      ? "<li>(no scopes requested)</li>"
      : scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("");
  return baseDocument(
    `Authorize ${escapeHtml(clientName)}`,
    `
    <h1>Authorize <code>${escapeHtml(clientName)}</code>?</h1>
    <p>This app is requesting access to your Parachute account with the following scopes:</p>
    <ul>${scopeList}</ul>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="__action" value="consent" />
      ${hidden}
      <button type="submit" name="approve" value="yes">Approve</button>
      <button type="submit" name="approve" value="no">Deny</button>
    </form>
    `,
  );
}

function renderHiddenInputs(p: AuthorizeParams): string {
  const fields: [string, string][] = [
    ["client_id", p.clientId],
    ["redirect_uri", p.redirectUri],
    ["response_type", p.responseType],
    ["scope", p.scope],
    ["code_challenge", p.codeChallenge],
    ["code_challenge_method", p.codeChallengeMethod],
  ];
  if (p.state) fields.push(["state", p.state]);
  return fields
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}" />`)
    .join("\n      ");
}

function baseDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; }
    label { display: block; margin: 0.75rem 0; }
    input[type=text], input[type=password] { width: 100%; padding: 0.5rem; box-sizing: border-box; }
    button { padding: 0.5rem 1rem; margin-right: 0.5rem; }
    .err { color: #b00020; }
    code { background: #f3f3f3; padding: 0 0.25rem; border-radius: 3px; }
    ul { padding-left: 1.25rem; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

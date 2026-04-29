/**
 * CSRF protection for state-changing admin POSTs (login, consent, and any
 * future admin form mounted off `/`).
 *
 * Pattern: double-submit cookie. On every GET that renders a form, we ensure
 * a `parachute_hub_csrf` cookie exists (lazily generated, then reused for the
 * cookie's lifetime) and embed the same value as a hidden `__csrf` input in
 * the form. On POST, we compare the form-submitted token to the cookie value
 * via constant-time compare; mismatch = 400 Bad Request. We pick 400 over 403
 * because the failure mode is a malformed/stale form (the operator's tab sat
 * past cookie expiry, two tabs raced, or the form was hand-rolled), not an
 * authorization failure — they're already authenticated; the *form* is what
 * the server can't accept. All callers (admin login, admin config, OAuth
 * authorize) agree on 400.
 *
 * Why this and not session-bound tokens? Login forms are submitted *before*
 * a session exists, so a session-bound CSRF would need a separate "pre-login"
 * track anyway. Double-submit is uniform across both — same helper handles
 * pre-login and post-login forms, and it works no matter how many tabs the
 * operator has open.
 *
 * The cookie is HttpOnly (the form doesn't need JS to read it; the server
 * embeds the value at render time), SameSite=Lax (matches the session
 * cookie), Secure, and Path=/ (covers every admin form, OAuth or otherwise).
 *
 * Token entropy: 32 random bytes, base64url-encoded — same shape as session
 * IDs. No HMAC needed: the value is opaque to the client and only ever
 * compared to itself across the cookie/form boundary.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export const CSRF_COOKIE_NAME = "parachute_hub_csrf";
export const CSRF_FIELD_NAME = "__csrf";
/** 30 days. Cookie outlives the 24h session by design — closing the OAuth
 * tab and reopening it later shouldn't force a re-mint of the CSRF token. */
export const CSRF_TTL_SECONDS = 30 * 24 * 60 * 60;

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function buildCsrfCookie(token: string): string {
  return [
    `${CSRF_COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${CSRF_TTL_SECONDS}`,
  ].join("; ");
}

export function parseCsrfCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CSRF_COOKIE_NAME) return rest.join("=");
  }
  return null;
}

export interface EnsuredCsrf {
  token: string;
  /** Set when the caller must include this Set-Cookie on the response. */
  setCookie?: string;
}

/**
 * Ensure the request carries a CSRF token cookie; mint and return one if not.
 * Callers embed `result.token` in the rendered form and attach
 * `result.setCookie` (if defined) to the response.
 */
export function ensureCsrfToken(req: Request): EnsuredCsrf {
  const existing = parseCsrfCookie(req.headers.get("cookie"));
  if (existing && existing.length > 0) return { token: existing };
  const token = generateCsrfToken();
  return { token, setCookie: buildCsrfCookie(token) };
}

/**
 * Verify that a form-submitted CSRF token matches the cookie token via
 * constant-time compare. Both must be present and equal.
 */
export function verifyCsrfToken(req: Request, formToken: string | null): boolean {
  const cookieToken = parseCsrfCookie(req.headers.get("cookie"));
  if (!cookieToken || !formToken) return false;
  if (cookieToken.length !== formToken.length) return false;
  try {
    return timingSafeEqual(Buffer.from(cookieToken), Buffer.from(formToken));
  } catch {
    return false;
  }
}

export function renderCsrfHiddenInput(token: string): string {
  return `<input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeAttr(token)}" />`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

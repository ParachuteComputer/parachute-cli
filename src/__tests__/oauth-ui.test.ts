import { describe, expect, test } from "bun:test";
import {
  type AuthorizeFormParams,
  escapeHtml,
  renderConsent,
  renderError,
  renderHiddenInputs,
  renderLogin,
} from "../oauth-ui.ts";

const PARAMS: AuthorizeFormParams = {
  clientId: "client-abc",
  redirectUri: "https://app.example/cb",
  responseType: "code",
  scope: "vault:read vault:admin",
  codeChallenge: "ch",
  codeChallengeMethod: "S256",
  state: "xyz",
};

const CSRF = "csrf-token-fixture";

describe("escapeHtml", () => {
  test("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<script>alert("x&y'z")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&amp;y&#39;z&quot;)&lt;/script&gt;",
    );
  });
});

describe("renderHiddenInputs", () => {
  test("emits one hidden input per non-state field, plus state when present", () => {
    const html = renderHiddenInputs(PARAMS);
    expect(html).toContain('name="client_id" value="client-abc"');
    expect(html).toContain('name="redirect_uri" value="https://app.example/cb"');
    expect(html).toContain('name="response_type" value="code"');
    expect(html).toContain('name="scope" value="vault:read vault:admin"');
    expect(html).toContain('name="code_challenge" value="ch"');
    expect(html).toContain('name="code_challenge_method" value="S256"');
    expect(html).toContain('name="state" value="xyz"');
  });

  test("omits state input when state is null", () => {
    const html = renderHiddenInputs({ ...PARAMS, state: null });
    expect(html).not.toContain('name="state"');
  });

  test("escapes hostile values into hidden inputs", () => {
    const html = renderHiddenInputs({ ...PARAMS, state: `"><script>alert(1)</script>` });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderLogin", () => {
  test("contains form, hidden inputs, and a Sign in submit", () => {
    const html = renderLogin({ params: PARAMS, csrfToken: CSRF });
    expect(html).toContain('action="/oauth/authorize"');
    expect(html).toContain('name="__action" value="login"');
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).toContain("Sign in");
    // Hidden state echoed
    expect(html).toContain('name="state" value="xyz"');
    // Brand styling present
    expect(html).toContain("Parachute");
  });

  test("renders an error banner when errorMessage is set", () => {
    const html = renderLogin({ params: PARAMS, csrfToken: CSRF, errorMessage: "bad pw" });
    expect(html).toContain("error-banner");
    expect(html).toContain("bad pw");
  });

  test("escapes the error message", () => {
    const html = renderLogin({
      params: PARAMS,
      csrfToken: CSRF,
      errorMessage: "<script>x</script>",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderConsent", () => {
  test("shows client name, client_id, and a row per scope", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "client-abc",
      clientName: "MyApp",
      scopes: ["vault:read", "vault:admin"],
    });
    expect(html).toContain("Authorize");
    expect(html).toContain("MyApp");
    expect(html).toContain("client-abc");
    expect(html).toContain("vault:read");
    expect(html).toContain("vault:admin");
    // Scope explanations from the registry
    expect(html).toContain("Read your notes");
    expect(html).toContain("Full vault access");
  });

  test("highlights admin scopes with a danger color and badge", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:admin"],
    });
    expect(html).toContain("scope-admin");
    expect(html).toContain("badge-admin");
  });

  test("renders unknown scopes verbatim with a muted explanation", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["mystery.module:do-thing"],
    });
    expect(html).toContain("scope-unknown");
    expect(html).toContain("mystery.module:do-thing");
    expect(html).toContain("no built-in description");
  });

  test("renders a placeholder when no scopes are requested", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: [],
    });
    expect(html).toContain("scope-empty");
    expect(html).toContain("No scopes requested");
  });

  test("includes Approve and Deny buttons posting __action=consent", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: [],
    });
    expect(html).toContain('name="__action" value="consent"');
    expect(html).toContain('name="approve" value="yes"');
    expect(html).toContain('name="approve" value="no"');
  });

  test("escapes a hostile client name", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "<img src=x onerror=alert(1)>",
      scopes: [],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("renders a vault picker when vaultPicker is set", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read"],
      vaultPicker: { unnamedVerbs: ["read"], availableVaults: ["work", "personal"] },
    });
    expect(html).toContain("Pick a vault");
    expect(html).toContain('name="vault_pick" value="work"');
    expect(html).toContain('name="vault_pick" value="personal"');
    // First option pre-checked so a single-vault host doesn't force a click.
    expect(html).toMatch(/name="vault_pick" value="work" checked/);
  });

  test("escapes a hostile vault name in the picker", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read"],
      vaultPicker: {
        unnamedVerbs: ["read"],
        availableVaults: [`evil"><script>alert(1)</script>`],
      },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("disables the Approve button when no vaults exist", () => {
    const html = renderConsent({
      params: PARAMS,
      csrfToken: CSRF,
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read"],
      vaultPicker: { unnamedVerbs: ["read"], availableVaults: [] },
    });
    expect(html).toContain("no vaults exist");
    expect(html).toContain('value="yes" class="btn btn-primary" disabled');
  });
});

describe("renderError", () => {
  test("renders a card with title and message", () => {
    const html = renderError({ title: "Boom", message: "something blew up", status: 400 });
    expect(html).toContain("Boom");
    expect(html).toContain("something blew up");
    expect(html).toContain('class="card"');
    // Brand mark visible so the user knows where they are
    expect(html).toContain("Parachute");
  });

  test("escapes hostile title + message", () => {
    const html = renderError({
      title: "<script>1</script>",
      message: '"><img>',
      status: 400,
    });
    expect(html).not.toContain("<script>1</script>");
    expect(html).not.toContain('"><img>');
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("CSS / styling guarantees", () => {
  test("does not load fonts from a third-party CDN (privacy)", () => {
    const html = renderLogin({ params: PARAMS, csrfToken: CSRF });
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
  });

  test("sets referrer policy to no-referrer", () => {
    expect(renderLogin({ params: PARAMS, csrfToken: CSRF })).toContain(
      'name="referrer" content="no-referrer"',
    );
  });

  test("declares mobile-friendly viewport", () => {
    expect(renderLogin({ params: PARAMS, csrfToken: CSRF })).toContain(
      'name="viewport" content="width=device-width, initial-scale=1"',
    );
  });
});

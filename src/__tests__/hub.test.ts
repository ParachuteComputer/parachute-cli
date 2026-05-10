import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHub, writeHubFile } from "../hub.ts";

describe("renderHub", () => {
  const html = renderHub();

  test("is a self-contained HTML document with inline styles and script", () => {
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });

  test("fetches /.well-known/parachute.json for the Use section", () => {
    expect(html).toContain("/.well-known/parachute.json");
    expect(html).toContain("doc.services");
  });

  test("uses parachute.computer sage palette and serif/sans fonts", () => {
    expect(html).toContain("#4a7c59");
    expect(html).toContain("#faf8f4");
    expect(html).toContain("Instrument Serif");
    expect(html).toContain("DM Sans");
  });

  test("supports prefers-color-scheme dark", () => {
    expect(html).toContain("prefers-color-scheme: dark");
  });

  test("renders two sections: Services and Admin, each with its own heading + grid", () => {
    expect(html).toContain('id="services-section"');
    expect(html).toContain('id="admin-section"');
    expect(html).toContain('id="services-grid"');
    expect(html).toContain('id="admin-grid"');
    expect(html).toContain("<h2>Services</h2>");
    expect(html).toContain("<h2>Admin</h2>");
  });

  test("Services section sub-text frames the section as service-owned surfaces", () => {
    // Services-vs-Admin axis is OWNERSHIP (services own their UIs vs
    // hub owns host admin), not function. The sub-text reflects that —
    // earlier "Browse, transcribe, and run" framing put it on the
    // function axis, which broke down once you noticed services have
    // UIs that mix use / config / admin.
    expect(html).toContain("Surfaces provided by services");
  });

  test("Services entry labels: Notes / Scribe / Agent", () => {
    expect(html).toContain("'Notes'");
    expect(html).toContain("'Scribe'");
    expect(html).toContain("'Agent'");
  });

  test("Services entries use the path declared in services.json (custom mounts work)", () => {
    // Operators may mount a service at a non-default path; the tile
    // surfaces that path verbatim rather than hardcoding `/notes`/etc.
    expect(html).toContain("svc.path");
  });

  test("Vault is intentionally excluded from the Services section", () => {
    // Aaron's friction: clicking 'Vault' on discovery took him to hub
    // management, not to vault content. Resolution: Vault has no
    // Services entry — its content is browsed via Notes (which has its
    // own entry). Vault provisioning lives under Admin.
    expect(html).toContain("Vault deliberately omitted");
    expect(html).toContain("isVaultName");
  });

  test("Services section ordering is notes → scribe → agent", () => {
    expect(html).toContain("['notes', 'scribe', 'agent']");
  });

  test("Admin section is hardcoded (always visible) with three entries", () => {
    expect(html).toContain("ADMIN_ENTRIES");
    expect(html).toContain("/admin/vaults");
    expect(html).toContain("/admin/permissions");
    expect(html).toContain("/admin/tokens");
  });

  test("Admin section renders synchronously (does not depend on the well-known fetch)", () => {
    // Even if the fetch is slow or fails, the operator should see Admin
    // surfaces — they may be the reason the operator landed on /.
    expect(html).toContain("renderAdmin();");
    expect(html).toContain("Admin section is static");
  });

  test("Use section empty state hints at install", () => {
    expect(html).toContain("No services installed yet");
    expect(html).toContain("parachute install vault");
  });

  test("Use section error state surfaces the underlying message", () => {
    expect(html).toContain("Could not load services");
  });

  test("does not retain the old aggregate-by-module-type code", () => {
    // The Vault collapse + per-module aggregation pattern is gone — Use
    // entries are direct service-path → label lookups; Admin is hardcoded.
    expect(html).not.toContain("aggregate(services, vaults)");
    expect(html).not.toContain("MODULE_LABELS");
    expect(html).not.toContain("renderConfigField");
    expect(html).not.toContain("kind-badge");
  });

  test("default render (no session) emits the 'Sign in' affordance", () => {
    expect(html).toContain('class="auth-indicator"');
    expect(html).toContain("Sign in");
    expect(html).toContain('href="/login?next=/"');
    // No POST form, no CSRF input — those only appear when signed in.
    expect(html).not.toContain('action="/logout"');
    expect(html).not.toContain("__csrf");
  });
});

describe("renderHub — signed-in indicator (rc.13)", () => {
  test("session user → 'Signed in as <name>' + inline POST form with CSRF", () => {
    const html = renderHub({
      session: { displayName: "aaron", csrfToken: "csrf-token-xyz" },
    });
    expect(html).toContain('class="auth-indicator"');
    expect(html).toContain("Signed in as");
    expect(html).toContain("aaron");
    // Inline POST form for sign-out — CSRF token embedded as the
    // existing `__csrf` field name (matches /logout's expectations).
    expect(html).toContain('method="POST" action="/logout"');
    expect(html).toContain('name="__csrf"');
    expect(html).toContain('value="csrf-token-xyz"');
    expect(html).toContain("Sign out");
    // No "Sign in" affordance when signed in.
    expect(html).not.toContain('href="/login?next=/"');
  });

  test("displayName with HTML special chars is escaped", () => {
    // Username field allows alphanumerics historically, but the
    // displayName field on the wire is forward-compatible with profile
    // names that may contain &, <, >. Escape at render time.
    const html = renderHub({
      session: { displayName: "<aaron>&friends", csrfToken: "tok" },
    });
    expect(html).toContain("&lt;aaron&gt;&amp;friends");
    expect(html).not.toContain("<aaron>&friends");
  });

  test("CSRF token with HTML special chars is escaped in the value attribute", () => {
    const html = renderHub({
      session: { displayName: "aaron", csrfToken: 'token"with"quotes' },
    });
    expect(html).toContain('value="token&quot;with&quot;quotes"');
  });
});

describe("writeHubFile", () => {
  test("writes the rendered HTML to the given path, creating parent dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-hub-"));
    try {
      const path = join(dir, "well-known", "hub.html");
      const written = writeHubFile(path);
      expect(written).toBe(path);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf8");
      expect(content).toBe(renderHub());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

  test("fetches /.well-known/parachute.json and iterates services[]", () => {
    expect(html).toContain("/.well-known/parachute.json");
    expect(html).toContain("doc.services");
    expect(html).toContain("infoUrl");
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

  test("falls back to a generic icon when service has none", () => {
    expect(html).toContain("fallbackIcon");
  });

  test("branches card rendering on info.kind (api/tool → interactive, else link)", () => {
    // Script picks the element type and wires up toggling based on info.kind.
    expect(html).toContain("isInteractiveKind");
    expect(html).toContain("'api'");
    expect(html).toContain("'tool'");
    expect(html).toContain("'frontend'");
  });

  test("interactive cards get keyboard + aria affordances", () => {
    expect(html).toContain("role");
    expect(html).toContain("tabindex");
    expect(html).toContain("aria-expanded");
    expect(html).toContain("Enter");
  });

  test("detail panel surfaces OAuth discovery, MCP, open-in-Notes, service URL", () => {
    expect(html).toContain("/.well-known/oauth-authorization-server");
    expect(html).toContain("info.mcpUrl");
    expect(html).toContain("info.openInNotesUrl");
    expect(html).toContain("Service URL");
    expect(html).toContain("OAuth discovery");
  });

  test("details panel is hidden until the card is expanded", () => {
    expect(html).toContain(".details {");
    expect(html).toContain("display: none");
    expect(html).toContain(".card.expanded .details");
  });

  test("lazy-fetches /.parachute/config/schema + /.parachute/config on first expand", () => {
    expect(html).toContain("fetchConfig");
    expect(html).toContain("/.parachute/config/schema");
    expect(html).toContain("/.parachute/config");
    // Lazy: fetch happens inside the toggle, guarded by configLoaded.
    expect(html).toContain("configLoaded");
  });

  test("renders config form fields with disabled inputs (read-only in this launch)", () => {
    expect(html).toContain("renderConfigField");
    expect(html).toContain("input.disabled = true");
    expect(html).toContain("aria-readonly");
    // Hint text tells users where to edit instead.
    expect(html).toContain("read-only in this launch");
  });

  test("config field types: enum→select, boolean→checkbox, number→number, uri→url", () => {
    expect(html).toContain("schema.enum");
    expect(html).toContain("'checkbox'");
    expect(html).toContain("'number'");
    expect(html).toContain("'url'");
  });

  test("writeOnly fields render a bullet placeholder instead of the raw value", () => {
    expect(html).toContain("writeOnly");
    // Six bullets as the placeholder (template literal resolves \u2022 → •).
    expect(html).toContain("\u2022\u2022\u2022\u2022\u2022\u2022");
  });

  test("schema 404 path renders nothing (no error surfaced)", () => {
    // fetchConfig returns null on non-ok; caller skips render.
    expect(html).toContain("if (!schemaResp || !schemaResp.ok) return null");
    expect(html).toContain("if (data)");
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

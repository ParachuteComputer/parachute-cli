import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lensFetch, normalizeMount } from "../lens-serve.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-lens-serve-"));
  writeFileSync(join(dir, "index.html"), "<html><body>lens spa</body></html>");
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('install', () => {});");
  writeFileSync(join(dir, "manifest.webmanifest"), '{"name":"Lens","start_url":"/lens/"}');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function req(path: string): Request {
  return new Request(`http://127.0.0.1${path}`);
}

describe("normalizeMount", () => {
  test("strips trailing slashes", () => {
    expect(normalizeMount("/lens/")).toBe("/lens");
    expect(normalizeMount("/lens")).toBe("/lens");
    expect(normalizeMount("/lens///")).toBe("/lens");
  });

  test("collapses root-equivalents to empty string", () => {
    expect(normalizeMount("")).toBe("");
    expect(normalizeMount("/")).toBe("");
  });
});

describe("lensFetch with default /lens mount", () => {
  test("GET /lens/sw.js serves the SW with JS content-type, not text/html", async () => {
    const h = makeHarness();
    try {
      const res = lensFetch(h.dir, "/lens")(req("/lens/sw.js"));
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).not.toContain("text/html");
      expect(ct).toMatch(/javascript/);
      expect(await res.text()).toContain("addEventListener");
    } finally {
      h.cleanup();
    }
  });

  test("GET /lens/manifest.webmanifest serves application/manifest+json", async () => {
    const h = makeHarness();
    try {
      const res = lensFetch(h.dir, "/lens")(req("/lens/manifest.webmanifest"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/manifest+json");
      expect(await res.text()).toContain('"name":"Lens"');
    } finally {
      h.cleanup();
    }
  });

  test("GET /lens/ serves the SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = lensFetch(h.dir, "/lens")(req("/lens/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("lens spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /lens (no trailing slash) serves the SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = lensFetch(h.dir, "/lens")(req("/lens"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("lens spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /lens/nonexistent/deep/route falls back to SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = lensFetch(h.dir, "/lens")(req("/lens/nonexistent/deep/route"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("lens spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /lensx/foo (mount-prefix collision) is not stripped", async () => {
    // Guards against startsWith("/lens") matching unrelated /lensx routes.
    const h = makeHarness();
    try {
      const res = lensFetch(h.dir, "/lens")(req("/lensx/foo"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    } finally {
      h.cleanup();
    }
  });
});

describe("lensFetch with empty mount (root deployment)", () => {
  test("GET /sw.js serves the SW directly", async () => {
    const h = makeHarness();
    try {
      const res = lensFetch(h.dir, "")(req("/sw.js"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toMatch(/javascript/);
    } finally {
      h.cleanup();
    }
  });

  test("GET / serves the SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = lensFetch(h.dir, "")(req("/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    } finally {
      h.cleanup();
    }
  });
});

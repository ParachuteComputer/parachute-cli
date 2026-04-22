import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMount, notesFetch } from "../notes-serve.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-notes-serve-"));
  writeFileSync(join(dir, "index.html"), "<html><body>notes spa</body></html>");
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('install', () => {});");
  writeFileSync(join(dir, "manifest.webmanifest"), '{"name":"Notes","start_url":"/notes/"}');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function req(path: string): Request {
  return new Request(`http://127.0.0.1${path}`);
}

describe("normalizeMount", () => {
  test("strips trailing slashes", () => {
    expect(normalizeMount("/notes/")).toBe("/notes");
    expect(normalizeMount("/notes")).toBe("/notes");
    expect(normalizeMount("/notes///")).toBe("/notes");
  });

  test("collapses root-equivalents to empty string", () => {
    expect(normalizeMount("")).toBe("");
    expect(normalizeMount("/")).toBe("");
  });
});

describe("notesFetch with default /notes mount", () => {
  test("GET /notes/sw.js serves the SW with JS content-type, not text/html", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notes/sw.js"));
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).not.toContain("text/html");
      expect(ct).toMatch(/javascript/);
      expect(await res.text()).toContain("addEventListener");
    } finally {
      h.cleanup();
    }
  });

  test("GET /notes/manifest.webmanifest serves application/manifest+json", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notes/manifest.webmanifest"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/manifest+json");
      expect(await res.text()).toContain('"name":"Notes"');
    } finally {
      h.cleanup();
    }
  });

  test("GET /notes/ serves the SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notes/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("notes spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /notes (no trailing slash) serves the SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notes"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("notes spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /notes/nonexistent/deep/route falls back to SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notes/nonexistent/deep/route"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("notes spa");
    } finally {
      h.cleanup();
    }
  });

  test("GET /notesx/foo (mount-prefix collision) is not stripped", async () => {
    // Guards against startsWith("/notes") matching unrelated /notesx routes.
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "/notes")(req("/notesx/foo"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    } finally {
      h.cleanup();
    }
  });
});

describe("notesFetch with empty mount (root deployment)", () => {
  test("GET /sw.js serves the SW directly", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "")(req("/sw.js"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toMatch(/javascript/);
    } finally {
      h.cleanup();
    }
  });

  test("GET / serves the SPA shell", async () => {
    const h = makeHarness();
    try {
      const res = notesFetch(h.dir, "")(req("/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    } finally {
      h.cleanup();
    }
  });
});

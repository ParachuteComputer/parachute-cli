import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubFetch } from "../hub-server.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-hub-server-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function req(path: string): Request {
  return new Request(`http://127.0.0.1/${path.replace(/^\//, "")}`);
}

describe("hubFetch routing", () => {
  test("/ serves hub.html with text/html content-type", async () => {
    const h = makeHarness();
    try {
      writeFileSync(join(h.dir, "hub.html"), "<html><body>hi</body></html>");
      const res = hubFetch(h.dir)(req("/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("<html>");
    } finally {
      h.cleanup();
    }
  });

  test("/hub.html serves the same file as /", async () => {
    const h = makeHarness();
    try {
      writeFileSync(join(h.dir, "hub.html"), "<html>x</html>");
      const res = hubFetch(h.dir)(req("/hub.html"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<html>x</html>");
    } finally {
      h.cleanup();
    }
  });

  test("/.well-known/parachute.json serves JSON with application/json", async () => {
    const h = makeHarness();
    try {
      writeFileSync(join(h.dir, "parachute.json"), '{"vaults":[]}\n');
      const res = hubFetch(h.dir)(req("/.well-known/parachute.json"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.text()).toBe('{"vaults":[]}\n');
    } finally {
      h.cleanup();
    }
  });

  test("unknown paths return 404", async () => {
    const h = makeHarness();
    try {
      writeFileSync(join(h.dir, "hub.html"), "<html/>");
      const res = hubFetch(h.dir)(req("/nope"));
      expect(res.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  test("missing hub.html returns 404 rather than crashing", async () => {
    const h = makeHarness();
    try {
      // dir exists but no files in it
      const res = hubFetch(h.dir)(req("/"));
      expect(res.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  test("missing parachute.json returns 404 rather than crashing", async () => {
    const h = makeHarness();
    try {
      const res = hubFetch(h.dir)(req("/.well-known/parachute.json"));
      expect(res.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  test("live Bun.serve round-trip: / and /.well-known resolve", async () => {
    const h = makeHarness();
    try {
      writeFileSync(join(h.dir, "hub.html"), "<html>live</html>");
      writeFileSync(join(h.dir, "parachute.json"), '{"services":[]}');
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: hubFetch(h.dir) });
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const r1 = await fetch(`${base}/`);
        expect(r1.status).toBe(200);
        expect(await r1.text()).toBe("<html>live</html>");
        const r2 = await fetch(`${base}/.well-known/parachute.json`);
        expect(r2.headers.get("content-type")).toBe("application/json");
        expect(await r2.json()).toEqual({ services: [] });
      } finally {
        server.stop(true);
      }
    } finally {
      h.cleanup();
    }
  });
});

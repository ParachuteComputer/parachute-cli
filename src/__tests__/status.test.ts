import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { status } from "../commands/status.ts";
import { upsertService } from "../services-manifest.ts";

function makeTempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-status-"));
  return {
    path: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("status", () => {
  test("empty manifest prints hint and exits 0", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toMatch(/No services installed/);
    } finally {
      cleanup();
    }
  });

  test("all-healthy returns 0 and prints table", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      upsertService(
        {
          name: "parachute-scribe",
          port: 3200,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.1.0",
        },
        path,
      );
      const seen: string[] = [];
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        fetchImpl: async (url) => {
          seen.push(String(url));
          return new Response(null, { status: 200 });
        },
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(seen).toContain("http://localhost:1940/health");
      expect(seen).toContain("http://localhost:3200/scribe/health");
      expect(lines[0]).toMatch(/SERVICE/);
      expect(lines.some((l) => l.includes("parachute-vault"))).toBe(true);
      expect(lines.some((l) => l.includes("ok"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("any-failing returns 1", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
        print: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.some((l) => l.includes("ECONNREFUSED"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("http non-2xx counts as unhealthy with status code", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 503 }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.some((l) => l.includes("http 503"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

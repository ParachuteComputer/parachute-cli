import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { status } from "../commands/status.ts";
import { writePid } from "../process-state.ts";
import { upsertService } from "../services-manifest.ts";

function makeTempPath(): { path: string; cleanup: () => void; configDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-status-"));
  return {
    path: join(dir, "services.json"),
    configDir: dir,
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

  test("running process shows pid + uptime and still probes", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      writePid("vault", 4242, configDir);
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        configDir,
        alive: () => true,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines.some((l) => l.includes("running"))).toBe(true);
      expect(lines.some((l) => l.includes("4242"))).toBe(true);
      expect(lines.some((l) => l.includes("ok"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("known-stopped process skips probe and doesn't fail exit", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      writePid("vault", 4242, configDir);
      let probed = false;
      const lines: string[] = [];
      const code = await status({
        manifestPath: path,
        configDir,
        alive: () => false,
        fetchImpl: async () => {
          probed = true;
          return new Response(null, { status: 200 });
        },
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(probed).toBe(false);
      expect(lines.some((l) => l.includes("stopped"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("unknown process state (no pid file) still probes — externally managed OK", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        path,
      );
      let probed = false;
      const code = await status({
        manifestPath: path,
        configDir,
        fetchImpl: async () => {
          probed = true;
          return new Response(null, { status: 200 });
        },
        print: () => {},
      });
      expect(code).toBe(0);
      expect(probed).toBe(true);
    } finally {
      cleanup();
    }
  });

  // URL column: the launch-day pain was a user staring at the table not
  // knowing where to point Claude.ai or curl. Each row gets a "  → URL"
  // continuation line so the next step is obvious.
  test("vault row prints MCP URL beneath it (path + /mcp suffix)", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        path,
      );
      const lines: string[] = [];
      await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l.includes("→ http://127.0.0.1:1940/vault/default/mcp"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("scribe row prints root URL (API is at /, ignore path prefix)", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "parachute-scribe",
          port: 1943,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.1.0",
        },
        path,
      );
      const lines: string[] = [];
      await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l === "  → http://127.0.0.1:1943")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("notes row prints UI URL (port + /notes mount)", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "parachute-notes",
          port: 1942,
          paths: ["/notes"],
          health: "/notes/health",
          version: "0.0.1",
        },
        path,
      );
      const lines: string[] = [];
      await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l === "  → http://127.0.0.1:1942/notes")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("channel row prints port + /channel mount", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "parachute-channel",
          port: 1941,
          paths: ["/channel"],
          health: "/channel/health",
          version: "0.1.0",
        },
        path,
      );
      const lines: string[] = [];
      await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l === "  → http://127.0.0.1:1941/channel")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("unknown service falls back to bare host:port + paths[0]", async () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "third-party-thing",
          port: 9000,
          paths: ["/widget"],
          health: "/health",
          version: "1.0.0",
        },
        path,
      );
      const lines: string[] = [];
      await status({
        manifestPath: path,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l === "  → http://127.0.0.1:9000/widget")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("stopped services still render a URL line so the user knows where to point clients post-start", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        path,
      );
      writePid("vault", 4242, configDir);
      const lines: string[] = [];
      await status({
        manifestPath: path,
        configDir,
        alive: () => false,
        fetchImpl: async () => new Response(null, { status: 200 }),
        print: (l) => lines.push(l),
      });
      expect(lines.some((l) => l.includes("→ http://127.0.0.1:1940/vault/default/mcp"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

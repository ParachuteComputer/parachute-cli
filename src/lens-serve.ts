#!/usr/bin/env bun

/**
 * Tiny static-file server for the @openparachute/lens PWA bundle.
 *
 * Lens is a SPA — no backend of its own. `parachute start lens` invokes
 * this shim with the installed `dist/` path so the PWA is served at a
 * known port and can be reverse-proxied by `parachute expose` alongside
 * the other services.
 *
 * Invoked as:
 *   bun <this-file> --port <n> [--dist <path>]
 *
 * If --dist is omitted, we resolve @openparachute/lens's dist directory
 * via Bun.resolveSync. If that fails (package not installed globally, or
 * package doesn't ship dist/), exit 1 with a clear error.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function parseArgs(argv: string[]): { port: number; dist?: string } {
  let port = 5173;
  let dist: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const v = argv[++i];
      if (!v) throw new Error("--port requires a value");
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new Error(`--port must be 1..65535, got "${v}"`);
      }
      port = n;
    } else if (a === "--dist") {
      const v = argv[++i];
      if (!v) throw new Error("--dist requires a value");
      dist = resolve(v);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { port, dist };
}

function resolveLensDist(): string {
  const pkgPath = Bun.resolveSync("@openparachute/lens/package.json", process.cwd());
  const root = dirname(pkgPath);
  const dist = join(root, "dist");
  if (!existsSync(dist)) {
    throw new Error(
      `@openparachute/lens is installed but has no dist/ directory at ${dist}. The package may not ship a prebuilt bundle — ask the lens maintainer to add a prepublishOnly build step.`,
    );
  }
  return dist;
}

const { port, dist: distArg } = parseArgs(process.argv.slice(2));

let dist: string;
try {
  dist = distArg ?? resolveLensDist();
} catch (err) {
  console.error(`parachute-lens-serve: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const indexHtml = join(dist, "index.html");

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    const filePath = join(dist, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(dist)) {
      return new Response("forbidden", { status: 403 });
    }
    const file = Bun.file(filePath);
    if (existsSync(filePath) && !filePath.endsWith("/")) {
      return new Response(file);
    }
    return new Response(Bun.file(indexHtml), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`lens static-serve listening on :${port} (dist=${dist})`);

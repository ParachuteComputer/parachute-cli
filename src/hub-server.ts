#!/usr/bin/env bun

/**
 * Localhost HTTP backing for the hub page.
 *
 * macOS `tailscaled` runs sandboxed and cannot read files under arbitrary
 * user paths — `tailscale serve … --set-path=/ <file>` returns "an error
 * occurred reading the file or directory". The reliable shape is HTTP proxy:
 * `tailscale serve … --set-path=/ http://127.0.0.1:<port>`. This shim is
 * that localhost backing.
 *
 * Routes (all bound to 127.0.0.1):
 *   /                          → hub.html                (text/html)
 *   /hub.html                  → hub.html                (text/html)
 *   /.well-known/parachute.json → parachute.json         (application/json)
 *   anything else              → 404
 *
 * Invoked as:
 *   bun <this-file> --port <n> --well-known-dir <path>
 *
 * `--well-known-dir` is the directory containing both `hub.html` and
 * `parachute.json` (both written by `parachute expose`). Kept as one flag so
 * the lifecycle side doesn't have to care how the hub server lays out files.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

interface Args {
  port: number;
  wellKnownDir: string;
}

function parseArgs(argv: string[]): Args {
  let port: number | undefined;
  let wellKnownDir: string | undefined;
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
    } else if (a === "--well-known-dir") {
      const v = argv[++i];
      if (!v) throw new Error("--well-known-dir requires a value");
      wellKnownDir = resolve(v);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (port === undefined) throw new Error("--port is required");
  if (wellKnownDir === undefined) throw new Error("--well-known-dir is required");
  return { port, wellKnownDir };
}

export function hubFetch(wellKnownDir: string): (req: Request) => Response {
  const hubHtmlPath = join(wellKnownDir, "hub.html");
  const parachuteJsonPath = join(wellKnownDir, "parachute.json");

  return (req) => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/hub.html") {
      if (!existsSync(hubHtmlPath)) {
        return new Response("hub.html not found", { status: 404 });
      }
      return new Response(Bun.file(hubHtmlPath), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (pathname === "/.well-known/parachute.json") {
      if (!existsSync(parachuteJsonPath)) {
        return new Response("parachute.json not found", { status: 404 });
      }
      return new Response(Bun.file(parachuteJsonPath), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  };
}

if (import.meta.main) {
  const { port, wellKnownDir } = parseArgs(process.argv.slice(2));
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: hubFetch(wellKnownDir),
  });
  console.log(`parachute-hub listening on http://127.0.0.1:${port} (dir=${wellKnownDir})`);
}

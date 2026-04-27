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
 *   /.well-known/jwks.json      → JWKS from hub.db        (application/json)
 *   anything else              → 404
 *
 * Invoked as:
 *   bun <this-file> --port <n> --well-known-dir <path> [--db <path>]
 *
 * `--well-known-dir` is the directory containing both `hub.html` and
 * `parachute.json` (both written by `parachute expose`). Kept as one flag so
 * the lifecycle side doesn't have to care how the hub server lays out files.
 *
 * `--db` is the path to `hub.db`. JWKS is served live from the DB so key
 * rotation takes effect on the next request without re-running
 * `parachute expose`. Defaults to `~/.parachute/hub.db` (overridable via
 * `$PARACHUTE_HOME`).
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { hubDbPath, openHubDb } from "./hub-db.ts";
import { pemToJwk } from "./jwks.ts";
import { getAllPublicKeys } from "./signing-keys.ts";

interface Args {
  port: number;
  wellKnownDir: string;
  dbPath: string;
}

function parseArgs(argv: string[]): Args {
  let port: number | undefined;
  let wellKnownDir: string | undefined;
  let dbPath: string | undefined;
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
    } else if (a === "--db") {
      const v = argv[++i];
      if (!v) throw new Error("--db requires a value");
      dbPath = resolve(v);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (port === undefined) throw new Error("--port is required");
  if (wellKnownDir === undefined) throw new Error("--well-known-dir is required");
  return { port, wellKnownDir, dbPath: dbPath ?? hubDbPath() };
}

export interface HubFetchDeps {
  /** Lazily opens (or returns a cached handle to) the hub DB. */
  getDb: () => Database;
}

export function hubFetch(wellKnownDir: string, deps?: HubFetchDeps): (req: Request) => Response {
  const hubHtmlPath = join(wellKnownDir, "hub.html");
  const parachuteJsonPath = join(wellKnownDir, "parachute.json");
  const getDb = deps?.getDb;

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
      // The well-known doc is a public service-discovery manifest (no
      // secrets, no PII), and Notes / future browser clients fetch it
      // cross-origin from their own loopback port. Wildcard CORS is the
      // shape it needs. Browsers send an OPTIONS preflight when the request
      // adds non-simple headers; answer it with 204 + the same allow-list.
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      if (!existsSync(parachuteJsonPath)) {
        return new Response("parachute.json not found", {
          status: 404,
          headers: corsHeaders,
        });
      }
      return new Response(Bun.file(parachuteJsonPath), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    if (pathname === "/.well-known/jwks.json") {
      // JWKS is also a cross-origin fetch target (browser-side OAuth
      // libraries pull this to verify access tokens). Same wildcard CORS
      // shape as parachute.json — JWKS is public-by-design (only public
      // keys leave the server).
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      if (!getDb) {
        return new Response('{"error":"jwks unavailable: db not configured"}', {
          status: 503,
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
      try {
        const db = getDb();
        const keys = getAllPublicKeys(db).map((k) => pemToJwk(k.publicKeyPem, k.kid));
        return new Response(JSON.stringify({ keys }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: `jwks failed: ${msg}` }), {
          status: 500,
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
    }

    return new Response("not found", { status: 404 });
  };
}

if (import.meta.main) {
  const { port, wellKnownDir, dbPath } = parseArgs(process.argv.slice(2));
  let cachedDb: Database | undefined;
  const getDb = () => {
    if (!cachedDb) cachedDb = openHubDb(dbPath);
    return cachedDb;
  };
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: hubFetch(wellKnownDir, { getDb }),
  });
  console.log(
    `parachute-hub listening on http://127.0.0.1:${port} (dir=${wellKnownDir}, db=${dbPath})`,
  );
}

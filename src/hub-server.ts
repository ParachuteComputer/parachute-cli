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
 *   /                                         → hub.html
 *   /hub.html                                 → hub.html
 *   /.well-known/parachute.json               → parachute.json
 *   /.well-known/jwks.json                    → JWKS from hub.db
 *   /.well-known/oauth-authorization-server   → RFC 8414 metadata (issuer, endpoints)
 *   /oauth/authorize  (GET + POST)            → login → consent → auth code
 *   /oauth/token      (POST)                  → authorization_code + refresh_token grants
 *   /oauth/register   (POST)                  → RFC 7591 dynamic client registration
 *   anything else                             → 404
 *
 * Invoked as:
 *   bun <this-file> --port <n> --well-known-dir <path> [--db <path>] [--issuer <url>]
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
import {
  handleAdminConfigGet,
  handleAdminConfigPost,
  handleAdminLoginGet,
  handleAdminLoginPost,
  handleAdminLogoutPost,
} from "./admin-handlers.ts";
import { handleCreateVault } from "./admin-vaults.ts";
import { hubDbPath, openHubDb } from "./hub-db.ts";
import { pemToJwk } from "./jwks.ts";
import {
  authorizationServerMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleRevoke,
  handleToken,
} from "./oauth-handlers.ts";
import { getAllPublicKeys } from "./signing-keys.ts";

interface Args {
  port: number;
  wellKnownDir: string;
  dbPath: string;
  issuer: string | undefined;
}

function parseArgs(argv: string[]): Args {
  let port: number | undefined;
  let wellKnownDir: string | undefined;
  let dbPath: string | undefined;
  let issuer: string | undefined;
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
    } else if (a === "--issuer") {
      const v = argv[++i];
      if (!v) throw new Error("--issuer requires a value");
      issuer = v.replace(/\/+$/, "");
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (port === undefined) throw new Error("--port is required");
  if (wellKnownDir === undefined) throw new Error("--well-known-dir is required");
  return { port, wellKnownDir, dbPath: dbPath ?? hubDbPath(), issuer };
}

export interface HubFetchDeps {
  /** Lazily opens (or returns a cached handle to) the hub DB. */
  getDb: () => Database;
  /**
   * Hub origin used as the OAuth `iss` claim and to build the authorization-
   * server metadata document. When omitted, OAuth endpoints fall back to the
   * request's own origin — fine for local dev, surprising under a reverse
   * proxy where the request origin is the loopback.
   */
  issuer?: string;
}

export function hubFetch(
  wellKnownDir: string,
  deps?: HubFetchDeps,
): (req: Request) => Response | Promise<Response> {
  const hubHtmlPath = join(wellKnownDir, "hub.html");
  const parachuteJsonPath = join(wellKnownDir, "parachute.json");
  const getDb = deps?.getDb;
  const configuredIssuer = deps?.issuer;

  const oauthDeps = (req: Request) => ({
    issuer: configuredIssuer ?? new URL(req.url).origin,
  });

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

    if (pathname === "/.well-known/oauth-authorization-server") {
      // Public discovery doc — clients pull this cross-origin to find the
      // authorize/token endpoints. Same wildcard CORS shape as the JWKS
      // and the parachute manifest.
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      const res = authorizationServerMetadata(oauthDeps(req));
      // Fold CORS into the existing JSON response.
      const merged = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders)) merged.set(k, v);
      return new Response(res.body, { status: res.status, headers: merged });
    }

    if (pathname === "/oauth/authorize") {
      if (!getDb) {
        return new Response("hub db not configured", { status: 503 });
      }
      if (req.method === "GET") return handleAuthorizeGet(getDb(), req, oauthDeps(req));
      if (req.method === "POST") return handleAuthorizePost(getDb(), req, oauthDeps(req));
      return new Response("method not allowed", { status: 405 });
    }

    if (pathname === "/oauth/token") {
      if (!getDb) {
        return new Response("hub db not configured", { status: 503 });
      }
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleToken(getDb(), req, oauthDeps(req));
    }

    if (pathname === "/oauth/register") {
      if (!getDb) {
        return new Response("hub db not configured", { status: 503 });
      }
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleRegister(getDb(), req, oauthDeps(req));
    }

    if (pathname === "/oauth/revoke") {
      if (!getDb) {
        return new Response("hub db not configured", { status: 503 });
      }
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleRevoke(getDb(), req, oauthDeps(req));
    }

    if (pathname === "/vaults") {
      if (!getDb) {
        return new Response("hub db not configured", { status: 503 });
      }
      return handleCreateVault(req, {
        db: getDb(),
        issuer: oauthDeps(req).issuer,
      });
    }

    if (pathname === "/admin/login") {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      if (req.method === "GET") return handleAdminLoginGet(getDb(), req);
      if (req.method === "POST") return handleAdminLoginPost(getDb(), req);
      return new Response("method not allowed", { status: 405 });
    }

    if (pathname === "/admin/logout") {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleAdminLogoutPost(getDb(), req);
    }

    if (pathname === "/admin/config") {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return handleAdminConfigGet(getDb(), req);
    }

    if (pathname.startsWith("/admin/config/")) {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const name = decodeURIComponent(pathname.slice("/admin/config/".length));
      if (!name || name.includes("/")) {
        return new Response("not found", { status: 404 });
      }
      return handleAdminConfigPost(getDb(), req, name);
    }

    return new Response("not found", { status: 404 });
  };
}

if (import.meta.main) {
  const { port, wellKnownDir, dbPath, issuer } = parseArgs(process.argv.slice(2));
  let cachedDb: Database | undefined;
  const getDb = () => {
    if (!cachedDb) cachedDb = openHubDb(dbPath);
    return cachedDb;
  };
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: hubFetch(wellKnownDir, { getDb, issuer }),
  });
  console.log(
    `parachute-hub listening on http://127.0.0.1:${port} (dir=${wellKnownDir}, db=${dbPath}${
      issuer ? `, issuer=${issuer}` : ""
    })`,
  );
}

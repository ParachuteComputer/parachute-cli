/**
 * `POST /vaults` — provision a new vault on the host.
 *
 * The hub's first authenticated, mutating endpoint. Until now the hub has
 * been a pure issuer; Phase 1 of the vault-config-and-scopes design (D1)
 * lifts vault provisioning into a hub UI surface so paraclaw / hub-admin
 * pages can mint a vault without shelling out to a terminal.
 *
 * Wire shape:
 *   POST /vaults
 *   Authorization: Bearer <jwt with parachute:host:admin>
 *   Content-Type: application/json
 *   { "name": "<vault-name>" }
 *
 *   201 → { name, url, version }   // vault freshly created
 *   200 → { name, url, version }   // idempotent re-POST: existing vault
 *   400 → { error: "invalid_request", error_description: ... }
 *   401/403 → bearer-auth failure
 *   500 → orchestration failure
 *
 * Orchestration:
 *   - If `parachute-vault` is NOT yet registered in services.json: shell
 *     out to `parachute install vault --vault-name <name>` (covers the
 *     bootstrap case for a fresh host).
 *   - If `parachute-vault` IS already registered: shell out to
 *     `parachute-vault create <name>` (subsequent vaults).
 *
 * The CLI is the single source of truth for "how do you create a vault";
 * we don't reimplement DB+yaml+token writes here. Mirrors D1 in the design
 * doc: hub orchestrates the CLI, doesn't replace it.
 *
 * Idempotency: name validation matches `parachute-vault create` (regex +
 * "list" reserved). When a vault with the requested name already exists,
 * we return 200 with the existing entry rather than re-running the CLI —
 * the CLI itself rejects an existing name with exit 1, but a re-POST is
 * usually a UI retry, not an error to the caller.
 */
import type { Database } from "bun:sqlite";
import { type AdminAuthError, adminAuthErrorResponse, requireScope } from "./admin-auth.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { findService, readManifest } from "./services-manifest.ts";
import {
  type WellKnownVaultEntry,
  isVaultEntry,
  vaultInstanceName,
} from "./well-known.ts";

/** Scope required to call POST /vaults. */
export const HOST_ADMIN_SCOPE = "parachute:host:admin";

/** Mirror parachute-vault's `cmdCreate` validation rules. */
const VAULT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const RESERVED_VAULT_NAMES = new Set(["list"]);

export interface CreateVaultRequest {
  name: string;
}

export interface CreateVaultDeps {
  db: Database;
  /** Hub origin used to validate JWT `iss` and to build the response `url`. */
  issuer: string;
  /** Override the services.json path. Defaults to `~/.parachute/services.json`. */
  manifestPath?: string;
  /**
   * Test seam: run the orchestration command. Production spawns the real
   * `parachute install` / `parachute-vault create` binaries; tests stub it
   * to avoid touching the filesystem outside the temp dir.
   */
  runCommand?: (cmd: readonly string[]) => Promise<number>;
}

interface ParseResult {
  ok: true;
  body: CreateVaultRequest;
}
interface ParseError {
  ok: false;
  status: number;
  message: string;
}

async function parseBody(req: Request): Promise<ParseResult | ParseError> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return { ok: false, status: 400, message: "Content-Type must be application/json" };
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 400, message: `invalid JSON body: ${msg}` };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, status: 400, message: "request body must be a JSON object" };
  }
  const name = (raw as Record<string, unknown>).name;
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, status: 400, message: '"name" must be a non-empty string' };
  }
  if (!VAULT_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      status: 400,
      message: 'vault name must contain only letters, numbers, hyphens, and underscores',
    };
  }
  if (RESERVED_VAULT_NAMES.has(name)) {
    return { ok: false, status: 400, message: `"${name}" is a reserved vault name` };
  }
  return { ok: true, body: { name } };
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Find an existing vault by name in services.json. Vaults live under one
 * `parachute-vault` service entry with a multi-path array (per Q5 of the
 * design — single entry, multi-path). We match on the path suffix.
 */
function findExistingVault(
  manifestPath: string,
  name: string,
): { url: string; version: string; path: string } | null {
  let manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch {
    return null;
  }
  const target = `/vault/${name}`;
  for (const svc of manifest.services) {
    if (!isVaultEntry(svc)) continue;
    // Multi-path single-entry shape (Q5): paths includes /vault/<name>.
    if (svc.paths.includes(target)) {
      return { url: target, version: svc.version, path: target };
    }
    // Per-vault entry shape (`parachute-vault-<name>`): instance name match.
    if (vaultInstanceName(svc) === name) {
      const path = svc.paths[0] ?? target;
      return { url: path, version: svc.version, path };
    }
  }
  return null;
}

function buildEntry(
  name: string,
  path: string,
  version: string,
  issuer: string,
): WellKnownVaultEntry {
  const base = issuer.replace(/\/$/, "");
  const url = new URL(path, `${base}/`).toString();
  return { name, url, version };
}

async function defaultRunCommand(cmd: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...cmd], { stdio: ["ignore", "pipe", "pipe"] });
  return await proc.exited;
}

/**
 * Run the orchestration step. Picks `parachute install` (bootstrap) vs
 * `parachute-vault create` (subsequent) based on whether vault is already
 * registered in services.json.
 */
async function orchestrate(
  manifestPath: string,
  name: string,
  runCommand: (cmd: readonly string[]) => Promise<number>,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const vaultRegistered = findService("parachute-vault", manifestPath) !== undefined;
  const cmd = vaultRegistered
    ? ["parachute-vault", "create", name]
    : ["parachute", "install", "vault", "--vault-name", name];
  let code: number;
  try {
    code = await runCommand(cmd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, message: `orchestration failed: ${msg}` };
  }
  if (code !== 0) {
    return {
      ok: false,
      status: 500,
      message: `${cmd[0]} ${cmd[1] ?? ""} exited with code ${code}`,
    };
  }
  return { ok: true };
}

export async function handleCreateVault(req: Request, deps: CreateVaultDeps): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const runCommand = deps.runCommand ?? defaultRunCommand;

  // Auth gate: parachute:host:admin scope. Maps an AdminAuthError straight
  // to an RFC 6750 401/403 — the route handler doesn't care which.
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }

  const parsed = await parseBody(req);
  if (!parsed.ok) {
    return jsonError(parsed.status, "invalid_request", parsed.message);
  }
  const { name } = parsed.body;

  // Idempotency: if the vault already exists, return 200 + existing entry.
  // Skip the CLI shell-out — re-POST is usually a UI retry.
  const existing = findExistingVault(manifestPath, name);
  if (existing) {
    return new Response(JSON.stringify(buildEntry(name, existing.path, existing.version, deps.issuer)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const result = await orchestrate(manifestPath, name, runCommand);
  if (!result.ok) {
    return jsonError(result.status, "server_error", result.message);
  }

  // Re-read services.json: the CLI just wrote it.
  const created = findExistingVault(manifestPath, name);
  if (!created) {
    return jsonError(
      500,
      "server_error",
      `vault "${name}" was provisioned but is not in services.json — manual recovery required`,
    );
  }

  return new Response(JSON.stringify(buildEntry(name, created.path, created.version, deps.issuer)), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

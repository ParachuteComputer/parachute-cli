/**
 * Tests for /api/oauth/clients/:id and /api/oauth/clients/:id/approve.
 *
 * Covers:
 *   - GET: 401 without Bearer, 403 with the wrong scope, 200 with the right
 *     scope, 404 for unknown client_id, 405 on POST.
 *   - POST approve: same auth surface, 200 + audit log on a pending row,
 *     200 + `already_approved` on a re-approve, 404 unknown id, 405 on GET.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApproveClient, handleGetClient } from "../admin-clients.ts";
import { approveClient, getClient, registerClient } from "../clients.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-admin-clients-"));
  const db = openHubDb(hubDbPath(dir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

async function makeOperatorBearer(scopes = ["parachute:host:admin"]): Promise<{
  bearer: string;
  userId: string;
}> {
  const user = await createUser(harness.db, "operator", "pw");
  const minted = await signAccessToken(harness.db, {
    sub: user.id,
    scopes,
    audience: "hub",
    clientId: "parachute-hub-spa",
    issuer: ISSUER,
    ttlSeconds: 600,
  });
  return { bearer: minted.token, userId: user.id };
}

function regPending(name?: string): string {
  const r = registerClient(harness.db, {
    redirectUris: ["https://app.example/cb"],
    scopes: ["vault:work:read"],
    status: "pending",
    ...(name !== undefined ? { clientName: name } : {}),
  });
  return r.client.clientId;
}

function getReq(clientId: string, bearer?: string): Request {
  const init: RequestInit = {};
  if (bearer) init.headers = { authorization: `Bearer ${bearer}` };
  return new Request(`${ISSUER}/api/oauth/clients/${encodeURIComponent(clientId)}`, init);
}

function approveReq(clientId: string, bearer?: string, method = "POST"): Request {
  const init: RequestInit = { method };
  if (bearer) init.headers = { authorization: `Bearer ${bearer}` };
  return new Request(`${ISSUER}/api/oauth/clients/${encodeURIComponent(clientId)}/approve`, init);
}

describe("handleGetClient", () => {
  test("401 without Bearer", async () => {
    const id = regPending("App");
    const res = await handleGetClient(getReq(id), id, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
  });

  test("403 with the wrong scope", async () => {
    const { bearer } = await makeOperatorBearer(["parachute:host:auth"]);
    const id = regPending("App");
    const res = await handleGetClient(getReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(403);
  });

  test("200 returns client details", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending("Notes");
    const res = await handleGetClient(getReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toBe(id);
    expect(body.client_name).toBe("Notes");
    expect(body.status).toBe("pending");
    expect(body.redirect_uris).toEqual(["https://app.example/cb"]);
    expect(body.scopes).toEqual(["vault:work:read"]);
    expect(typeof body.registered_at).toBe("string");
  });

  test("returns the row's status after approval (so the SPA can short-circuit re-approve)", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending("Notes");
    approveClient(harness.db, id);
    const res = await handleGetClient(getReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("approved");
  });

  test("404 for unknown client_id", async () => {
    const { bearer } = await makeOperatorBearer();
    const res = await handleGetClient(getReq("nope", bearer), "nope", {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  test("405 on POST", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending();
    const req = new Request(`${ISSUER}/api/oauth/clients/${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
    });
    const res = await handleGetClient(req, id, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
  });

  test("client_name is null when never set", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending(); // no client_name
    const res = await handleGetClient(getReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_name).toBeNull();
  });
});

describe("handleApproveClient", () => {
  test("401 without Bearer", async () => {
    const id = regPending();
    const res = await handleApproveClient(approveReq(id), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(401);
    // Row still pending.
    expect(getClient(harness.db, id)?.status).toBe("pending");
  });

  test("403 with the wrong scope", async () => {
    const { bearer } = await makeOperatorBearer(["parachute:host:auth"]);
    const id = regPending();
    const res = await handleApproveClient(approveReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(403);
    expect(getClient(harness.db, id)?.status).toBe("pending");
  });

  test("200 flips a pending row to approved", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending("Notes");
    const res = await handleApproveClient(approveReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toBe(id);
    expect(body.status).toBe("approved");
    expect(body.already_approved).toBe(false);
    expect(getClient(harness.db, id)?.status).toBe("approved");
  });

  test("idempotent: re-approving returns already_approved: true", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending();
    approveClient(harness.db, id);
    const res = await handleApproveClient(approveReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.already_approved).toBe(true);
    expect(body.status).toBe("approved");
  });

  test("404 for unknown client_id", async () => {
    const { bearer } = await makeOperatorBearer();
    const res = await handleApproveClient(approveReq("nope", bearer), "nope", {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(404);
  });

  test("405 on GET", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending();
    const req = new Request(`${ISSUER}/api/oauth/clients/${id}/approve`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    const res = await handleApproveClient(req, id, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
  });
});

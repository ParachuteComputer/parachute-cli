import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ADMIN_SCOPE, handleCreateVault } from "../admin-vaults.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { upsertService, writeManifest } from "../services-manifest.ts";
import { rotateSigningKey } from "../signing-keys.ts";

const ISSUER = "http://127.0.0.1:1939";

interface Harness {
  dir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-admin-vaults-"));
  return {
    dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function adminToken(db: ReturnType<typeof openHubDb>): Promise<string> {
  const { token } = await signAccessToken(db, {
    sub: "user-admin",
    scopes: [HOST_ADMIN_SCOPE, "vault:admin"],
    audience: "operator",
    clientId: "test-client",
    issuer: ISSUER,
  });
  return token;
}

async function readOnlyToken(db: ReturnType<typeof openHubDb>): Promise<string> {
  const { token } = await signAccessToken(db, {
    sub: "user-readonly",
    scopes: ["vault:read"],
    audience: "operator",
    clientId: "test-client",
    issuer: ISSUER,
  });
  return token;
}

interface CallOpts {
  body?: unknown;
  authHeader?: string | null;
  contentType?: string | null;
  manifestPath: string;
  db: ReturnType<typeof openHubDb>;
  runCommand?: (cmd: readonly string[]) => Promise<number>;
}

async function call(opts: CallOpts): Promise<Response> {
  const headers = new Headers();
  if (opts.authHeader === undefined) {
    headers.set("authorization", `Bearer ${await adminToken(opts.db)}`);
  } else if (opts.authHeader !== null) {
    headers.set("authorization", opts.authHeader);
  }
  if (opts.contentType === undefined) headers.set("content-type", "application/json");
  else if (opts.contentType !== null) headers.set("content-type", opts.contentType);

  const init: RequestInit = { method: "POST", headers };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const req = new Request(`${ISSUER}/vaults`, init);
  return handleCreateVault(req, {
    db: opts.db,
    issuer: ISSUER,
    manifestPath: opts.manifestPath,
    ...(opts.runCommand ? { runCommand: opts.runCommand } : {}),
  });
}

describe("POST /vaults — auth", () => {
  test("401 when Authorization header missing", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          authHeader: null,
          body: { name: "work" },
        });
        expect(res.status).toBe(401);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("403 when token lacks parachute:host:admin scope", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          authHeader: `Bearer ${await readOnlyToken(db)}`,
          body: { name: "work" },
        });
        expect(res.status).toBe(403);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("POST /vaults — body validation", () => {
  test("400 when Content-Type is not application/json", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          contentType: "text/plain",
          body: '{"name":"work"}',
        });
        expect(res.status).toBe(400);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 on malformed JSON", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: "not-json",
        });
        expect(res.status).toBe(400);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 when name is empty / missing / non-string", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        for (const body of [{}, { name: "" }, { name: 42 }, { name: null }]) {
          const res = await call({ db, manifestPath: h.manifestPath, body });
          expect(res.status).toBe(400);
        }
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 when name has invalid characters", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        for (const name of ["my vault", "../etc", "foo/bar", "x.y", "a:b"]) {
          const res = await call({ db, manifestPath: h.manifestPath, body: { name } });
          expect(res.status).toBe(400);
        }
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test('400 when name is the reserved "list"', async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const res = await call({ db, manifestPath: h.manifestPath, body: { name: "list" } });
        expect(res.status).toBe(400);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("POST /vaults — orchestration", () => {
  test("201 on happy path with vault already registered → calls `parachute-vault create`", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Seed services.json with the parachute-vault entry; vault is registered.
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            version: "0.3.5",
          },
          h.manifestPath,
        );
        const calls: Array<readonly string[]> = [];
        const runCommand = async (cmd: readonly string[]) => {
          calls.push(cmd);
          // Simulate successful CLI by adding the new path to the manifest.
          upsertService(
            {
              name: "parachute-vault",
              port: 1940,
              paths: ["/vault/default", "/vault/work"],
              health: "/health",
              version: "0.3.5",
            },
            h.manifestPath,
          );
          return 0;
        };
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { name: string; url: string; version: string };
        expect(body.name).toBe("work");
        expect(body.url).toBe(`${ISSUER}/vault/work`);
        expect(body.version).toBe("0.3.5");
        expect(calls).toEqual([["parachute-vault", "create", "work"]]);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("201 on bootstrap path (vault not yet registered) → calls `parachute install vault --vault-name`", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Empty manifest: vault NOT registered yet.
        writeManifest({ services: [] }, h.manifestPath);
        const calls: Array<readonly string[]> = [];
        const runCommand = async (cmd: readonly string[]) => {
          calls.push(cmd);
          upsertService(
            {
              name: "parachute-vault",
              port: 1940,
              paths: ["/vault/work"],
              health: "/health",
              version: "0.3.5",
            },
            h.manifestPath,
          );
          return 0;
        };
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        expect(res.status).toBe(201);
        expect(calls).toEqual([["parachute", "install", "vault", "--vault-name", "work"]]);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("200 idempotent re-POST when vault already exists in services.json", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default", "/vault/work"],
            health: "/health",
            version: "0.3.5",
          },
          h.manifestPath,
        );
        let runCalled = false;
        const runCommand = async () => {
          runCalled = true;
          return 0;
        };
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { name: string; url: string };
        expect(body.name).toBe("work");
        expect(body.url).toBe(`${ISSUER}/vault/work`);
        expect(runCalled).toBe(false);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("500 when CLI exits non-zero", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            version: "0.3.5",
          },
          h.manifestPath,
        );
        const runCommand = async () => 1;
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        expect(res.status).toBe(500);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("500 when CLI exits 0 but services.json doesn't reflect the new vault", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        upsertService(
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            version: "0.3.5",
          },
          h.manifestPath,
        );
        const runCommand = async () => 0;
        const res = await call({
          db,
          manifestPath: h.manifestPath,
          body: { name: "work" },
          runCommand,
        });
        expect(res.status).toBe(500);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("POST /vaults — method gating", () => {
  test("405 on GET", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const req = new Request(`${ISSUER}/vaults`, { method: "GET" });
        const res = await handleCreateVault(req, {
          db,
          issuer: ISSUER,
          manifestPath: h.manifestPath,
        });
        expect(res.status).toBe(405);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

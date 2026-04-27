import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";

interface Harness {
  configDir: string;
  dbPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const configDir = mkdtempSync(join(tmpdir(), "phub-db-"));
  return {
    configDir,
    dbPath: hubDbPath(configDir),
    cleanup: () => rmSync(configDir, { recursive: true, force: true }),
  };
}

describe("openHubDb + migrate", () => {
  test("creates schema_version + signing_keys on a fresh db", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const tables = (
          db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all() ?? []
        ).map((r) => r.name);
        expect(tables).toContain("schema_version");
        expect(tables).toContain("signing_keys");
        const versions = (
          db.query<{ version: number }, []>("SELECT version FROM schema_version").all() ?? []
        ).map((r) => r.version);
        expect(versions).toContain(1);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("re-opening an already-migrated db is a no-op (no duplicate version rows)", () => {
    const h = makeHarness();
    try {
      const db1 = openHubDb(h.dbPath);
      db1.close();
      const db2 = openHubDb(h.dbPath);
      try {
        const rows = db2
          .query<{ version: number; applied_at: string }, []>(
            "SELECT version, applied_at FROM schema_version",
          )
          .all();
        // Each migration recorded exactly once — re-open is idempotent.
        const versions = rows.map((r) => r.version).sort();
        expect(new Set(versions).size).toBe(versions.length);
        expect(versions).toContain(1);
        expect(versions).toContain(2);
      } finally {
        db2.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("signing_keys schema enforces required columns", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        // Missing private_key_pem must fail (NOT NULL).
        expect(() =>
          db
            .prepare(
              "INSERT INTO signing_keys (kid, public_key_pem, algorithm, created_at) VALUES (?, ?, ?, ?)",
            )
            .run("k1", "pem", "RS256", new Date().toISOString()),
        ).toThrow();
        // Full row works; retired_at is nullable.
        db.prepare(
          `INSERT INTO signing_keys (kid, public_key_pem, private_key_pem, algorithm, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run("k2", "pub", "priv", "RS256", new Date().toISOString());
        const row = db
          .query<{ retired_at: string | null }, [string]>(
            "SELECT retired_at FROM signing_keys WHERE kid = ?",
          )
          .get("k2");
        expect(row?.retired_at).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v2 creates users + tokens tables with the expected columns", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const tables = (
          db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all() ?? []
        ).map((r) => r.name);
        expect(tables).toContain("users");
        expect(tables).toContain("tokens");
        const versions = (
          db.query<{ version: number }, []>("SELECT version FROM schema_version").all() ?? []
        ).map((r) => r.version);
        expect(versions).toContain(2);

        // users.username UNIQUE constraint enforced.
        db.prepare(
          "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run("u1", "owner", "h", "2026-01-01", "2026-01-01");
        expect(() =>
          db
            .prepare(
              "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run("u2", "owner", "h2", "2026-01-01", "2026-01-01"),
        ).toThrow();

        // tokens.user_id FK enforced.
        expect(() =>
          db
            .prepare(
              `INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run("t1", "no-such-user", "c", "s", "2030-01-01", "2026-01-01"),
        ).toThrow();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

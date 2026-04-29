/**
 * Hub-local SQLite database. Opens `~/.parachute/hub.db` (overridable via
 * `$PARACHUTE_HOME`). Holds everything the hub owns as the ecosystem's OAuth
 * issuer — signing keys (v1), users + opaque refresh tokens (v2), OAuth
 * clients + auth-codes + grants + browser sessions (v3).
 *
 * Each open() runs `migrate()` to bring the schema up to date. A
 * `schema_version` table records every applied migration so re-opens are
 * cheap and idempotent. Migrations are append-only — never edit a prior
 * entry; add a new one with a higher number.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

export function hubDbPath(configDir: string = CONFIG_DIR): string {
  return join(configDir, "hub.db");
}

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE signing_keys (
        kid TEXT PRIMARY KEY,
        public_key_pem TEXT NOT NULL,
        private_key_pem TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retired_at TEXT
      );
      CREATE INDEX signing_keys_active ON signing_keys (retired_at)
        WHERE retired_at IS NULL;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tokens (
        jti TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        refresh_token_hash TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX tokens_user ON tokens (user_id);
      CREATE INDEX tokens_active_refresh ON tokens (refresh_token_hash)
        WHERE refresh_token_hash IS NOT NULL AND revoked_at IS NULL;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE clients (
        client_id TEXT PRIMARY KEY,
        client_secret_hash TEXT,
        redirect_uris TEXT NOT NULL,
        scopes TEXT NOT NULL,
        client_name TEXT,
        registered_at TEXT NOT NULL
      );
      CREATE TABLE auth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(client_id),
        user_id TEXT NOT NULL REFERENCES users(id),
        redirect_uri TEXT NOT NULL,
        scopes TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE grants (
        user_id TEXT NOT NULL REFERENCES users(id),
        client_id TEXT NOT NULL REFERENCES clients(client_id),
        scopes TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (user_id, client_id)
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX sessions_user ON sessions (user_id);
    `,
  },
  {
    version: 4,
    sql: `
      -- DCR approval gate (closes #74). Public DCR was unauthenticated before
      -- this migration; pre-existing rows are grandfathered as 'approved' so
      -- already-trusted clients keep working. New rows default to 'pending'
      -- unless the registrant authenticates with an operator token carrying
      -- hub:admin scope.
      ALTER TABLE clients ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
      UPDATE clients SET status = 'approved';
      CREATE INDEX clients_status ON clients (status);
    `,
  },
  {
    version: 5,
    sql: `
      -- Refresh-token rotation + replay detection (closes #73). Each chain
      -- of rotated refresh tokens shares a family_id; replaying a revoked
      -- refresh token in a family signals theft and revokes every row in
      -- that family (RFC 6819 §5.2.2.3). Pre-existing rows are backfilled
      -- with their own jti as the family — grandfathered as singletons so
      -- in-flight tokens keep working without spurious family revocation.
      ALTER TABLE tokens ADD COLUMN family_id TEXT;
      UPDATE tokens SET family_id = jti WHERE family_id IS NULL;
      CREATE INDEX tokens_family ON tokens (family_id) WHERE family_id IS NOT NULL;
    `,
  },
];

export function openHubDb(path: string = hubDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set<number>(
    (db.query("SELECT version FROM schema_version").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const insert = db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)");
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, new Date().toISOString());
    })();
  }
}

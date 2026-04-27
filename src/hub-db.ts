/**
 * Hub-local SQLite database. Opens `~/.parachute/hub.db` (overridable via
 * `$PARACHUTE_HOME`). Holds anything the hub itself owns — currently just
 * JWT signing keys; user accounts and OAuth state land here in subsequent
 * PRs (cli#58 b/c).
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

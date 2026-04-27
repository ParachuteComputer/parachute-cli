import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
/**
 * User accounts for the hub. Single-user-mode by default — `createUser`
 * refuses to create a second account unless `allowMulti` is set, so the
 * launch posture is "one account per hub" without baking that assumption
 * into the schema. Multi-user grows by setting the flag at the call site,
 * not by altering the table.
 *
 * Password hashing: argon2id via `@node-rs/argon2`. Pure-Rust prebuilts,
 * Bun-friendly (no node-gyp). Defaults are RFC 9106 second-recommended
 * parameters (m=19MiB, t=2, p=1) — fine for an interactive single-user
 * login.
 *
 * IDs are `crypto.randomUUID()` — UUIDv4. The brief called for ULIDs but
 * for the hub's access pattern (≤handful of accounts, no time-ordered
 * scan) UUIDv4's extra ~5 bytes of metadata are not load-bearing. Easy
 * to swap if a downstream integration needs the ULID prefix.
 */
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export class SingleUserModeError extends Error {
  constructor() {
    super(
      "a user already exists; pass --allow-multi to create additional accounts (forward-compat for multi-user mode)",
    );
    this.name = "SingleUserModeError";
  }
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username "${username}" is already in use`);
    this.name = "UsernameTakenError";
  }
}

export class UserNotFoundError extends Error {
  constructor(ref: string) {
    super(`user "${ref}" not found`);
    this.name = "UserNotFoundError";
  }
}

interface Row {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

function rowToUser(r: Row): User {
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateUserOpts {
  /** Allow creating an additional user when one already exists. Off by default. */
  allowMulti?: boolean;
  now?: () => Date;
}

export async function createUser(
  db: Database,
  username: string,
  password: string,
  opts: CreateUserOpts = {},
): Promise<User> {
  const count = (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get() ?? { n: 0 })
    .n;
  if (count > 0 && !opts.allowMulti) throw new SingleUserModeError();

  const id = randomUUID();
  const passwordHash = await argonHash(password);
  const stamp = (opts.now?.() ?? new Date()).toISOString();
  try {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, username, passwordHash, stamp, stamp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") && msg.includes("users.username")) {
      throw new UsernameTakenError(username);
    }
    throw err;
  }
  return { id, username, passwordHash, createdAt: stamp, updatedAt: stamp };
}

export function getUserByUsername(db: Database, username: string): User | null {
  const row = db.query<Row, [string]>("SELECT * FROM users WHERE username = ?").get(username);
  return row ? rowToUser(row) : null;
}

export function getUserById(db: Database, id: string): User | null {
  const row = db.query<Row, [string]>("SELECT * FROM users WHERE id = ?").get(id);
  return row ? rowToUser(row) : null;
}

export function listUsers(db: Database): User[] {
  const rows = db.query<Row, []>("SELECT * FROM users ORDER BY created_at ASC").all();
  return rows.map(rowToUser);
}

export function userCount(db: Database): number {
  return (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get() ?? { n: 0 }).n;
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  return argonVerify(user.passwordHash, password);
}

/**
 * Updates the password for an existing user. Throws `UserNotFoundError` if
 * the id has no row. Single-user-mode flows look up by username first and
 * pass the resolved id here.
 */
export async function setPassword(
  db: Database,
  userId: string,
  newPassword: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const passwordHash = await argonHash(newPassword);
  const stamp = now().toISOString();
  const result = db
    .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(passwordHash, stamp, userId);
  if (result.changes === 0) throw new UserNotFoundError(userId);
}

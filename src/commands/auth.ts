/**
 * `parachute auth` — ecosystem-level identity commands.
 *
 * Hub-local subcommands (write to `~/.parachute/hub.db`):
 *   - `rotate-key` — rotate the JWT signing keypair.
 *   - `set-password` — create or update the hub user's password. *NEW in
 *     0.3.1-rc.2*: this used to forward to `parachute-vault set-password`.
 *     The hub now owns identity, so set-password writes to `users` in
 *     hub.db. The OAuth endpoints still proxy to vault until PR (c) cuts
 *     them over — until then, your vault password is what the OAuth flow
 *     sees, while `set-password` seeds the hub-side user that PR (c) will
 *     start validating against.
 *   - `list-users` — show accounts in `users`.
 *
 * Vault-forwarded subcommands (still implemented in `parachute-vault`):
 *   - `2fa` — TOTP enroll/disable/backup-codes.
 */

import { createInterface } from "node:readline/promises";
import { openHubDb } from "../hub-db.ts";
import { issueOperatorToken } from "../operator-token.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import {
  SingleUserModeError,
  UsernameTakenError,
  createUser,
  getUserByUsername,
  listUsers,
  setPassword,
  userCount,
} from "../users.ts";

export interface Runner {
  run(cmd: readonly string[]): Promise<number>;
}

export const defaultRunner: Runner = {
  async run(cmd) {
    const proc = Bun.spawn([...cmd], { stdio: ["inherit", "inherit", "inherit"] });
    return await proc.exited;
  },
};

const VAULT_FORWARDED_SUBCOMMANDS = new Set(["2fa"]);
const HUB_LOCAL_SUBCOMMANDS = new Set([
  "rotate-key",
  "set-password",
  "list-users",
  "rotate-operator",
]);

export function authHelp(): string {
  return `parachute auth — ecosystem identity commands (password + two-factor authentication)

Usage:
  parachute auth set-password [--username <name>] [--password <pw>] [--allow-multi]
                                       Create or update the hub user's password
  parachute auth list-users            Show registered hub accounts
  parachute auth 2fa status            Show 2FA state
  parachute auth 2fa enroll            Enable TOTP 2FA (QR + backup codes)
  parachute auth 2fa disable           Disable 2FA (requires password)
  parachute auth 2fa backup-codes      Regenerate backup codes
  parachute auth rotate-key            Rotate the hub's JWT signing key
  parachute auth rotate-operator       Mint a fresh ~/.parachute/operator.token

set-password and list-users are hub-local — they read/write
~/.parachute/hub.db. set-password is interactive by default (prompts for
the password twice with hidden input). For scripted use, pass
\`--password <pw>\` and (for first-run setup) \`--username <name>\`.

The default username on first run is "owner" — override with --username.
Single-user mode is the default; pass --allow-multi to add additional
accounts beyond the first.

2fa forwards to \`parachute-vault\` which still implements TOTP storage. If
you see "not found on PATH", install vault first:

  parachute install vault

rotate-key generates a fresh RSA-2048 keypair and retires the previous
one. The retired key keeps appearing in /.well-known/jwks.json for 24
hours so cached client copies keep validating until their TTL expires.

rotate-operator mints a fresh long-lived operator token at
~/.parachute/operator.token (mode 0600). Local CLI tools read this file
as their bearer when calling on-box services. set-password also writes
the file on first-run / password reset.
`;
}

export interface AuthDeps {
  runner?: Runner;
  rotateKey?: () => { kid: string; createdAt: string };
  /** Read a hidden password from the terminal. Tests inject a fixed answer. */
  readPassword?: (prompt: string) => Promise<string>;
  /** Read a non-hidden line — username, confirmations, etc. */
  readLine?: (prompt: string) => Promise<string>;
  /** Whether stdin+stdout are a TTY. Tests force false. */
  isInteractive?: () => boolean;
  /** Override the hub-db path. Tests point at a tmp dir. */
  dbPath?: string;
  /**
   * Override the directory where `operator.token` is written. Defaults to
   * `configDir()` (i.e. `~/.parachute/`). Tests point at a tmp dir.
   */
  configDir?: string;
}

function defaultRotateKey(): { kid: string; createdAt: string } {
  const db = openHubDb();
  try {
    const k = rotateSigningKey(db);
    return { kid: k.kid, createdAt: k.createdAt };
  } finally {
    db.close();
  }
}

/**
 * Hidden-input password read using stdin raw mode. Hand-rolled rather than
 * pulling in a prompt library — the surface is small (Enter/Backspace/Ctrl-C)
 * and adding a transitive dep just to hide echo is overkill.
 */
async function defaultReadPassword(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    let buf = "";
    const teardown = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: Buffer) => {
      const ch = chunk.toString("utf8");
      for (const c of ch) {
        if (c === "\n" || c === "\r" || c === "\u0004") {
          teardown();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (c === "\u0003") {
          teardown();
          process.stdout.write("\n");
          reject(new Error("interrupted"));
          return;
        }
        if (c === "\u007f" || c === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += c;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function defaultReadLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function defaultIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

interface ParsedFlags {
  username?: string;
  password?: string;
  allowMulti: boolean;
  error?: string;
}

function parseSetPasswordFlags(args: readonly string[]): ParsedFlags {
  let username: string | undefined;
  let password: string | undefined;
  let allowMulti = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--username") {
      const v = args[++i];
      if (!v) return { allowMulti, error: "--username requires a value" };
      username = v;
    } else if (a?.startsWith("--username=")) {
      username = a.slice("--username=".length);
      if (!username) return { allowMulti, error: "--username requires a value" };
    } else if (a === "--password") {
      const v = args[++i];
      if (!v) return { allowMulti, error: "--password requires a value" };
      password = v;
    } else if (a?.startsWith("--password=")) {
      password = a.slice("--password=".length);
      if (!password) return { allowMulti, error: "--password requires a value" };
    } else if (a === "--allow-multi") {
      allowMulti = true;
    } else {
      return { allowMulti, error: `unknown flag "${a}"` };
    }
  }
  return { username, password, allowMulti };
}

async function runSetPassword(args: readonly string[], deps: AuthDeps): Promise<number> {
  const flags = parseSetPasswordFlags(args);
  if (flags.error) {
    console.error(`parachute auth set-password: ${flags.error}`);
    return 1;
  }
  const isInteractive = (deps.isInteractive ?? defaultIsInteractive)();
  const readPassword = deps.readPassword ?? defaultReadPassword;
  const readLine = deps.readLine ?? defaultReadLine;

  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const existing = listUsers(db);
    const existingUser = existing[0];
    const targetUsername = flags.username ?? existingUser?.username ?? "owner";

    let password = flags.password;
    if (!password) {
      if (!isInteractive) {
        console.error(
          "parachute auth set-password: --password is required when stdin is not a TTY",
        );
        return 1;
      }
      const p1 = await readPassword(`Password for "${targetUsername}": `);
      if (p1.length === 0) {
        console.error("password cannot be empty");
        return 1;
      }
      const p2 = await readPassword("Confirm password: ");
      if (p1 !== p2) {
        console.error("passwords did not match");
        return 1;
      }
      password = p1;
    }

    if (existingUser) {
      // Update path. If --username supplied AND it doesn't match, that's
      // ambiguous: are they renaming or addressing a new user? In single-user
      // mode we refuse rather than guessing.
      if (flags.username && flags.username !== existingUser.username && !flags.allowMulti) {
        console.error(
          `a user named "${existingUser.username}" already exists. To create another, pass --allow-multi.`,
        );
        return 1;
      }
      const target =
        flags.username && flags.username !== existingUser.username && flags.allowMulti
          ? null
          : existingUser;
      if (target) {
        await setPassword(db, target.id, password);
        console.log(`Updated password for "${target.username}".`);
        const issued = await issueOperatorToken(db, target.id, { dir: deps.configDir });
        console.log(`Refreshed operator token at ${issued.path}.`);
        return 0;
      }
    }

    // Create path (no user exists yet, or --allow-multi for an additional one).
    if (existing.length > 0 && !flags.allowMulti) {
      // Should be unreachable given the existingUser branch above, but keep
      // the explicit guard so a future refactor can't quietly drop it.
      console.error("a user already exists; pass --allow-multi to create another");
      return 1;
    }

    // For first-run interactive without an explicit --username, confirm.
    if (existing.length === 0 && !flags.username && isInteractive) {
      const answer = (await readLine(`Create the first hub user named "owner"? [Y/n] `)).trim();
      if (answer.length > 0 && !/^y(es)?$/i.test(answer)) {
        console.error("aborted; pass --username <name> to choose a different name");
        return 1;
      }
    }

    try {
      const u = await createUser(db, targetUsername, password, { allowMulti: flags.allowMulti });
      console.log(`Created hub user "${u.username}" (id=${u.id}).`);
      const issued = await issueOperatorToken(db, u.id, { dir: deps.configDir });
      console.log(`Wrote operator token to ${issued.path} (mode 0600).`);
      return 0;
    } catch (err) {
      if (err instanceof SingleUserModeError) {
        console.error(err.message);
        return 1;
      }
      if (err instanceof UsernameTakenError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

async function runRotateOperator(deps: AuthDeps): Promise<number> {
  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const users = listUsers(db);
    const owner = users[0];
    if (!owner) {
      console.error(
        "no hub users yet — run `parachute auth set-password` to create the first one before issuing an operator token",
      );
      return 1;
    }
    const issued = await issueOperatorToken(db, owner.id, { dir: deps.configDir });
    console.log("Rotated operator token.");
    console.log(`  user:       ${owner.username}`);
    console.log(`  path:       ${issued.path}`);
    console.log(`  expires_at: ${issued.expiresAt}`);
    console.log(
      "Previous tokens stay valid until they expire — the hub does not revoke them. Treat operator.token like an SSH key.",
    );
    return 0;
  } finally {
    db.close();
  }
}

function runListUsers(deps: AuthDeps): number {
  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const users = listUsers(db);
    if (users.length === 0) {
      console.log("(no hub users yet — run `parachute auth set-password` to create the first one)");
      return 0;
    }
    console.log("USERNAME           ID                                    CREATED");
    for (const u of users) {
      const username = u.username.padEnd(18).slice(0, 18);
      const id = u.id.padEnd(36).slice(0, 36);
      console.log(`${username} ${id}  ${u.createdAt}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function auth(args: readonly string[], deps: AuthDeps | Runner = {}): Promise<number> {
  // Back-compat shim: callers used to pass a Runner directly. Detect that
  // shape (a `run` method) and lift it into the new deps bag.
  const normalized: AuthDeps =
    typeof (deps as Runner).run === "function" ? { runner: deps as Runner } : (deps as AuthDeps);
  const runner = normalized.runner ?? defaultRunner;
  const rotateKey = normalized.rotateKey ?? defaultRotateKey;

  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(authHelp());
    return 0;
  }

  if (HUB_LOCAL_SUBCOMMANDS.has(sub)) {
    if (sub === "rotate-key") {
      try {
        const { kid, createdAt } = rotateKey();
        console.log("Rotated hub signing key.");
        console.log(`  kid:        ${kid}`);
        console.log(`  created_at: ${createdAt}`);
        console.log("Previous key keeps validating tokens for 24h via /.well-known/jwks.json.");
        return 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth rotate-key: ${msg}`);
        return 1;
      }
    }
    if (sub === "set-password") {
      try {
        return await runSetPassword(args.slice(1), normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth set-password: ${msg}`);
        return 1;
      }
    }
    if (sub === "list-users") {
      return runListUsers(normalized);
    }
    if (sub === "rotate-operator") {
      try {
        return await runRotateOperator(normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth rotate-operator: ${msg}`);
        return 1;
      }
    }
  }

  if (!VAULT_FORWARDED_SUBCOMMANDS.has(sub)) {
    console.error(`parachute auth: unknown subcommand "${sub}"`);
    console.error("run `parachute auth --help` for usage");
    return 1;
  }
  try {
    return await runner.run(["parachute-vault", ...args]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("enoent") || msg.toLowerCase().includes("not found")) {
      console.error("parachute-vault not found on PATH.");
      console.error("Install it with: parachute install vault");
      return 127;
    }
    console.error(`failed to run parachute-vault: ${msg}`);
    return 1;
  }
}

// Re-exported so `users.ts` consumers can preserve the named-export.
export { getUserByUsername };

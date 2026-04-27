/**
 * `parachute auth` — ecosystem-level identity commands.
 *
 * Identity (password + 2FA) is an ecosystem concern now that the hub owns
 * OAuth issuance (Phase 0). The *implementation* still lives in
 * parachute-vault for password + 2FA — these commands are thin shell-forwards
 * to the vault binary so beta users learn the blessed namespace from day one.
 *
 * `rotate-key` is hub-local: signing keys live in `~/.parachute/hub.db` and
 * back the JWT issuance the hub will start doing in cli#58 PR (b). Rotation
 * is a hub concern, not a vault concern.
 *
 * Vault keeps its own `set-password` / `2fa` commands for back-compat.
 */

import { openHubDb } from "../hub-db.ts";
import { rotateSigningKey } from "../signing-keys.ts";

export interface Runner {
  run(cmd: readonly string[]): Promise<number>;
}

export const defaultRunner: Runner = {
  async run(cmd) {
    const proc = Bun.spawn([...cmd], { stdio: ["inherit", "inherit", "inherit"] });
    return await proc.exited;
  },
};

const VAULT_FORWARDED_SUBCOMMANDS = new Set(["set-password", "2fa"]);
const HUB_LOCAL_SUBCOMMANDS = new Set(["rotate-key"]);

export function authHelp(): string {
  return `parachute auth — ecosystem identity commands (password + two-factor authentication)

Usage:
  parachute auth set-password         Set or change the owner password
  parachute auth set-password --clear Remove the owner password
  parachute auth 2fa status           Show 2FA state
  parachute auth 2fa enroll           Enable TOTP 2FA (QR + backup codes)
  parachute auth 2fa disable          Disable 2FA (requires password)
  parachute auth 2fa backup-codes     Regenerate backup codes
  parachute auth rotate-key           Rotate the hub's JWT signing key

set-password and 2fa forward to \`parachute-vault\` which implements the
storage and crypto. If you see "not found on PATH", install vault first:

  parachute install vault

rotate-key is hub-local — it generates a fresh RSA-2048 keypair in
~/.parachute/hub.db and retires the previous one. The retired key keeps
appearing in /.well-known/jwks.json for 24 hours so cached client copies
keep validating until their TTL expires.
`;
}

export interface AuthDeps {
  runner?: Runner;
  rotateKey?: () => { kid: string; createdAt: string };
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

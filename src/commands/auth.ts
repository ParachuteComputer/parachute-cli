/**
 * `parachute auth` — ecosystem-level identity commands.
 *
 * Identity (password + 2FA) is an ecosystem concern now that the hub owns
 * OAuth issuance (Phase 0). The *implementation* still lives in
 * parachute-vault — these commands are thin shell-forwards to the vault
 * binary so beta users learn the blessed namespace from day one.
 *
 * Vault keeps its own `set-password` / `2fa` commands for back-compat.
 */

export interface Runner {
  run(cmd: readonly string[]): Promise<number>;
}

export const defaultRunner: Runner = {
  async run(cmd) {
    const proc = Bun.spawn([...cmd], { stdio: ["inherit", "inherit", "inherit"] });
    return await proc.exited;
  },
};

const AUTH_SUBCOMMANDS = new Set(["set-password", "2fa"]);

export function authHelp(): string {
  return `parachute auth — ecosystem identity commands (password + two-factor authentication)

Usage:
  parachute auth set-password         Set or change the owner password
  parachute auth set-password --clear Remove the owner password
  parachute auth 2fa status           Show 2FA state
  parachute auth 2fa enroll           Enable TOTP 2FA (QR + backup codes)
  parachute auth 2fa disable          Disable 2FA (requires password)
  parachute auth 2fa backup-codes     Regenerate backup codes

All subcommands forward to \`parachute-vault\` which implements the storage
and crypto. If you see "not found on PATH", install vault first:

  parachute install vault
`;
}

export async function auth(
  args: readonly string[],
  runner: Runner = defaultRunner,
): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(authHelp());
    return 0;
  }
  if (!AUTH_SUBCOMMANDS.has(sub)) {
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

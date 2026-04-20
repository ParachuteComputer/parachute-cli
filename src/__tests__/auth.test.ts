import { describe, expect, test } from "bun:test";
import { type Runner, auth, authHelp } from "../commands/auth.ts";

function makeRunner(result: number | (() => Promise<number>) = 0): {
  runner: Runner;
  calls: Array<readonly string[]>;
} {
  const calls: Array<readonly string[]> = [];
  const runner: Runner = {
    async run(cmd) {
      calls.push(cmd);
      return typeof result === "function" ? await result() : result;
    },
  };
  return { runner, calls };
}

describe("parachute auth", () => {
  test("set-password forwards to parachute-vault set-password", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth(["set-password"], runner);
    expect(code).toBe(0);
    expect(calls).toEqual([["parachute-vault", "set-password"]]);
  });

  test("set-password --clear forwards the flag", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth(["set-password", "--clear"], runner);
    expect(code).toBe(0);
    expect(calls).toEqual([["parachute-vault", "set-password", "--clear"]]);
  });

  test("2fa enroll forwards to parachute-vault 2fa enroll", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth(["2fa", "enroll"], runner);
    expect(code).toBe(0);
    expect(calls).toEqual([["parachute-vault", "2fa", "enroll"]]);
  });

  test("2fa enroll --some-flag forwards every arg after the subcommand", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth(["2fa", "enroll", "--some-flag", "value"], runner);
    expect(code).toBe(0);
    expect(calls).toEqual([["parachute-vault", "2fa", "enroll", "--some-flag", "value"]]);
  });

  test("exit code from parachute-vault is propagated", async () => {
    const { runner } = makeRunner(3);
    const code = await auth(["2fa", "status"], runner);
    expect(code).toBe(3);
  });

  test("ENOENT surfaces install hint and exit 127", async () => {
    const runner: Runner = {
      async run() {
        throw new Error("ENOENT: spawn parachute-vault");
      },
    };
    const code = await auth(["set-password"], runner);
    expect(code).toBe(127);
  });

  test("bogus subcommand exits 1 without spawning vault", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth(["whoami"], runner);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  test("no args prints help and exits 0 without spawning vault", async () => {
    const { runner, calls } = makeRunner(0);
    const code = await auth([], runner);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  test("--help and help both route to the same help surface", async () => {
    const { runner, calls } = makeRunner(0);
    expect(await auth(["--help"], runner)).toBe(0);
    expect(await auth(["-h"], runner)).toBe(0);
    expect(await auth(["help"], runner)).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("authHelp", () => {
  const h = authHelp();

  test("lists every blessed subcommand", () => {
    expect(h).toContain("parachute auth set-password");
    expect(h).toContain("--clear");
    expect(h).toContain("parachute auth 2fa status");
    expect(h).toContain("parachute auth 2fa enroll");
    expect(h).toContain("parachute auth 2fa disable");
    expect(h).toContain("parachute auth 2fa backup-codes");
  });

  test("mentions the vault-install hint", () => {
    expect(h).toContain("parachute install vault");
  });
});

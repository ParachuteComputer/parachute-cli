import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cli.ts");

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: "/tmp/parachute-cli-nonexistent-home",
      PARACHUTE_HOME: "/tmp/parachute-cli-nonexistent-home",
      ...env,
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("cli", () => {
  test("--version prints version from package.json", async () => {
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("--help lists commands", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/parachute install/);
    expect(stdout).toMatch(/parachute status/);
    expect(stdout).toMatch(/parachute vault/);
    expect(stdout).toMatch(/expose tailnet/);
    expect(stdout).toMatch(/expose public/);
  });

  test("expose with unknown layer exits 1", async () => {
    const { code, stderr } = await runCli(["expose", "wat"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown layer/);
    expect(stderr).toMatch(/expose public/);
  });

  test("no args prints help", async () => {
    const { code, stdout } = await runCli([]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Usage:/);
  });

  test("install with no service name exits 1", async () => {
    const { code, stderr } = await runCli(["install"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/usage: parachute install/);
  });

  test("unknown command exits 1", async () => {
    const { code, stderr } = await runCli(["wat"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown command/);
  });
});

describe("cli per-subcommand help", () => {
  test("install --help shows install usage", async () => {
    const { code, stdout } = await runCli(["install", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/parachute install/);
    expect(stdout).toMatch(/bun add -g/);
  });

  test("install -h also works", async () => {
    const { code, stdout } = await runCli(["install", "-h"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/parachute install/);
  });

  test("status --help shows status usage", async () => {
    const { code, stdout } = await runCli(["status", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/parachute status/);
    expect(stdout).toMatch(/Exit codes/);
  });

  test("expose --help shows both layers and Funnel notes", async () => {
    const { code, stdout } = await runCli(["expose", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/expose tailnet/);
    expect(stdout).toMatch(/expose public/);
    expect(stdout).toMatch(/Funnel/);
    expect(stdout).toMatch(/443/);
  });

  test("expose tailnet --help shows full expose help", async () => {
    const { code, stdout } = await runCli(["expose", "tailnet", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/expose tailnet/);
  });

  test("vault with no args forwards --help to parachute-vault", async () => {
    // Clear PATH so the dispatcher reliably hits the ENOENT branch — that
    // proves the CLI is forwarding rather than printing local help. Spawn
    // bun by absolute path so the outer shell-out isn't affected by PATH=''.
    const proc = Bun.spawn([process.execPath, CLI, "vault"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: "",
        HOME: "/tmp/parachute-cli-nonexistent-home",
        PARACHUTE_HOME: "/tmp/parachute-cli-nonexistent-home",
      },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(127);
    expect(stderr).toMatch(/parachute-vault not found on PATH/);
    expect(stderr).toMatch(/parachute install vault/);
  });
});

describe("cli friendly errors", () => {
  test("malformed services.json prints friendly error not stack trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-bad-"));
    try {
      writeFileSync(join(dir, "services.json"), "this is not json{");
      const { code, stderr } = await runCli(["status"], { PARACHUTE_HOME: dir });
      expect(code).toBe(1);
      expect(stderr).toMatch(/services\.json is malformed/);
      expect(stderr).not.toMatch(/at process\./);
      expect(stderr).not.toMatch(/Error:.*at \//);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

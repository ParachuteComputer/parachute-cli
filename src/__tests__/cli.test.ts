import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cli.ts");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: "/tmp/parachute-cli-nonexistent-home" },
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

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloudflaredInstallHint,
  isCloudflaredInstalled,
  isCloudflaredLoggedIn,
} from "../cloudflare/detect.ts";
import type { CommandResult, Runner } from "../tailscale/run.ts";

function stubRunner(result: CommandResult | Error): Runner {
  return async (_cmd) => {
    if (result instanceof Error) throw result;
    return result;
  };
}

describe("cloudflare detect", () => {
  test("isCloudflaredInstalled returns true on exit 0", async () => {
    const runner = stubRunner({ code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" });
    expect(await isCloudflaredInstalled(runner)).toBe(true);
  });

  test("isCloudflaredInstalled returns false on non-zero exit", async () => {
    const runner = stubRunner({ code: 127, stdout: "", stderr: "not found" });
    expect(await isCloudflaredInstalled(runner)).toBe(false);
  });

  test("isCloudflaredInstalled swallows ENOENT (binary missing → not installed)", async () => {
    // Bun.spawn throws synchronously when the binary is missing; the detector
    // has to read that as "not installed" rather than propagating the error.
    const runner = stubRunner(new Error("ENOENT: cloudflared not on PATH"));
    expect(await isCloudflaredInstalled(runner)).toBe(false);
  });

  test("isCloudflaredInstalled matches on .code === 'ENOENT' too", async () => {
    const err = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    expect(await isCloudflaredInstalled(stubRunner(err))).toBe(false);
  });

  test("isCloudflaredInstalled propagates non-ENOENT errors (don't lie about why)", async () => {
    // An EACCES (binary found but not executable) is real misconfiguration,
    // not a missing install. Swallowing it here would mask the actual fix.
    const err = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    await expect(isCloudflaredInstalled(stubRunner(err))).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  test("isCloudflaredLoggedIn reads cert.pem presence in the passed home dir", () => {
    const home = mkdtempSync(join(tmpdir(), "cf-home-"));
    try {
      expect(isCloudflaredLoggedIn(home)).toBe(false);
      writeFileSync(join(home, "cert.pem"), "-----BEGIN CERTIFICATE-----\n...\n");
      expect(isCloudflaredLoggedIn(home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("install hint names brew on darwin and a URL elsewhere", () => {
    expect(cloudflaredInstallHint("darwin")).toContain("brew install cloudflared");
    expect(cloudflaredInstallHint("linux")).toContain(
      "developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads",
    );
  });
});

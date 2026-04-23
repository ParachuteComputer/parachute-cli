import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exposeCloudflareOff,
  exposeCloudflareUp,
} from "../commands/expose-cloudflare.ts";

let tmp: string;
let manifestPath: string;
let statePath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "parachute-expose-cf-"));
  manifestPath = join(tmp, "services.json");
  statePath = join(tmp, "cloudflared-state.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeManifest(services: Array<{ name: string; port: number; paths?: string[] }>) {
  writeFileSync(
    manifestPath,
    JSON.stringify({
      services: services.map((s) => ({
        name: s.name,
        port: s.port,
        paths: s.paths ?? [`/${s.name.replace(/^parachute-/, "")}`],
        version: "0.0.0-test",
        health: "/health",
      })),
    }),
  );
}

const cloudflaredPresent = async () => ({ code: 0, stdout: "cloudflared version", stderr: "" });
const cloudflaredMissing = async () => ({ code: 127, stdout: "", stderr: "not found" });

describe("exposeCloudflareUp", () => {
  it("errors out with install help when cloudflared is missing", async () => {
    writeManifest([{ name: "parachute-vault", port: 1940, paths: ["/vault/default"] }]);
    const lines: string[] = [];
    const code = await exposeCloudflareUp({
      runner: cloudflaredMissing,
      manifestPath,
      statePath,
      log: (l) => lines.push(l),
      spawn: async () => {
        throw new Error("spawn should not be called");
      },
      stop: () => false,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("cloudflared is not installed");
    expect(lines.join("\n")).toContain("brew install cloudflared");
    expect(existsSync(statePath)).toBe(false);
  });

  it("errors out when no vault is installed", async () => {
    writeManifest([]);
    const lines: string[] = [];
    const code = await exposeCloudflareUp({
      runner: cloudflaredPresent,
      manifestPath,
      statePath,
      log: (l) => lines.push(l),
      spawn: async () => {
        throw new Error("spawn should not be called");
      },
      stop: () => false,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("No vault installed");
  });

  it("spawns tunnel, writes state, and prints URLs when vault is present", async () => {
    writeManifest([{ name: "parachute-vault", port: 1940, paths: ["/vault/default"] }]);
    const lines: string[] = [];
    let stopCalled = false;
    const code = await exposeCloudflareUp({
      runner: cloudflaredPresent,
      manifestPath,
      statePath,
      log: (l) => lines.push(l),
      spawn: async ({ port }) => ({
        pid: 12345,
        url: `https://quick-abc.trycloudflare.com`,
        logPath: `/tmp/cf-${port}.log`,
      }),
      stop: () => {
        stopCalled = true;
        return false;
      },
    });
    expect(code).toBe(0);
    expect(existsSync(statePath)).toBe(true);
    const body = lines.join("\n");
    expect(body).toContain("Cloudflare Quick Tunnel active");
    expect(body).toContain("https://quick-abc.trycloudflare.com");
    expect(body).toContain("https://quick-abc.trycloudflare.com/vault/default");
    // Security guidance — both OAuth + API tokens mentioned
    expect(body).toContain("OAuth");
    expect(body).toContain("API tokens");
    expect(stopCalled).toBe(false); // no prior state
  });

  it("stops prior tunnel before starting a new one", async () => {
    writeManifest([{ name: "parachute-vault", port: 1940, paths: ["/vault/default"] }]);
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        pid: 99999,
        url: "https://old.trycloudflare.com",
        localPort: 1940,
        startedAt: "2026-04-23T00:00:00Z",
      }),
    );
    const stopped: number[] = [];
    const code = await exposeCloudflareUp({
      runner: cloudflaredPresent,
      manifestPath,
      statePath,
      log: () => {},
      spawn: async () => ({
        pid: 12345,
        url: `https://new.trycloudflare.com`,
        logPath: `/tmp/cf.log`,
      }),
      stop: (pid) => {
        stopped.push(pid);
        return true;
      },
    });
    expect(code).toBe(0);
    expect(stopped).toEqual([99999]);
  });
});

describe("exposeCloudflareOff", () => {
  it("is a no-op when no tunnel is running", async () => {
    const lines: string[] = [];
    const code = await exposeCloudflareOff({
      statePath,
      log: (l) => lines.push(l),
      stop: () => {
        throw new Error("should not be called");
      },
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Nothing to tear down");
  });

  it("kills the tunnel PID and clears state when running", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        pid: 54321,
        url: "https://x.trycloudflare.com",
        localPort: 1940,
        startedAt: "2026-04-23T00:00:00Z",
      }),
    );
    const stopped: number[] = [];
    const code = await exposeCloudflareOff({
      statePath,
      log: () => {},
      stop: (pid) => {
        stopped.push(pid);
        return true;
      },
    });
    expect(code).toBe(0);
    expect(stopped).toEqual([54321]);
    expect(existsSync(statePath)).toBe(false);
  });
});

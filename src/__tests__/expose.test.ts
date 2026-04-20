import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exposePublic, exposeTailnet } from "../commands/expose.ts";
import { readExposeState, writeExposeState } from "../expose-state.ts";
import type { EnsureHubOpts, HubSpawner, StopHubOpts } from "../hub-control.ts";
import { writePid } from "../process-state.ts";
import { upsertService } from "../services-manifest.ts";
import type { Runner } from "../tailscale/run.ts";

interface Harness {
  dir: string;
  manifestPath: string;
  statePath: string;
  wellKnownPath: string;
  hubPath: string;
  wellKnownDir: string;
  configDir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-expose-"));
  return {
    dir,
    manifestPath: join(dir, "services.json"),
    statePath: join(dir, "expose-state.json"),
    wellKnownPath: join(dir, "well-known", "parachute.json"),
    hubPath: join(dir, "well-known", "hub.html"),
    wellKnownDir: join(dir, "well-known"),
    configDir: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeRunner(): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (cmd) => {
    calls.push([...cmd]);
    if (cmd[0] === "tailscale" && cmd[1] === "version") {
      return { code: 0, stdout: "1.96.4\n", stderr: "" };
    }
    if (cmd[0] === "tailscale" && cmd[1] === "status" && cmd[2] === "--json") {
      return {
        code: 0,
        stdout: JSON.stringify({ Self: { DNSName: "parachute.taildf9ce2.ts.net." } }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

function makeHubSpawner(pid: number): { spawner: HubSpawner; calls: string[][] } {
  const calls: string[][] = [];
  const spawner: HubSpawner = {
    spawn(cmd) {
      calls.push([...cmd]);
      return pid;
    },
  };
  return { spawner, calls };
}

/** Default hub overrides for expose tests — no real subprocess, no sleep. */
function hubEnsureOpts(
  spawner: HubSpawner,
): Omit<EnsureHubOpts, "configDir" | "wellKnownDir" | "log"> {
  return {
    spawner,
    alive: () => true,
    probe: async () => true,
    readyWaitMs: 0,
  };
}

function hubStopOpts(): Omit<StopHubOpts, "configDir" | "log"> {
  return {
    kill: () => {},
    alive: () => false,
    sleep: async () => {},
    now: () => 0,
  };
}

function seedServices(path: string): void {
  upsertService(
    {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
      version: "0.2.4",
    },
    path,
  );
  upsertService(
    {
      name: "parachute-notes",
      port: 5173,
      paths: ["/notes"],
      health: "/notes/health",
      version: "0.0.1",
    },
    path,
  );
}

describe("expose tailnet up", () => {
  test("mounts hub proxy at /, one proxy per service, plus well-known proxy", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);

      const serveCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"),
      );
      expect(serveCalls).toHaveLength(4);
      expect(serveCalls.every((c) => !c.includes("--funnel"))).toBe(true);

      const mounts = serveCalls.map((c) => c.find((a) => a.startsWith("--set-path="))).sort();
      expect(mounts).toEqual([
        "--set-path=/",
        "--set-path=/.well-known/parachute.json",
        "--set-path=/notes",
        "--set-path=/vault/default",
      ]);

      // Hub + well-known now point at localhost HTTP, not a file path.
      // Target path mirrors mount exactly so tailscale's strip-then-forward
      // is a no-op; otherwise SPAs at /<mount>/ redirect-loop.
      const hubCall = serveCalls.find((c) => c.includes("--set-path=/"));
      expect(hubCall?.[hubCall.length - 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

      const wkCall = serveCalls.find((c) => c.includes("--set-path=/.well-known/parachute.json"));
      expect(wkCall?.[wkCall.length - 1]).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/\.well-known\/parachute\.json$/,
      );

      // Service targets also include their mount path to prevent tailscale
      // from stripping the prefix before forwarding to a base-aware backend.
      const notesCall = serveCalls.find((c) => c.includes("--set-path=/notes"));
      expect(notesCall?.[notesCall.length - 1]).toBe("http://127.0.0.1:5173/notes");
      const vaultCall = serveCalls.find((c) => c.includes("--set-path=/vault/default"));
      expect(vaultCall?.[vaultCall.length - 1]).toBe("http://127.0.0.1:1940/vault/default");

      expect(existsSync(h.wellKnownPath)).toBe(true);
      expect(existsSync(h.hubPath)).toBe(true);
      const wk = JSON.parse(await Bun.file(h.wellKnownPath).text());
      expect(wk.vaults).toHaveLength(1);

      const state = readExposeState(h.statePath);
      expect(state?.layer).toBe("tailnet");
      expect(state?.mode).toBe("path");
      expect(state?.entries).toHaveLength(4);
      // All four entries are proxy now — no file-backed tailscale serve.
      expect(state?.entries.every((e) => e.kind === "proxy")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("spawns hub server with --port + --well-known-dir", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const { runner } = makeRunner();
      const { spawner, calls: hubCalls } = makeHubSpawner(7777);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        log: () => {},
      });
      expect(code).toBe(0);
      expect(hubCalls).toHaveLength(1);
      const cmd = hubCalls[0] ?? [];
      expect(cmd[0]).toBe("bun");
      expect(cmd).toContain("--port");
      expect(cmd).toContain("--well-known-dir");
      expect(cmd).toContain(h.wellKnownDir);
    } finally {
      h.cleanup();
    }
  });

  test("trailing-slash mount preserves trailing slash in target URL", async () => {
    // Aaron hit ERR_TOO_MANY_REDIRECTS on /notes/ because tailscale strips
    // the prefix, Vite (base=/notes) redirects back to /notes/, tailscale
    // strips again, loop. Pinning target = mount byte-for-byte breaks that.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-notes",
          port: 5173,
          paths: ["/notes/"],
          health: "/notes/health",
          version: "0.0.1",
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        log: () => {},
      });
      expect(code).toBe(0);
      const serveCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"),
      );
      const notesCall = serveCalls.find((c) => c.includes("--set-path=/notes/"));
      expect(notesCall).toBeDefined();
      expect(notesCall?.[notesCall.length - 1]).toBe("http://127.0.0.1:5173/notes/");
    } finally {
      h.cleanup();
    }
  });

  test("legacy paths:[/] entry is remapped to /<shortname> with warning", async () => {
    const h = makeHarness();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);

      const serveCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"),
      );
      const mounts = serveCalls.map((c) => c.find((a) => a.startsWith("--set-path="))).sort();
      expect(mounts).toContain("--set-path=/vault");
      expect(mounts).toContain("--set-path=/");
      expect(mounts.filter((m) => m === "--set-path=/")).toHaveLength(1);

      expect(logs.join("\n")).toMatch(/parachute-vault claims "\/"; hub page lives there/);
    } finally {
      h.cleanup();
    }
  });

  test("empty manifest exits 1 with hint", async () => {
    const h = makeHarness();
    try {
      const { runner } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/No services installed/);
    } finally {
      h.cleanup();
    }
  });

  test("missing tailscale exits 1 with install hint", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const runner: Runner = async () => {
        throw new Error("spawn tailscale ENOENT");
      };
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/tailscale is not installed/);
    } finally {
      h.cleanup();
    }
  });

  test("idempotent re-run: tears down prior state first", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      writeExposeState(
        {
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [
            {
              kind: "proxy",
              mount: "/old-service",
              target: "http://127.0.0.1:9999",
              service: "parachute-old",
            },
          ],
        },
        h.statePath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        log: () => {},
      });
      expect(code).toBe(0);
      const offs = calls.filter((c) => c[c.length - 1] === "off");
      expect(offs).toHaveLength(1);
      expect(offs[0]).toContain("--set-path=/old-service");
    } finally {
      h.cleanup();
    }
  });

  test("bringup failure propagates exit code", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const runner: Runner = async (cmd) => {
        if (cmd[1] === "version") return { code: 0, stdout: "", stderr: "" };
        if (cmd[1] === "status") {
          return {
            code: 0,
            stdout: JSON.stringify({ Self: { DNSName: "parachute.taildf9ce2.ts.net." } }),
            stderr: "",
          };
        }
        if (cmd[1] === "serve" && cmd.includes("--bg")) {
          return { code: 2, stdout: "", stderr: "port 443 already in use" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(2);
      expect(logs.join("\n")).toMatch(/Bringup failed/);
    } finally {
      h.cleanup();
    }
  });
});

describe("expose tailnet off", () => {
  test("no-op when no prior state", async () => {
    const h = makeHarness();
    try {
      const { runner, calls } = makeRunner();
      const logs: string[] = [];
      const code = await exposeTailnet("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: hubStopOpts(),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/Nothing to tear down/);
    } finally {
      h.cleanup();
    }
  });

  test("tears down every tracked entry, stops hub, and clears state", async () => {
    const h = makeHarness();
    try {
      writeExposeState(
        {
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1939",
              service: "hub",
            },
            {
              kind: "proxy",
              mount: "/.well-known/parachute.json",
              target: "http://127.0.0.1:1939/.well-known/parachute.json",
              service: "well-known",
            },
          ],
        },
        h.statePath,
      );
      await Bun.write(h.wellKnownPath, "{}\n");
      await Bun.write(h.hubPath, "<html/>\n");
      writePid("hub", 4242, h.configDir);
      const { runner, calls } = makeRunner();
      const signals: NodeJS.Signals[] = [];
      let aliveNow = true;
      const code = await exposeTailnet("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: {
          kill: (_pid, sig) => {
            signals.push(sig as NodeJS.Signals);
            aliveNow = false;
          },
          alive: () => aliveNow,
          sleep: async () => {},
          now: () => 0,
        },
        log: () => {},
      });
      expect(code).toBe(0);
      expect(calls.every((c) => c[c.length - 1] === "off")).toBe(true);
      expect(calls).toHaveLength(2);
      expect(existsSync(h.statePath)).toBe(false);
      expect(existsSync(h.wellKnownPath)).toBe(false);
      expect(existsSync(h.hubPath)).toBe(false);
      // Hub was running and got stopped.
      expect(signals).toContain("SIGTERM");
    } finally {
      h.cleanup();
    }
  });

  test("leaves state in place on teardown failure", async () => {
    const h = makeHarness();
    try {
      writeExposeState(
        {
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1940",
              service: "parachute-vault",
            },
          ],
        },
        h.statePath,
      );
      const runner: Runner = async () => ({ code: 5, stdout: "", stderr: "tailscale blew up" });
      const logs: string[] = [];
      const code = await exposeTailnet("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: hubStopOpts(),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(5);
      expect(existsSync(h.statePath)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("tailnet off does not tear down public exposure or stop the hub", async () => {
    const h = makeHarness();
    try {
      writeExposeState(
        {
          version: 1,
          layer: "public",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: true,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1939",
              service: "hub",
            },
          ],
        },
        h.statePath,
      );
      writePid("hub", 4242, h.configDir);
      const { runner, calls } = makeRunner();
      let killCalled = false;
      const logs: string[] = [];
      const code = await exposeTailnet("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: {
          kill: () => {
            killCalled = true;
          },
          alive: () => false,
          sleep: async () => {},
          now: () => 0,
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(existsSync(h.statePath)).toBe(true);
      expect(killCalled).toBe(false);
      expect(logs.join("\n")).toMatch(/Current exposure is Public/);
    } finally {
      h.cleanup();
    }
  });
});

describe("expose public up", () => {
  test("adds --funnel to every serve command and records layer=public", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposePublic("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);

      const serveCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"),
      );
      expect(serveCalls).toHaveLength(4);
      expect(serveCalls.every((c) => c.includes("--funnel"))).toBe(true);

      const state = readExposeState(h.statePath);
      expect(state?.layer).toBe("public");
      expect(state?.funnel).toBe(true);
      expect(state?.entries).toHaveLength(4);

      expect(logs.join("\n")).toMatch(/Public exposure active/);
    } finally {
      h.cleanup();
    }
  });

  test("switching from tailnet to public tears down prior state first", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      writeExposeState(
        {
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1940",
              service: "parachute-vault",
            },
          ],
        },
        h.statePath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposePublic("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        log: () => {},
      });
      expect(code).toBe(0);
      const offs = calls.filter((c) => c[c.length - 1] === "off");
      expect(offs).toHaveLength(1);
      const state = readExposeState(h.statePath);
      expect(state?.layer).toBe("public");
    } finally {
      h.cleanup();
    }
  });
});

describe("expose public off", () => {
  test("tears down public exposure and clears state", async () => {
    const h = makeHarness();
    try {
      writeExposeState(
        {
          version: 1,
          layer: "public",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: true,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1939",
              service: "hub",
            },
          ],
        },
        h.statePath,
      );
      const { runner, calls } = makeRunner();
      const code = await exposePublic("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: hubStopOpts(),
        log: () => {},
      });
      expect(code).toBe(0);
      expect(calls.every((c) => c[c.length - 1] === "off")).toBe(true);
      expect(existsSync(h.statePath)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("public off does not tear down tailnet exposure", async () => {
    const h = makeHarness();
    try {
      writeExposeState(
        {
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1940",
              service: "parachute-vault",
            },
          ],
        },
        h.statePath,
      );
      const { runner, calls } = makeRunner();
      const logs: string[] = [];
      const code = await exposePublic("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: hubStopOpts(),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(existsSync(h.statePath)).toBe(true);
      expect(logs.join("\n")).toMatch(/Current exposure is Tailnet/);
    } finally {
      h.cleanup();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exposePublic, exposeTailnet } from "../commands/expose.ts";
import { readExposeState, writeExposeState } from "../expose-state.ts";
import { upsertService } from "../services-manifest.ts";
import type { Runner } from "../tailscale/run.ts";

interface Harness {
  manifestPath: string;
  statePath: string;
  wellKnownPath: string;
  hubPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-expose-"));
  return {
    manifestPath: join(dir, "services.json"),
    statePath: join(dir, "expose-state.json"),
    wellKnownPath: join(dir, "well-known", "parachute.json"),
    hubPath: join(dir, "well-known", "hub.html"),
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
  test("mounts hub at /, one proxy per service, plus well-known", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const { runner, calls } = makeRunner();
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
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

      const hubCall = serveCalls.find((c) => c.includes("--set-path=/"));
      expect(hubCall?.[hubCall.length - 1]).toBe(h.hubPath);

      expect(existsSync(h.wellKnownPath)).toBe(true);
      expect(existsSync(h.hubPath)).toBe(true);
      const wk = JSON.parse(await Bun.file(h.wellKnownPath).text());
      expect(wk.vaults).toHaveLength(1);
      expect(wk.vaults[0]).toEqual({
        name: "default",
        url: "https://parachute.taildf9ce2.ts.net/vault/default",
        version: "0.2.4",
      });
      expect(wk.notes?.url).toBe("https://parachute.taildf9ce2.ts.net/notes");
      expect(wk.services).toHaveLength(2);
      expect(wk.services.map((s: { name: string }) => s.name).sort()).toEqual([
        "parachute-notes",
        "parachute-vault",
      ]);

      const state = readExposeState(h.statePath);
      expect(state?.layer).toBe("tailnet");
      expect(state?.canonicalFqdn).toBe("parachute.taildf9ce2.ts.net");
      expect(state?.mode).toBe("path");
      expect(state?.entries).toHaveLength(4);
      expect(state?.funnel).toBe(false);
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
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
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
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
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
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
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
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
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
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
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
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/Nothing to tear down/);
    } finally {
      h.cleanup();
    }
  });

  test("tears down every tracked entry and clears state", async () => {
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
            {
              kind: "file",
              mount: "/.well-known/parachute.json",
              target: h.wellKnownPath,
              service: "well-known",
            },
          ],
        },
        h.statePath,
      );
      await Bun.write(h.wellKnownPath, "{}\n");
      await Bun.write(h.hubPath, "<html/>\n");
      const { runner, calls } = makeRunner();
      const code = await exposeTailnet("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(calls.every((c) => c[c.length - 1] === "off")).toBe(true);
      expect(calls).toHaveLength(2);
      expect(existsSync(h.statePath)).toBe(false);
      expect(existsSync(h.wellKnownPath)).toBe(false);
      expect(existsSync(h.hubPath)).toBe(false);
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
        log: (l) => logs.push(l),
      });
      expect(code).toBe(5);
      expect(existsSync(h.statePath)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("tailnet off does not tear down public exposure", async () => {
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
              target: "http://127.0.0.1:1940",
              service: "parachute-vault",
            },
          ],
        },
        h.statePath,
      );
      const { runner, calls } = makeRunner();
      const logs: string[] = [];
      const code = await exposeTailnet("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(existsSync(h.statePath)).toBe(true);
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
      const logs: string[] = [];
      const code = await exposePublic("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
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
      const code = await exposePublic("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
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
              target: "http://127.0.0.1:1940",
              service: "parachute-vault",
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

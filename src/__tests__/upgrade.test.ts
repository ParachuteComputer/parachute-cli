import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpgradeRunner } from "../commands/upgrade.ts";
import { upgrade } from "../commands/upgrade.ts";
import { upsertService } from "../services-manifest.ts";

interface RunCall {
  cmd: string[];
  cwd?: string;
  kind: "run" | "capture";
}

interface MockRunner {
  runner: UpgradeRunner;
  calls: RunCall[];
}

/**
 * Build a runner stub that scripts responses by command-prefix match. The
 * matcher walks the responses array in order; the first entry whose `match`
 * function returns true wins. Unmatched commands return code 0 / empty
 * stdout, which keeps the happy path quiet.
 */
function makeRunner(
  responses: Array<{
    match: (cmd: readonly string[]) => boolean;
    code?: number;
    stdout?: string;
  }> = [],
): MockRunner {
  const calls: RunCall[] = [];
  const find = (cmd: readonly string[]) => responses.find((r) => r.match(cmd));
  return {
    calls,
    runner: {
      async run(cmd, opts) {
        calls.push({ cmd: [...cmd], cwd: opts?.cwd, kind: "run" });
        return find(cmd)?.code ?? 0;
      },
      async capture(cmd, opts) {
        calls.push({ cmd: [...cmd], cwd: opts?.cwd, kind: "capture" });
        const r = find(cmd);
        return { code: r?.code ?? 0, stdout: r?.stdout ?? "" };
      },
    },
  };
}

interface Harness {
  configDir: string;
  manifestPath: string;
  installRoot: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-upgrade-"));
  return {
    configDir: dir,
    manifestPath: join(dir, "services.json"),
    installRoot: join(dir, "installs"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writePackageJson(dir: string, body: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(body, null, 2));
}

function seedVault(manifestPath: string, installDir: string, version = "0.4.0"): void {
  upsertService(
    {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
      version,
      installDir,
    },
    manifestPath,
  );
}

describe("parachute upgrade", () => {
  test("errors cleanly when no services installed", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const m = makeRunner();
      const code = await upgrade(undefined, {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner: m.runner,
        findGlobalInstall: () => null,
        restartFn: async () => 0,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/No services installed/);
    } finally {
      h.cleanup();
    }
  });

  test("errors cleanly on unknown service", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath, join(h.installRoot, "vault"));
      const logs: string[] = [];
      const m = makeRunner();
      const code = await upgrade("nope", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner: m.runner,
        findGlobalInstall: () => null,
        restartFn: async () => 0,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/unknown service/);
    } finally {
      h.cleanup();
    }
  });

  test("bun-linked happy path: pulls, reinstalls deps, restarts", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir);

      const m = makeRunner([
        {
          match: (c) => c[0] === "git" && c[1] === "rev-parse" && c[2] === "--is-inside-work-tree",
          code: 0,
        },
        {
          match: (c) => c[0] === "git" && c[1] === "status" && c[2] === "--porcelain",
          code: 0,
          stdout: "",
        },
        // First HEAD read (before pull) — old SHA
        // Sequence: capture matchers fire in order; we use a stateful counter
      ]);

      // Stateful HEAD: first capture returns "abc", second returns "def"
      let headCalls = 0;
      const runner: UpgradeRunner = {
        async run(cmd, opts) {
          m.calls.push({ cmd: [...cmd], cwd: opts?.cwd, kind: "run" });
          if (cmd[0] === "git" && cmd[1] === "pull") return 0;
          if (cmd[0] === "bun" && cmd[1] === "install") return 0;
          return 0;
        },
        async capture(cmd, opts) {
          m.calls.push({ cmd: [...cmd], cwd: opts?.cwd, kind: "capture" });
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 0, stdout: "true" };
          }
          if (cmd[1] === "status") return { code: 0, stdout: "" };
          if (cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
            headCalls++;
            return { code: 0, stdout: headCalls === 1 ? "aaaaaaa" : "bbbbbbb" };
          }
          if (cmd[1] === "diff") {
            return { code: 0, stdout: "package.json\nsrc/foo.ts" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartedShort: string | undefined;
      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async (svc) => {
          restartedShort = svc;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(restartedShort).toBe("vault");
      const joined = logs.join("\n");
      expect(joined).toMatch(/bun-linked checkout/);
      expect(joined).toMatch(/git pull --ff-only/);
      expect(joined).toMatch(/bun install --frozen-lockfile/);
      expect(joined).toMatch(/aaaaaa.*→.*bbbbbb/);
      expect(joined).toMatch(/restarting/);
    } finally {
      h.cleanup();
    }
  });

  test("bun-linked, HEAD unchanged: no-op skip-restart", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir);

      const runner: UpgradeRunner = {
        async run() {
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 0, stdout: "true" };
          }
          if (cmd[1] === "status") return { code: 0, stdout: "" };
          if (cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
            return { code: 0, stdout: "abcdef0" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartCalled = false;
      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async () => {
          restartCalled = true;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(restartCalled).toBe(false);
      expect(logs.join("\n")).toMatch(/already up to date/);
    } finally {
      h.cleanup();
    }
  });

  test("bun-linked refuses on dirty working tree", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir);

      const runner: UpgradeRunner = {
        async run() {
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 0, stdout: "true" };
          }
          if (cmd[1] === "status") {
            return { code: 0, stdout: " M src/foo.ts\n" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartCalled = false;
      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async () => {
          restartCalled = true;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(restartCalled).toBe(false);
      expect(logs.join("\n")).toMatch(/dirty working tree/);
    } finally {
      h.cleanup();
    }
  });

  test("bun-linked frontend: runs bun run build before restart", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "notes");
      writePackageJson(installDir, {
        name: "@openparachute/notes",
        version: "0.0.1",
        scripts: { build: "vite build" },
      });
      upsertService(
        {
          name: "parachute-notes",
          port: 1942,
          paths: ["/notes"],
          health: "/notes/health",
          version: "0.0.1",
          installDir,
        },
        h.manifestPath,
      );

      let headCalls = 0;
      const ranBuild = { value: false };
      const runner: UpgradeRunner = {
        async run(cmd) {
          if (cmd[0] === "bun" && cmd[1] === "run" && cmd[2] === "build") {
            ranBuild.value = true;
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 0, stdout: "true" };
          }
          if (cmd[1] === "status") return { code: 0, stdout: "" };
          if (cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
            headCalls++;
            return { code: 0, stdout: headCalls === 1 ? "111" : "222" };
          }
          if (cmd[1] === "diff") return { code: 0, stdout: "src/x.ts" };
          return { code: 0, stdout: "" };
        },
      };

      const code = await upgrade("notes", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async () => 0,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(ranBuild.value).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("npm-installed happy path: bun add -g, version bumps, restarts", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      // Initial version 0.4.0
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir, "0.4.0");

      const runner: UpgradeRunner = {
        async run(cmd) {
          // Simulate `bun add -g` rewriting the package.json with a new version
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            writePackageJson(installDir, { name: "@openparachute/vault", version: "0.5.0" });
          }
          return 0;
        },
        async capture(cmd) {
          // Not a git checkout
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "fatal: not a git repository\n" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartedShort: string | undefined;
      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async (svc) => {
          restartedShort = svc;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(restartedShort).toBe("vault");
      const joined = logs.join("\n");
      expect(joined).toMatch(/npm-installed/);
      expect(joined).toMatch(/bun add -g @openparachute\/vault@latest/);
      expect(joined).toMatch(/0\.4\.0 → 0\.5\.0/);
    } finally {
      h.cleanup();
    }
  });

  test("npm-installed: version unchanged → skip restart", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir, "0.4.0");

      // Don't change package.json on bun add -g — same version after.
      const runner: UpgradeRunner = {
        async run() {
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      let restartCalled = false;
      const logs: string[] = [];
      const code = await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async () => {
          restartCalled = true;
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(restartCalled).toBe(false);
      expect(logs.join("\n")).toMatch(/already at 0\.4\.0/);
    } finally {
      h.cleanup();
    }
  });

  test("npm-installed: --tag is forwarded to bun add -g", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.installRoot, "vault");
      writePackageJson(installDir, { name: "@openparachute/vault", version: "0.4.0" });
      seedVault(h.manifestPath, installDir, "0.4.0");

      const seenCmd: string[][] = [];
      const runner: UpgradeRunner = {
        async run(cmd) {
          seenCmd.push([...cmd]);
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      await upgrade("vault", {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: () => join(installDir, "package.json"),
        restartFn: async () => 0,
        tag: "rc",
        log: () => {},
      });
      const addCall = seenCmd.find((c) => c[0] === "bun" && c[1] === "add");
      expect(addCall).toEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
    } finally {
      h.cleanup();
    }
  });

  test("sweep (no svc): partial failure — later targets still run; first failure code wins", async () => {
    const h = makeHarness();
    try {
      const vaultDir = join(h.installRoot, "vault");
      const notesDir = join(h.installRoot, "notes");
      writePackageJson(vaultDir, { name: "@openparachute/vault", version: "0.4.0" });
      writePackageJson(notesDir, { name: "@openparachute/notes", version: "0.0.1" });
      seedVault(h.manifestPath, vaultDir);
      upsertService(
        {
          name: "parachute-notes",
          port: 1942,
          paths: ["/notes"],
          health: "/notes/health",
          version: "0.0.1",
          installDir: notesDir,
        },
        h.manifestPath,
      );

      // vault is npm-installed (no git); bun add -g fails with 7
      // notes is npm-installed and succeeds with version bump
      const runner: UpgradeRunner = {
        async run(cmd, opts) {
          if (cmd[0] === "bun" && cmd[1] === "add" && cmd[2] === "-g") {
            const pkg = cmd[3] ?? "";
            if (pkg.startsWith("@openparachute/vault")) return 7;
            if (pkg.startsWith("@openparachute/notes")) {
              writePackageJson(notesDir, { name: "@openparachute/notes", version: "0.1.0" });
              return 0;
            }
          }
          return 0;
        },
        async capture(cmd) {
          if (cmd[1] === "rev-parse" && cmd[2] === "--is-inside-work-tree") {
            return { code: 128, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      };

      const restartCalls: string[] = [];
      const logs: string[] = [];
      const code = await upgrade(undefined, {
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        runner,
        findGlobalInstall: (pkg) => {
          if (pkg === "@openparachute/vault") return join(vaultDir, "package.json");
          if (pkg === "@openparachute/notes") return join(notesDir, "package.json");
          return null;
        },
        restartFn: async (svc) => {
          restartCalls.push(svc);
          return 0;
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(7);
      expect(restartCalls).toEqual(["notes"]);
      expect(logs.join("\n")).toMatch(/vault: bun add -g failed \(exit 7\)/);
    } finally {
      h.cleanup();
    }
  });
});

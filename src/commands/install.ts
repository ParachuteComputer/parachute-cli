import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { autoWireScribeAuth } from "../auto-wire.ts";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import {
  CANONICAL_PORT_MAX,
  CANONICAL_PORT_MIN,
  getSpec,
  isCanonicalPort,
  knownServices,
} from "../service-spec.ts";
import { findService, upsertService } from "../services-manifest.ts";
import { start as lifecycleStart } from "./lifecycle.ts";
import { migrateNotice } from "./migrate.ts";

export type Runner = (cmd: readonly string[]) => Promise<number>;

/**
 * Transition aliases for services that were renamed. Accepted for one
 * release cycle with a rename notice, then removed. `lens → notes`
 * exists because the frontend was briefly renamed Notes → Lens (Apr 19)
 * and then reverted (Apr 22) on launch eve. Anyone who ran `parachute
 * install lens` during the ~3-day window keeps working. Remove after
 * launch sinks in and `parachute install lens` has stopped appearing
 * in support threads.
 */
const SERVICE_ALIASES: Record<string, string> = {
  lens: "notes",
};

export interface InstallOpts {
  runner?: Runner;
  manifestPath?: string;
  configDir?: string;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * True when the package is already globally linked (via `bun link`) so
   * `bun add -g` would be redundant — or worse, fail with a 404 for a
   * package that isn't published to npm yet (the scribe case on 2026-04-19).
   * Defaults to a symlink check against bun's global node_modules prefix.
   */
  isLinked?: (pkg: string) => boolean;
  /**
   * Optional npm dist-tag or exact version to install. When set, the
   * `bun add -g` call is composed as `<package>@<tag>` so RC testers can
   * pin a pre-release channel. `isLinked` still short-circuits — if the
   * package is bun-linked locally, the tag is moot.
   */
  tag?: string;
  /**
   * Override the random-token source for the vault↔scribe auto-wire.
   * Tests pass a deterministic string; production uses crypto.randomBytes.
   */
  randomToken?: () => string;
  /**
   * Probe whether `pkg` is present at bun's global node_modules (returns the
   * package.json path on hit, null on miss). Used after `bun add -g` returns
   * non-zero to distinguish a real failure from bun 1.2.x's noisy
   * lockfile-recovery path — where the package *is* actually installed
   * despite the exit code. Defaults to a filesystem probe against
   * `bunGlobalPrefixes()`.
   */
  findGlobalInstall?: (pkg: string) => string | null;
  /**
   * Skip the post-install daemon start. The launch-day default is to leave
   * the service running so users don't have to remember the second command;
   * pass `true` for piped / CI installs that own their own process model.
   */
  noStart?: boolean;
  /**
   * Test seam: lifecycle start hook used by the post-install auto-start.
   * Defaults to `lifecycle.start(short, …)`. Tests inject a fake to assert
   * the call without spawning a real child.
   */
  startService?: (short: string) => Promise<number>;
}

async function defaultRunner(cmd: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...cmd], { stdio: ["inherit", "inherit", "inherit"] });
  return await proc.exited;
}

function bunGlobalPrefixes(): string[] {
  const prefixes: string[] = [];
  const fromEnv = process.env.BUN_INSTALL;
  if (fromEnv) prefixes.push(join(fromEnv, "install", "global", "node_modules"));
  prefixes.push(join(homedir(), ".bun", "install", "global", "node_modules"));
  return prefixes;
}

function defaultIsLinked(pkg: string): boolean {
  for (const prefix of bunGlobalPrefixes()) {
    const path = join(prefix, ...pkg.split("/"));
    try {
      if (lstatSync(path).isSymbolicLink()) return true;
    } catch {
      // Not present at this prefix; try the next.
    }
  }
  return false;
}

function defaultFindGlobalInstall(pkg: string): string | null {
  for (const prefix of bunGlobalPrefixes()) {
    const pkgJsonPath = join(prefix, ...pkg.split("/"), "package.json");
    try {
      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (typeof parsed?.name === "string" && typeof parsed?.version === "string") {
        return pkgJsonPath;
      }
    } catch {
      // Not present / not valid at this prefix; try the next.
    }
  }
  return null;
}

export async function install(service: string, opts: InstallOpts = {}): Promise<number> {
  const runner = opts.runner ?? defaultRunner;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line) => console.log(line));
  const isLinked = opts.isLinked ?? defaultIsLinked;
  const findGlobalInstall = opts.findGlobalInstall ?? defaultFindGlobalInstall;

  const aliased = SERVICE_ALIASES[service];
  if (aliased !== undefined) {
    log(`"${service}" has been renamed to "${aliased}"; installing ${aliased}.`);
  }
  const resolvedService = aliased ?? service;

  const spec = getSpec(resolvedService);
  if (!spec) {
    log(`unknown service: "${resolvedService}"`);
    log(`known services: ${knownServices().join(", ")}`);
    return 1;
  }

  if (isLinked(spec.package)) {
    log(`${spec.package} is already linked globally (bun link) — skipping bun add.`);
  } else {
    const addSpec = opts.tag ? `${spec.package}@${opts.tag}` : spec.package;
    log(`Installing ${addSpec}…`);
    const addCode = await runner(["bun", "add", "-g", addSpec]);
    if (addCode !== 0) {
      // Bun 1.2.x has a noisy lockfile-recovery path where `bun add -g` prints
      // InvalidPackageResolution + "Failed to install 1 package" and exits 1,
      // *even though the package is successfully installed* (you can see
      // "installed @openparachute/<foo> with binaries" in the same output).
      // Bailing here on exit code alone means the caller-visible install
      // fails and downstream init/seed never runs — so probe the global
      // prefix before treating non-zero as fatal.
      const foundAt = findGlobalInstall(spec.package);
      if (foundAt) {
        log(`bun add reported exit ${addCode} but ${spec.package} is installed at ${foundAt}.`);
        log(
          "Known bun 1.2.x lockfile quirk — the package landed despite the warning. Proceeding. `bun upgrade` to 1.3.x avoids it.",
        );
      } else {
        log(`bun add -g ${addSpec} failed (exit ${addCode})`);
        return addCode;
      }
    }
  }

  if (spec.init) {
    log(`Running ${spec.init.join(" ")}…`);
    const initCode = await runner(spec.init);
    if (initCode !== 0) {
      log(`${spec.init.join(" ")} exited ${initCode}`);
      return initCode;
    }
  }

  let entry = findService(spec.manifestName, manifestPath);
  if (!entry && spec.seedEntry) {
    entry = spec.seedEntry();
    upsertService(entry, manifestPath);
    log(
      `Seeded services.json entry for ${spec.manifestName} (placeholder; service's own boot will overwrite).`,
    );
  }

  if (!entry) {
    log(
      `Installed, but no services.json entry for "${spec.manifestName}" yet. Run \`parachute status\` after the service has started.`,
    );
  } else {
    log(`✓ ${spec.manifestName} registered on port ${entry.port}`);
    if (!isCanonicalPort(entry.port)) {
      log(
        `⚠ port ${entry.port} is outside the canonical Parachute range (${CANONICAL_PORT_MIN}–${CANONICAL_PORT_MAX}); may conflict with other software.`,
      );
    }
  }

  // Auto-wire the vault↔scribe shared secret + SCRIBE_URL when both services
  // end up installed. Fires from either install order (scribe then vault, or
  // vault then scribe). Idempotent — preserves any pre-existing values in
  // vault .env. Restarts vault if it's running so the worker re-reads .env.
  if (spec.manifestName === "parachute-vault" || spec.manifestName === "parachute-scribe") {
    const vaultPresent = !!findService("parachute-vault", manifestPath);
    const scribePresent = !!findService("parachute-scribe", manifestPath);
    if (vaultPresent && scribePresent) {
      const autoWireOpts: Parameters<typeof autoWireScribeAuth>[0] = { configDir, log };
      if (opts.randomToken) autoWireOpts.randomToken = opts.randomToken;
      await autoWireScribeAuth(autoWireOpts);
    }
  }

  const notice = migrateNotice(configDir, now());
  if (notice) log(notice);

  // Auto-start: vault and notes' inits historically left a daemon running, but
  // scribe (and any service without a daemon-launching init) didn't — so
  // launch-day `install scribe` ended with a silent install and the user
  // wondering why nothing happened. Always end with the daemon running unless
  // the caller opted out (CI / piped scripts). Idempotent: if the service is
  // already up, lifecycle.start no-ops via the existing PID-file check.
  if (!opts.noStart) {
    const startService =
      opts.startService ??
      ((short: string) => lifecycleStart(short, { manifestPath, configDir, log }));
    const startCode = await startService(resolvedService);
    if (startCode !== 0) {
      log(
        `⚠ ${resolvedService} didn't start cleanly. Run manually: parachute start ${resolvedService}`,
      );
    }
  }

  // Per-service install footer — canonical next-step URLs and configuration
  // hints. Vault prints its own (richer) footer from `parachute-vault init`
  // (PR #166), so the spec leaves vault out and we don't double up here.
  const footer = spec.postInstallFooter?.();
  if (footer) {
    for (const line of footer) log(line);
  }

  return 0;
}

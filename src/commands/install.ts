import { lstatSync } from "node:fs";
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
import { migrateNotice } from "./migrate.ts";

export type Runner = (cmd: readonly string[]) => Promise<number>;

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

export async function install(service: string, opts: InstallOpts = {}): Promise<number> {
  const runner = opts.runner ?? defaultRunner;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line) => console.log(line));
  const isLinked = opts.isLinked ?? defaultIsLinked;

  const spec = getSpec(service);
  if (!spec) {
    log(`unknown service: "${service}"`);
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
      log(`bun add -g ${addSpec} failed (exit ${addCode})`);
      return addCode;
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

  // Auto-wire the vault↔scribe shared secret when both services end up
  // installed. Fires from either install order (scribe then vault, or vault
  // then scribe). Idempotent — preserves any pre-existing token in vault .env.
  if (spec.manifestName === "parachute-vault" || spec.manifestName === "parachute-scribe") {
    const vaultPresent = !!findService("parachute-vault", manifestPath);
    const scribePresent = !!findService("parachute-scribe", manifestPath);
    if (vaultPresent && scribePresent) {
      const autoWireOpts: Parameters<typeof autoWireScribeAuth>[0] = { configDir, log };
      if (opts.randomToken) autoWireOpts.randomToken = opts.randomToken;
      autoWireScribeAuth(autoWireOpts);
    }
  }

  const notice = migrateNotice(configDir, now());
  if (notice) log(notice);

  return 0;
}

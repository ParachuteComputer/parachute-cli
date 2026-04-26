import { lstatSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { autoWireScribeAuth } from "../auto-wire.ts";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { assignServicePort } from "../port-assign.ts";
import {
  CANONICAL_PORT_MAX,
  CANONICAL_PORT_MIN,
  getSpec,
  isCanonicalPort,
  knownServices,
} from "../service-spec.ts";
import { findService, readManifest, upsertService } from "../services-manifest.ts";
import { start as lifecycleStart } from "./lifecycle.ts";
import { migrateNotice } from "./migrate.ts";
import {
  type InteractiveAvailability,
  type SetupScribeProviderOpts,
  setupScribeProvider,
} from "./scribe-provider-interactive.ts";

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
  /**
   * `parachute install scribe` only: pre-pick the transcription provider so
   * the prompt doesn't fire. Validated against scribe's known providers — an
   * unknown name is logged and the config is left at default.
   */
  scribeProvider?: string;
  /**
   * `parachute install scribe` only: pre-supply the API key for the chosen
   * provider. Ignored for local providers (parakeet-mlx / onnx-asr / whisper).
   */
  scribeKey?: string;
  /**
   * Test seam for the scribe provider picker. Tests pass `{ kind: "available",
   * prompt: ... }` to drive the prompt without a real TTY; production lets
   * the default sense `process.stdin.isTTY`.
   */
  scribeAvailability?: InteractiveAvailability;
  /**
   * Test seam for the canonical-slot TCP probe. Production probes
   * `127.0.0.1:<port>` with a short timeout; tests inject deterministic
   * answers. Always returns false in tests so canonical slots stay free
   * unless the test populates services.json directly.
   */
  portProbe?: (port: number) => Promise<boolean>;
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

/**
 * Short-timeout TCP probe of `127.0.0.1:<port>`. Used by `parachute install`
 * to detect canonical slots that something else is already on. Fail-open:
 * timeouts and errors return `false` so a flaky probe never blocks an
 * install.
 */
async function defaultPortProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (taken: boolean) => {
      if (settled) return;
      settled = true;
      resolve(taken);
    };
    try {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(150, () => {
        socket.destroy();
        finish(false);
      });
      socket.on("connect", () => {
        socket.end();
        finish(true);
      });
      socket.on("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function collectOccupiedPorts(
  manifestPath: string,
  selfManifestName: string,
  selfPort: number | undefined,
  probe: (port: number) => Promise<boolean>,
): Promise<Set<number>> {
  const ports = new Set<number>();
  try {
    const manifest = readManifest(manifestPath);
    for (const svc of manifest.services) {
      if (svc.name === selfManifestName) continue;
      ports.add(svc.port);
    }
  } catch {
    // Manifest missing or malformed — fall back to the TCP probe alone.
  }
  for (let p = CANONICAL_PORT_MIN; p <= CANONICAL_PORT_MAX; p++) {
    if (selfPort !== undefined && p === selfPort) continue;
    try {
      if (await probe(p)) ports.add(p);
    } catch {
      // Probe error — fail-open per CLI port-authority policy.
    }
  }
  return ports;
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
        // Make the failure mode legible: enumerating the prefixes we probed
        // turns "bun add -g failed" into something an operator on a non-
        // standard bun layout can act on. (Surfaced by parachute-cli#44 — a
        // bun 1.2.x report where `notes` never registered; if the same
        // failure mode ever manifests via findGlobalInstall returning null,
        // the log tells us where to look.)
        log(`bun add -g ${addSpec} failed (exit ${addCode})`);
        log(`  probed bun globals at: ${bunGlobalPrefixes().join(", ")}`);
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

  // CLI-as-port-authority (#53): pick the service's port now and persist it
  // via `~/.parachute/<svc>/.env`. lifecycle.start merges that .env into the
  // spawn env (PR #50), so the next daemon boot binds the port we picked.
  // Idempotent — an existing PORT in .env wins, so re-installs and
  // user-edited ports survive across upgrades. Compiled-in service-side
  // fallbacks (vault → 1940 etc.) stay; this just adds a CLI-managed
  // override.
  const preInitEntry = findService(spec.manifestName, manifestPath);
  const probe = opts.portProbe ?? defaultPortProbe;
  const occupied = await collectOccupiedPorts(
    manifestPath,
    spec.manifestName,
    preInitEntry?.port,
    probe,
  );
  const envPath = join(configDir, resolvedService, ".env");
  const canonicalPort = spec.seedEntry?.().port ?? preInitEntry?.port;
  const portResult = assignServicePort({
    envPath,
    canonical: canonicalPort,
    occupied,
  });
  if (portResult.warning) {
    log(`⚠ ${portResult.warning}`);
  }
  if (portResult.written) {
    log(`Wrote PORT=${portResult.port} to ${envPath}.`);
  }

  // Find-or-seed the manifest entry. Re-read after the seed write so a silent
  // upsert failure (filesystem permission, races against an external writer)
  // surfaces as a loud log line instead of a phantom "registered" claim.
  // parachute-cli#44 reported notes not appearing in services.json on a fresh
  // bun 1.2.x install; the gate logic was already correct, but a verify-step
  // turns silent loss into something an operator can spot.
  let entry = findService(spec.manifestName, manifestPath);
  if (!entry && spec.seedEntry) {
    const seedBase = spec.seedEntry();
    const seed =
      seedBase.port === portResult.port ? seedBase : { ...seedBase, port: portResult.port };
    upsertService(seed, manifestPath);
    entry = findService(spec.manifestName, manifestPath);
    if (entry) {
      log(
        `Seeded services.json entry for ${spec.manifestName} (placeholder; service's own boot will overwrite).`,
      );
    } else {
      log(
        `⚠ tried to seed services.json entry for ${spec.manifestName}, but the readback came back empty.`,
      );
      log(`  manifest path: ${manifestPath}`);
      log("  Re-run `parachute install` once the underlying issue is resolved.");
    }
  } else if (entry && entry.port !== portResult.port) {
    // init wrote an entry on the canonical port but the CLI assigned a
    // different one (collision). Reflect the CLI's choice so the hub and
    // status views stay consistent with the .env we just wrote.
    upsertService({ ...entry, port: portResult.port }, manifestPath);
    entry = findService(spec.manifestName, manifestPath);
    log(
      `Updated services.json port to ${portResult.port} for ${spec.manifestName} (was ${preInitEntry?.port ?? "—"}).`,
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

  // Scribe-only: prompt for transcription provider (or accept --scribe-provider
  // / --scribe-key). Has to land before auto-start so the very first scribe
  // boot reads the right provider — and inside the prompt we restart scribe
  // ourselves if it was already running, mirroring the auto-wire pattern.
  // Failure here doesn't fail the install: a flaky restart shouldn't undo a
  // successful `bun add`.
  if (resolvedService === "scribe") {
    const setupOpts: SetupScribeProviderOpts = { configDir, log };
    if (opts.scribeProvider) setupOpts.preselectProvider = opts.scribeProvider;
    if (opts.scribeKey) setupOpts.preselectKey = opts.scribeKey;
    if (opts.scribeAvailability) setupOpts.availability = opts.scribeAvailability;
    await setupScribeProvider(setupOpts);
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

  // Final registration check — the service may have written its own
  // authoritative entry during init or first boot, replacing the seed (or
  // filling a gap when the service had no seedEntry). Re-read at exit so the
  // last line of the install always reflects ground truth, not an early
  // snapshot. Surfaced by parachute-cli#44 — defensive logging that turns a
  // missing entry into a visible failure rather than a silent one.
  const finalEntry = findService(spec.manifestName, manifestPath);
  if (!finalEntry) {
    log(
      `⚠ ${spec.manifestName} is not in services.json after install. \`parachute status\` won't see it. Re-run install or file a bug.`,
    );
  }

  return 0;
}

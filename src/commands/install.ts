import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import {
  CANONICAL_PORT_MAX,
  CANONICAL_PORT_MIN,
  getSpec,
  isCanonicalPort,
  knownServices,
} from "../service-spec.ts";
import { findService } from "../services-manifest.ts";
import { migrateNotice } from "./migrate.ts";

export type Runner = (cmd: readonly string[]) => Promise<number>;

export interface InstallOpts {
  runner?: Runner;
  manifestPath?: string;
  configDir?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

async function defaultRunner(cmd: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...cmd], { stdio: ["inherit", "inherit", "inherit"] });
  return await proc.exited;
}

export async function install(service: string, opts: InstallOpts = {}): Promise<number> {
  const runner = opts.runner ?? defaultRunner;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line) => console.log(line));

  const spec = getSpec(service);
  if (!spec) {
    log(`unknown service: "${service}"`);
    log(`known services: ${knownServices().join(", ")}`);
    return 1;
  }

  log(`Installing ${spec.package}…`);
  const addCode = await runner(["bun", "add", "-g", spec.package]);
  if (addCode !== 0) {
    log(`bun add -g ${spec.package} failed (exit ${addCode})`);
    return addCode;
  }

  if (spec.init) {
    log(`Running ${spec.init.join(" ")}…`);
    const initCode = await runner(spec.init);
    if (initCode !== 0) {
      log(`${spec.init.join(" ")} exited ${initCode}`);
      return initCode;
    }
  }

  const entry = findService(spec.manifestName, manifestPath);
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

  const notice = migrateNotice(configDir, now());
  if (notice) log(notice);

  return 0;
}

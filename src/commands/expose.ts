import { existsSync, unlinkSync } from "node:fs";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import {
  EXPOSE_STATE_PATH,
  type ExposeLayer,
  type ExposeState,
  clearExposeState,
  readExposeState,
  writeExposeState,
} from "../expose-state.ts";
import {
  type EnsureHubOpts,
  type StopHubOpts,
  defaultPortProbe,
  ensureHubRunning,
  readHubPort,
  stopHub,
} from "../hub-control.ts";
import { HUB_MOUNT, HUB_PATH, writeHubFile } from "../hub.ts";
import { shortNameForManifest } from "../service-spec.ts";
import { type ServiceEntry, readManifest } from "../services-manifest.ts";
import { type ServeEntry, bringupCommand, teardownCommand } from "../tailscale/commands.ts";
import { getFqdn, isTailscaleInstalled } from "../tailscale/detect.ts";
import { type Runner, defaultRunner } from "../tailscale/run.ts";
import {
  WELL_KNOWN_DIR,
  WELL_KNOWN_MOUNT,
  WELL_KNOWN_PATH,
  buildWellKnown,
  shortName,
  writeWellKnownFile,
} from "../well-known.ts";

/**
 * Two exposure layers share a single tailscale serve config on this node.
 * Public layer adds `--funnel` to each handler; everything else is identical.
 *
 * Funnel constraint: Tailscale allows at most three public HTTPS ports per
 * node (443, 8443, 10000). Path-routing packs every service onto a single
 * port — that's why we default to one `--https=443` and mount services under
 * `/vault`, `/notes`, etc. rather than giving each service its own port or
 * subdomain. Subdomain-per-service requires the Tailscale Services feature
 * (virtual-IP advertisement) and is deferred.
 *
 * Hub + well-known entries are HTTP proxies to an internal Bun.serve (see
 * `hub-control.ts`). They used to be `--set-path=<mount> <file>` entries but
 * macOS `tailscaled` runs sandboxed and can't read arbitrary files; proxy
 * mode is the only reliable shape.
 */

export interface ExposeOpts {
  runner?: Runner;
  manifestPath?: string;
  statePath?: string;
  wellKnownPath?: string;
  hubPath?: string;
  /** Directory holding hub.html + parachute.json (passed to the hub server). */
  wellKnownDir?: string;
  configDir?: string;
  port?: number;
  log?: (line: string) => void;
  /** Override detected FQDN — primarily for tests. */
  fqdnOverride?: string;
  /** Overrides for the hub lifecycle — primarily for tests. */
  hubEnsureOpts?: Omit<EnsureHubOpts, "configDir" | "wellKnownDir" | "log">;
  hubStopOpts?: Omit<StopHubOpts, "configDir" | "log">;
  /** Skip spawning the hub server. Tests flip this off to verify it's called. */
  skipHub?: boolean;
  /**
   * Probe a port to decide whether a service is responding. Returns true when
   * something is listening (i.e., bind-probe fails). Primarily a test seam —
   * the default walks every service port before bringup and warns on any
   * that don't answer.
   */
  servicePortProbe?: (port: number) => Promise<boolean>;
}

/**
 * Remap legacy `paths: ["/"]` entries to `/<shortname>` so they don't collide
 * with the hub page at `/`. Emits a warning per remapped service. This is the
 * transitional path for services installed before the vault PR that writes
 * `paths: ["/vault/<default>"]` — once `parachute install` is re-run those
 * entries update themselves and this branch goes dormant.
 */
function remapLegacyRoot(
  services: readonly ServiceEntry[],
  log: (line: string) => void,
): ServiceEntry[] {
  return services.map((s) => {
    const first = s.paths[0];
    if (first !== "/") return s;
    const sn = shortName(s.name);
    const remapped = `/${sn}`;
    log(
      `note: ${s.name} claims "/"; hub page lives there — exposing at "${remapped}" instead. Re-run \`parachute install ${sn}\` to update services.json.`,
    );
    return { ...s, paths: [remapped, ...s.paths.slice(1)] };
  });
}

/**
 * Compose the tailscale serve target URL for a service rooted at `mount`.
 *
 * `tailscale serve --set-path=<mount> <target>` strips `<mount>` from the
 * incoming request path before forwarding. So if the backend expects
 * requests to keep arriving at `<mount>/...` (every SPA with a configured
 * base path, plus vault's `/vault/<name>/` API root) the target URL must
 * include the same mount path — otherwise the backend sees requests at `/`,
 * emits a redirect back to its real base, tailscale strips again, and the
 * client loops on `ERR_TOO_MANY_REDIRECTS`.
 *
 * The rule of thumb is: mount and target path must match byte-for-byte
 * (including trailing slash state), so tailscale's strip-then-forward is a
 * no-op and the backend sees the full path it expects.
 */
function serviceProxyTarget(port: number, mount: string): string {
  return `http://127.0.0.1:${port}${mount}`;
}

function planEntries(services: readonly ServiceEntry[], hubPort: number): ServeEntry[] {
  const entries: ServeEntry[] = [];
  entries.push({
    kind: "proxy",
    mount: HUB_MOUNT,
    target: serviceProxyTarget(hubPort, HUB_MOUNT),
    service: "hub",
  });
  for (const s of services) {
    const mount = s.paths[0] ?? `/${shortName(s.name)}`;
    entries.push({
      kind: "proxy",
      mount,
      target: serviceProxyTarget(s.port, mount),
      service: s.name,
    });
  }
  entries.push({
    kind: "proxy",
    mount: WELL_KNOWN_MOUNT,
    target: serviceProxyTarget(hubPort, WELL_KNOWN_MOUNT),
    service: "well-known",
  });
  return entries;
}

async function runEach(
  runner: Runner,
  commands: string[][],
  log: (line: string) => void,
): Promise<number> {
  for (const cmd of commands) {
    log(`  $ ${cmd.join(" ")}`);
    const { code, stderr } = await runner(cmd);
    if (code !== 0) {
      if (stderr.trim()) log(stderr.trim());
      return code;
    }
  }
  return 0;
}

function layerLabel(layer: ExposeLayer): string {
  return layer === "public" ? "Public (Funnel)" : "Tailnet";
}

export async function exposeUp(layer: ExposeLayer, opts: ExposeOpts = {}): Promise<number> {
  const runner = opts.runner ?? defaultRunner;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const statePath = opts.statePath ?? EXPOSE_STATE_PATH;
  const wellKnownFilePath = opts.wellKnownPath ?? WELL_KNOWN_PATH;
  const hubFilePath = opts.hubPath ?? HUB_PATH;
  const wellKnownDir = opts.wellKnownDir ?? WELL_KNOWN_DIR;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const port = opts.port ?? 443;
  const log = opts.log ?? ((line) => console.log(line));
  const funnel = layer === "public";

  if (!(await isTailscaleInstalled(runner))) {
    log("tailscale is not installed or not on PATH.");
    log("Install from https://tailscale.com/download and run `tailscale up`.");
    return 1;
  }

  const manifest = readManifest(manifestPath);
  if (manifest.services.length === 0) {
    log("No services installed yet. Try: parachute install vault");
    return 1;
  }

  const fqdn = opts.fqdnOverride ?? (await getFqdn(runner));
  const canonicalOrigin = `https://${fqdn}`;

  const prior = readExposeState(statePath);
  if (prior && prior.entries.length > 0) {
    const priorLabel = layerLabel(prior.layer);
    log(`Found prior ${priorLabel} exposure; tearing down ${prior.entries.length} entries first…`);
    const teardownCmds = prior.entries.map((e) =>
      teardownCommand(e, { port: prior.port, funnel: prior.funnel }),
    );
    const code = await runEach(runner, teardownCmds, log);
    if (code !== 0) {
      log("Teardown of prior state failed; aborting.");
      return code;
    }
  }

  const services = remapLegacyRoot(manifest.services, log);

  /**
   * Probe each service port before wiring tailscale up. A service that's
   * quietly stopped would otherwise get proxied for silent 502s. Warn and
   * continue — users sometimes expose paths ahead of starting a service,
   * and we don't want probe flakes to block bringup.
   */
  const portProbe = opts.servicePortProbe ?? (async (p: number) => !(await defaultPortProbe(p)));
  const probeResults = await Promise.all(
    services.map(async (s) => ({ svc: s, up: await portProbe(s.port) })),
  );
  for (const { svc, up } of probeResults) {
    if (up) continue;
    const short = shortNameForManifest(svc.name) ?? svc.name;
    log(
      `⚠ ${svc.name} (port ${svc.port}) is not responding; its path will proxy to a dead port. Run \`parachute start ${short}\`.`,
    );
  }

  const wellKnownDoc = buildWellKnown({ services, canonicalOrigin });
  writeWellKnownFile(wellKnownDoc, wellKnownFilePath);
  log(`Wrote ${wellKnownFilePath}`);
  writeHubFile(hubFilePath);
  log(`Wrote ${hubFilePath}`);

  let hubPort: number;
  if (opts.skipHub) {
    const existing = readHubPort(configDir);
    if (existing === undefined) {
      throw new Error("skipHub set but no hub.port on disk — tests must seed one");
    }
    hubPort = existing;
  } else {
    const hub = await ensureHubRunning({
      reservedPorts: services.map((s) => s.port),
      ...(opts.hubEnsureOpts ?? {}),
      configDir,
      wellKnownDir,
      log,
    });
    hubPort = hub.port;
    if (hub.started) log(`✓ hub started (pid ${hub.pid}, port ${hub.port}).`);
    else log(`✓ hub already running (pid ${hub.pid}, port ${hub.port}).`);
  }

  const entries = planEntries(services, hubPort);
  log(`Exposing under ${canonicalOrigin} (${layerLabel(layer)}, path-routing, port ${port}):`);
  for (const e of entries) {
    const suffix = e.kind === "proxy" ? `→ ${e.target}  (${e.service})` : `→ ${e.target}`;
    log(`  ${e.mount.padEnd(30, " ")} ${suffix}`);
  }

  const cmds = entries.map((e) => bringupCommand(e, { port, funnel }));
  const code = await runEach(runner, cmds, log);
  if (code !== 0) {
    log("Bringup failed; see error above. Prior tailscale state may be partially applied.");
    return code;
  }

  const state: ExposeState = {
    version: 1,
    layer,
    mode: "path",
    canonicalFqdn: fqdn,
    port,
    funnel,
    entries,
  };
  writeExposeState(state, statePath);

  log("");
  if (layer === "public") {
    log(`✓ Public exposure active (Funnel). Open: ${canonicalOrigin}/`);
    log("  This node is reachable from the public internet.");
  } else {
    log(`✓ Tailnet exposure active. Open: ${canonicalOrigin}/`);
  }
  log(`  Discovery: ${canonicalOrigin}${WELL_KNOWN_MOUNT}`);
  return 0;
}

export async function exposeOff(layer: ExposeLayer, opts: ExposeOpts = {}): Promise<number> {
  const runner = opts.runner ?? defaultRunner;
  const statePath = opts.statePath ?? EXPOSE_STATE_PATH;
  const wellKnownFilePath = opts.wellKnownPath ?? WELL_KNOWN_PATH;
  const hubFilePath = opts.hubPath ?? HUB_PATH;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const log = opts.log ?? ((line) => console.log(line));

  const state = readExposeState(statePath);
  if (!state || state.entries.length === 0) {
    log(`No ${layerLabel(layer)} exposure recorded. Nothing to tear down.`);
    return 0;
  }
  if (state.layer !== layer) {
    log(`No ${layerLabel(layer)} exposure recorded.`);
    log(`Current exposure is ${layerLabel(state.layer)}.`);
    log(`Run: parachute expose ${state.layer} off`);
    return 0;
  }

  log(`Tearing down ${state.entries.length} ${layerLabel(layer)} serve entries…`);
  const cmds = state.entries.map((e) =>
    teardownCommand(e, { port: state.port, funnel: state.funnel }),
  );
  const code = await runEach(runner, cmds, log);
  if (code !== 0) {
    log("Teardown failed. State file left in place so you can retry.");
    return code;
  }

  clearExposeState(statePath);
  if (existsSync(wellKnownFilePath)) {
    unlinkSync(wellKnownFilePath);
  }
  if (existsSync(hubFilePath)) {
    unlinkSync(hubFilePath);
  }

  // Hub lives only as long as some layer is exposed. State was just cleared,
  // so no layer is active — stop the hub. (Layer switch doesn't go through
  // here; that path reuses the running hub.)
  if (!opts.skipHub) {
    const stopped = await stopHub({ ...(opts.hubStopOpts ?? {}), configDir, log });
    if (stopped) log("✓ hub stopped.");
  }

  log(`✓ ${layerLabel(layer)} exposure removed.`);
  return 0;
}

export async function exposeTailnet(action: "up" | "off", opts: ExposeOpts = {}): Promise<number> {
  return action === "off" ? exposeOff("tailnet", opts) : exposeUp("tailnet", opts);
}

export async function exposePublic(action: "up" | "off", opts: ExposeOpts = {}): Promise<number> {
  return action === "off" ? exposeOff("public", opts) : exposeUp("public", opts);
}

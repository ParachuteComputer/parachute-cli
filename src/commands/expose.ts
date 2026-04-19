import { existsSync, unlinkSync } from "node:fs";
import { SERVICES_MANIFEST_PATH } from "../config.ts";
import {
  EXPOSE_STATE_PATH,
  type ExposeLayer,
  type ExposeState,
  clearExposeState,
  readExposeState,
  writeExposeState,
} from "../expose-state.ts";
import { type ServiceEntry, readManifest } from "../services-manifest.ts";
import { type ServeEntry, bringupCommand, teardownCommand } from "../tailscale/commands.ts";
import { getFqdn, isTailscaleInstalled } from "../tailscale/detect.ts";
import { type Runner, defaultRunner } from "../tailscale/run.ts";
import {
  WELL_KNOWN_MOUNT,
  WELL_KNOWN_PATH,
  buildWellKnown,
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
 */

export interface ExposeOpts {
  runner?: Runner;
  manifestPath?: string;
  statePath?: string;
  wellKnownPath?: string;
  port?: number;
  log?: (line: string) => void;
  /** Override detected FQDN — primarily for tests. */
  fqdnOverride?: string;
}

function planEntries(services: readonly ServiceEntry[], wellKnownFilePath: string): ServeEntry[] {
  const entries: ServeEntry[] = [];
  for (const s of services) {
    const mount = s.paths[0] ?? "/";
    entries.push({
      kind: "proxy",
      mount,
      target: `http://127.0.0.1:${s.port}`,
      service: s.name,
    });
  }
  entries.push({
    kind: "file",
    mount: WELL_KNOWN_MOUNT,
    target: wellKnownFilePath,
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
    const teardownCmds = prior.entries.map((e) => teardownCommand(e, { port: prior.port }));
    const code = await runEach(runner, teardownCmds, log);
    if (code !== 0) {
      log("Teardown of prior state failed; aborting.");
      return code;
    }
  }

  const wellKnownDoc = buildWellKnown({ services: manifest.services, canonicalOrigin });
  writeWellKnownFile(wellKnownDoc, wellKnownFilePath);
  log(`Wrote ${wellKnownFilePath}`);

  const entries = planEntries(manifest.services, wellKnownFilePath);
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
  const cmds = state.entries.map((e) => teardownCommand(e, { port: state.port }));
  const code = await runEach(runner, cmds, log);
  if (code !== 0) {
    log("Teardown failed. State file left in place so you can retry.");
    return code;
  }

  clearExposeState(statePath);
  if (existsSync(wellKnownFilePath)) {
    unlinkSync(wellKnownFilePath);
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

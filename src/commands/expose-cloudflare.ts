/**
 * `parachute expose public --cloudflare` — wrap a Cloudflare Quick Tunnel
 * pointed at the installed vault. Ephemeral (URL changes each run), but
 * works without a domain and without Tailscale. Ideal for "try it publicly
 * in 30 seconds" scenarios: install vault → expose public --cloudflare →
 * paste the URL into claude.ai Connectors.
 *
 * Named tunnel + custom domain is tracked as a follow-up; today we only
 * handle quick tunnels (no login required, no domain required).
 */

import { SERVICES_MANIFEST_PATH } from "../config.ts";
import { type Runner, defaultRunner } from "../tailscale/run.ts";
import { isVaultEntry } from "../well-known.ts";
import { readManifest } from "../services-manifest.ts";
import { isCloudflaredInstalled } from "../cloudflare/detect.ts";
import { spawnQuickTunnel, stopQuickTunnel } from "../cloudflare/tunnel.ts";
import {
  CLOUDFLARE_STATE_PATH,
  clearCloudflaredState,
  readCloudflaredState,
  writeCloudflaredState,
} from "../cloudflare/state.ts";

export interface ExposeCloudflareOpts {
  runner?: Runner;
  manifestPath?: string;
  statePath?: string;
  log?: (line: string) => void;
  /** Override spawn (tests inject a mock that returns a deterministic URL). */
  spawn?: typeof spawnQuickTunnel;
  /** Override the teardown (tests check whether it was called). */
  stop?: typeof stopQuickTunnel;
}

function log(opts: ExposeCloudflareOpts): (line: string) => void {
  return opts.log ?? ((line) => console.log(line));
}

function primaryVaultPort(manifestPath: string): number | undefined {
  const manifest = readManifest(manifestPath);
  const vault = manifest.services.find(isVaultEntry);
  return vault?.port;
}

function installHelp(): string[] {
  return [
    "cloudflared is not installed or not on PATH.",
    "Install:",
    "  macOS:  brew install cloudflared",
    "  Linux:  https://pkg.cloudflare.com/install",
    "  other:  https://github.com/cloudflare/cloudflared/releases",
    "",
    "Alternatively, `parachute expose public` (without --cloudflare) uses",
    "Tailscale Funnel, which is free for personal use.",
  ];
}

export async function exposeCloudflareUp(opts: ExposeCloudflareOpts = {}): Promise<number> {
  const print = log(opts);
  const runner = opts.runner ?? defaultRunner;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const statePath = opts.statePath ?? CLOUDFLARE_STATE_PATH;
  const spawn = opts.spawn ?? spawnQuickTunnel;
  const stop = opts.stop ?? stopQuickTunnel;

  if (!(await isCloudflaredInstalled(runner))) {
    for (const line of installHelp()) print(line);
    return 1;
  }

  const vaultPort = primaryVaultPort(manifestPath);
  if (vaultPort === undefined) {
    print("No vault installed. Run: parachute install vault");
    return 1;
  }

  // If a prior cloudflared state exists, stop it first — one tunnel at a time.
  const prior = readCloudflaredState(statePath);
  if (prior) {
    print(`Found prior Cloudflare tunnel (pid ${prior.pid}); stopping…`);
    stop(prior.pid);
    clearCloudflaredState(statePath);
  }

  print(`Starting Cloudflare Quick Tunnel to http://127.0.0.1:${vaultPort}…`);
  let result: Awaited<ReturnType<typeof spawnQuickTunnel>>;
  try {
    result = await spawn({ port: vaultPort });
  } catch (err) {
    print(`cloudflared failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  writeCloudflaredState(
    {
      version: 1,
      pid: result.pid,
      url: result.url,
      localPort: vaultPort,
      startedAt: new Date().toISOString(),
    },
    statePath,
  );

  print("");
  print(`✓ Cloudflare Quick Tunnel active: ${result.url}`);
  print(`  Claude / ChatGPT Connector URL: ${result.url}/vault/default`);
  print("");
  print("Security — strongly recommended before sharing this URL:");
  print("  • OAuth + 2FA for human clients (claude.ai, ChatGPT):");
  print("      parachute vault set-password");
  print("      parachute vault 2fa enroll");
  print("  • Or API tokens for scripts / agents:");
  print("      parachute vault tokens create --scope vault:write");
  print("");
  print("Notes:");
  print("  • Quick Tunnels are ephemeral. The URL above will change every time");
  print("    cloudflared restarts (including this machine rebooting). For a");
  print("    stable URL, use `parachute expose public` (Tailscale Funnel).");
  print("  • Teardown: parachute expose public off");
  print(`  • Logs: ${result.logPath}`);
  return 0;
}

export async function exposeCloudflareOff(opts: ExposeCloudflareOpts = {}): Promise<number> {
  const print = log(opts);
  const statePath = opts.statePath ?? CLOUDFLARE_STATE_PATH;
  const stop = opts.stop ?? stopQuickTunnel;

  const state = readCloudflaredState(statePath);
  if (!state) {
    print("No Cloudflare tunnel state recorded. Nothing to tear down.");
    return 0;
  }

  const killed = stop(state.pid);
  clearCloudflaredState(statePath);

  if (killed) {
    print(`✓ Cloudflare tunnel stopped (was: ${state.url}).`);
  } else {
    print(`Cloudflare tunnel process (pid ${state.pid}) was already gone.`);
    print(`Cleared state (URL was: ${state.url}).`);
  }
  return 0;
}

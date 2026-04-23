#!/usr/bin/env bun

/**
 * parachute — the top-level CLI for the Parachute ecosystem.
 *
 * Run `parachute --help` or `parachute <subcommand> --help` for usage.
 */

import pkg from "../package.json" with { type: "json" };
import { auth } from "./commands/auth.ts";
import { exposePublic, exposeTailnet } from "./commands/expose.ts";
import { install } from "./commands/install.ts";
import { logs, restart, start, stop } from "./commands/lifecycle.ts";
import { migrate } from "./commands/migrate.ts";
import { status } from "./commands/status.ts";
import { dispatchVault } from "./commands/vault.ts";
import { ExposeStateError } from "./expose-state.ts";
import {
  exposeHelp,
  installHelp,
  logsHelp,
  migrateHelp,
  restartHelp,
  startHelp,
  statusHelp,
  stopHelp,
  topLevelHelp,
} from "./help.ts";
import { knownServices } from "./service-spec.ts";
import { ServicesManifestError } from "./services-manifest.ts";
import { TailscaleError } from "./tailscale/run.ts";

function isHelpFlag(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

/**
 * Extract `--hub-origin=<url>` / `--hub-origin <url>` from argv. Returns the
 * URL and the remaining args (so callers can keep validating positionals
 * without the flag in the way). `error` is set on missing value.
 */
function extractHubOrigin(args: string[]): {
  hubOrigin?: string;
  rest: string[];
  error?: string;
} {
  const rest: string[] = [];
  let hubOrigin: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--hub-origin") {
      const v = args[i + 1];
      if (!v) return { rest, error: "--hub-origin requires a URL argument" };
      hubOrigin = v;
      i++;
      continue;
    }
    if (a?.startsWith("--hub-origin=")) {
      hubOrigin = a.slice("--hub-origin=".length);
      if (!hubOrigin) return { rest, error: "--hub-origin requires a URL argument" };
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  return { hubOrigin, rest };
}

/**
 * Extract `--tag=<value>` / `--tag <value>` from argv. Same shape as
 * `extractHubOrigin` so the install command can layer the two flags
 * uniformly. `error` is set on missing value.
 */
function extractTag(args: string[]): {
  tag?: string;
  rest: string[];
  error?: string;
} {
  const rest: string[] = [];
  let tag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--tag") {
      const v = args[i + 1];
      if (!v) return { rest, error: "--tag requires a value (dist-tag or version)" };
      tag = v;
      i++;
      continue;
    }
    if (a?.startsWith("--tag=")) {
      tag = a.slice("--tag=".length);
      if (!tag) return { rest, error: "--tag requires a value (dist-tag or version)" };
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  return { tag, rest };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(topLevelHelp());
      return 0;

    case "--version":
    case "-v":
      console.log(pkg.version);
      return 0;

    case "install": {
      if (isHelpFlag(rest[0])) {
        console.log(installHelp());
        return 0;
      }
      const tagExtract = extractTag(rest);
      if (tagExtract.error) {
        console.error(`parachute install: ${tagExtract.error}`);
        return 1;
      }
      const installArgs = tagExtract.rest;
      const service = installArgs[0];
      if (!service) {
        console.error("usage: parachute install <service|all> [--tag <name>]");
        console.error(`services: ${knownServices().join(", ")}`);
        return 1;
      }
      const installOpts = tagExtract.tag ? { tag: tagExtract.tag } : {};
      if (service === "all") {
        // Bootstrap the whole ecosystem to one dist-tag — the RC-testing payload.
        // Bail on first failure so a broken channel doesn't mask a working tag.
        for (const svc of knownServices()) {
          const code = await install(svc, installOpts);
          if (code !== 0) return code;
        }
        return 0;
      }
      return await install(service, installOpts);
    }

    case "status":
      if (isHelpFlag(rest[0])) {
        console.log(statusHelp());
        return 0;
      }
      return await status();

    case "expose": {
      const hubExtract = extractHubOrigin(rest);
      if (hubExtract.error) {
        console.error(`parachute expose: ${hubExtract.error}`);
        return 1;
      }
      const useCloudflare = hubExtract.rest.includes("--cloudflare");
      const exposeArgs = hubExtract.rest.filter((a) => a !== "--cloudflare");
      const layer = exposeArgs[0];
      const mode = exposeArgs[1];
      if (isHelpFlag(layer)) {
        console.log(exposeHelp());
        return 0;
      }
      if (layer !== "tailnet" && layer !== "public") {
        console.error(`parachute expose: unknown layer "${layer ?? ""}"`);
        console.error("usage: parachute expose tailnet [off]");
        console.error("       parachute expose public  [off] [--cloudflare]");
        console.error("run `parachute expose --help` for details");
        return 1;
      }
      if (isHelpFlag(mode)) {
        console.log(exposeHelp());
        return 0;
      }
      if (mode !== undefined && mode !== "off") {
        console.error(`parachute expose ${layer}: unknown argument "${mode}"`);
        console.error(`usage: parachute expose ${layer} [off]`);
        return 1;
      }
      const action = mode === "off" ? "off" : "up";
      if (useCloudflare) {
        if (layer !== "public") {
          console.error("--cloudflare only makes sense with `expose public`.");
          console.error("(tailnet exposure is what Tailscale already does.)");
          return 1;
        }
        const { exposeCloudflareUp, exposeCloudflareOff } = await import(
          "./commands/expose-cloudflare.ts"
        );
        return action === "off" ? await exposeCloudflareOff() : await exposeCloudflareUp();
      }
      const exposeOpts = hubExtract.hubOrigin ? { hubOrigin: hubExtract.hubOrigin } : {};
      return layer === "public"
        ? await exposePublic(action, exposeOpts)
        : await exposeTailnet(action, exposeOpts);
    }

    case "start": {
      if (isHelpFlag(rest[0])) {
        console.log(startHelp());
        return 0;
      }
      const hubExtract = extractHubOrigin(rest);
      if (hubExtract.error) {
        console.error(`parachute start: ${hubExtract.error}`);
        return 1;
      }
      const startOpts = hubExtract.hubOrigin ? { hubOrigin: hubExtract.hubOrigin } : {};
      return await start(hubExtract.rest[0], startOpts);
    }

    case "stop": {
      if (isHelpFlag(rest[0])) {
        console.log(stopHelp());
        return 0;
      }
      return await stop(rest[0]);
    }

    case "restart": {
      if (isHelpFlag(rest[0])) {
        console.log(restartHelp());
        return 0;
      }
      return await restart(rest[0]);
    }

    case "logs": {
      if (isHelpFlag(rest[0])) {
        console.log(logsHelp());
        return 0;
      }
      const svc = rest[0];
      if (!svc) {
        console.error("usage: parachute logs <service> [-f]");
        console.error(`services: ${knownServices().join(", ")}`);
        return 1;
      }
      const follow = rest.includes("-f") || rest.includes("--follow");
      return await logs(svc, { follow });
    }

    case "migrate": {
      if (isHelpFlag(rest[0])) {
        console.log(migrateHelp());
        return 0;
      }
      const dryRun = rest.includes("--dry-run");
      const yes = rest.includes("--yes") || rest.includes("-y");
      const unknown = rest.find((a) => a !== "--dry-run" && a !== "--yes" && a !== "-y");
      if (unknown !== undefined) {
        console.error(`parachute migrate: unknown argument "${unknown}"`);
        console.error("usage: parachute migrate [--dry-run] [--yes]");
        return 1;
      }
      return await migrate({ dryRun, yes });
    }

    case "auth":
      return await auth(rest);

    case "vault":
      // `parachute vault` with no args forwards --help to parachute-vault so
      // users see the actual vault surface, not a CLI-side stub. Anything
      // after `vault` (including --help) is passed through verbatim.
      return await dispatchVault(rest.length === 0 ? ["--help"] : rest);

    default:
      console.error(`parachute: unknown command "${command}"`);
      console.error("run `parachute --help` for usage");
      return 1;
  }
}

async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err) {
    if (err instanceof ServicesManifestError) {
      console.error(`services.json is malformed: ${err.message}`);
      console.error("Fix or remove the file, then re-run.");
      return 1;
    }
    if (err instanceof ExposeStateError) {
      console.error(`expose-state.json is malformed: ${err.message}`);
      console.error("If you're stuck, delete ~/.parachute/expose-state.json and re-run.");
      return 1;
    }
    if (err instanceof TailscaleError) {
      console.error(`tailscale command failed: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

const code = await run(process.argv.slice(2));
process.exit(code);

#!/usr/bin/env bun

/**
 * parachute — the top-level CLI for the Parachute ecosystem.
 *
 * Run `parachute --help` or `parachute <subcommand> --help` for usage.
 */

import pkg from "../package.json" with { type: "json" };
import { exposePublic, exposeTailnet } from "./commands/expose.ts";
import { install } from "./commands/install.ts";
import { status } from "./commands/status.ts";
import { dispatchVault } from "./commands/vault.ts";
import { ExposeStateError } from "./expose-state.ts";
import { exposeHelp, installHelp, statusHelp, topLevelHelp, vaultHelp } from "./help.ts";
import { knownServices } from "./service-spec.ts";
import { ServicesManifestError } from "./services-manifest.ts";
import { TailscaleError } from "./tailscale/run.ts";

function isHelpFlag(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
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
      const service = rest[0];
      if (!service) {
        console.error("usage: parachute install <service>");
        console.error(`services: ${knownServices().join(", ")}`);
        return 1;
      }
      return await install(service);
    }

    case "status":
      if (isHelpFlag(rest[0])) {
        console.log(statusHelp());
        return 0;
      }
      return await status();

    case "expose": {
      const layer = rest[0];
      const mode = rest[1];
      if (isHelpFlag(layer)) {
        console.log(exposeHelp());
        return 0;
      }
      if (layer !== "tailnet" && layer !== "public") {
        console.error(`parachute expose: unknown layer "${layer ?? ""}"`);
        console.error("usage: parachute expose tailnet [off]");
        console.error("       parachute expose public  [off]");
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
      return layer === "public" ? await exposePublic(action) : await exposeTailnet(action);
    }

    case "vault":
      // `parachute vault` alone shows CLI's dispatch help (usage hint).
      // `parachute vault <anything>` forwards verbatim — including --help,
      // which goes to parachute-vault itself so the user sees vault's own help.
      if (rest.length === 0) {
        console.log(vaultHelp());
        return 0;
      }
      return await dispatchVault(rest);

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

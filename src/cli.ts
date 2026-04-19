#!/usr/bin/env bun

/**
 * parachute — the top-level CLI for the Parachute ecosystem.
 *
 * Usage:
 *   parachute install <service>     install a Parachute service
 *   parachute status                read services manifest, probe localhost
 *   parachute vault <args...>       dispatch to parachute-vault
 *   parachute --version
 *   parachute --help
 */

import pkg from "../package.json" with { type: "json" };
import { exposePublic, exposeTailnet } from "./commands/expose.ts";
import { install } from "./commands/install.ts";
import { status } from "./commands/status.ts";
import { dispatchVault } from "./commands/vault.ts";
import { knownServices } from "./service-spec.ts";

function usage(): void {
  const services = knownServices().join(" | ");
  console.log(`parachute ${pkg.version} — top-level CLI for the Parachute ecosystem

Usage:
  parachute install <service>       install and register a service
                                    services: ${services}
  parachute status                  show installed services and health
  parachute expose tailnet [off]    HTTPS across your tailnet
  parachute expose public  [off]    HTTPS on the public internet (Funnel)
  parachute vault <args...>         dispatch to parachute-vault

Flags:
  --help, -h                        show this help
  --version, -v                     print version
`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;

    case "--version":
    case "-v":
      console.log(pkg.version);
      return 0;

    case "install": {
      const service = rest[0];
      if (!service) {
        console.error("usage: parachute install <service>");
        console.error(`services: ${knownServices().join(", ")}`);
        return 1;
      }
      return await install(service);
    }

    case "status":
      return await status();

    case "expose": {
      const layer = rest[0];
      const mode = rest[1];
      if (layer !== "tailnet" && layer !== "public") {
        console.error(`parachute expose: unknown layer "${layer ?? ""}"`);
        console.error("usage: parachute expose tailnet [off]");
        console.error("       parachute expose public  [off]");
        return 1;
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
      return await dispatchVault(rest);

    default:
      console.error(`parachute: unknown command "${command}"`);
      console.error("run `parachute --help` for usage");
      return 1;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);

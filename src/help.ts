import pkg from "../package.json" with { type: "json" };
import { knownServices } from "./service-spec.ts";

export function topLevelHelp(): string {
  const services = knownServices().join(" | ");
  return `parachute ${pkg.version} — top-level CLI for the Parachute ecosystem

Usage:
  parachute install <service>       install and register a service
                                    services: ${services}
  parachute status                  show installed services and health
  parachute expose tailnet [off]    HTTPS across your tailnet
  parachute expose public  [off]    HTTPS on the public internet (Funnel)
  parachute vault <args...>         dispatch to parachute-vault

Flags:
  --help, -h                        show this help (also per-subcommand: \`parachute <cmd> --help\`)
  --version, -v                     print version
`;
}

export function installHelp(): string {
  return `parachute install — install and register a Parachute service

Usage:
  parachute install <service>

Services:
  ${knownServices().join(", ")}

What it does:
  1. bun add -g @openparachute/<service>
  2. run any service-specific init (e.g. \`parachute-vault init\`)
  3. verify the service registered itself in ~/.parachute/services.json

Examples:
  parachute install vault           # installs + runs \`parachute-vault init\`
  parachute install notes           # installs notes (no init required)
`;
}

export function statusHelp(): string {
  return `parachute status — show installed services and their health

Usage:
  parachute status

What it does:
  Reads ~/.parachute/services.json and probes \`http://localhost:<port><health>\`
  for every registered service.

Exit codes:
  0   all services healthy (or no services installed yet)
  1   one or more services unhealthy

Example:
  $ parachute status
  SERVICE          PORT  VERSION  STATUS  LATENCY
  parachute-vault  1940  0.2.4    ok      2ms
`;
}

export function exposeHelp(): string {
  return `parachute expose — route your services behind HTTPS on a network layer

Usage:
  parachute expose tailnet [off]
  parachute expose public  [off]

Layers:
  tailnet    HTTPS across your tailnet (tailscale serve)
  public     HTTPS on the public internet (Tailscale Funnel)

Both layers share a single tailscale-serve config on this node. Switching
layers is idempotent — the prior layer tears down before the new one comes up.

Examples:
  parachute expose tailnet          # bring every service up inside your tailnet
  parachute expose public           # also reachable from the public internet
  parachute expose tailnet off      # tear down tailnet exposure
  parachute expose public off       # tear down public exposure

Constraints (public layer / Funnel):
  - Funnel supports HTTPS only on ports 443 / 8443 / 10000 per node.
    We pin to 443 and path-route (vault at /, notes at /notes, …) so this
    cap never becomes a constraint no matter how many services you install.
  - Funnel has bandwidth caps on Tailscale's free tier.
    See https://tailscale.com/kb/1223/funnel for current limits.
  - Subdomain-per-service (vault.<fqdn>, notes.<fqdn>, …) requires the
    Tailscale Services feature and is not supported in this release.

Coming soon:
  parachute expose public --mode caddy        use your own domain + Caddy
  parachute expose public --mode cloudflared  use your own domain + cloudflared
`;
}

export function vaultHelp(): string {
  return `parachute vault — dispatch to parachute-vault

Usage:
  parachute vault <args...>

Everything after \`parachute vault\` is forwarded verbatim to the installed
parachute-vault binary. If you get "not found on PATH", install it with:

  parachute install vault

Examples:
  parachute vault init              # same as running \`parachute-vault init\`
  parachute vault --help            # forwards --help to parachute-vault
`;
}

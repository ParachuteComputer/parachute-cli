import pkg from "../package.json" with { type: "json" };
import { knownServices } from "./service-spec.ts";

export function topLevelHelp(): string {
  const services = knownServices().join(" | ");
  return `parachute ${pkg.version} — top-level CLI for the Parachute ecosystem

Usage:
  parachute install <service>       install and register a service
                                    services: ${services}
  parachute status                  show installed services, process state, health
  parachute start   [service]       start all services (or one) in the background
  parachute stop    [service]       stop all services (or one) — SIGTERM then SIGKILL
  parachute restart [service]       stop + start
  parachute logs <service> [-f]     print service logs; -f to tail
  parachute expose tailnet [off]    HTTPS across your tailnet
  parachute expose public  [off]    HTTPS on the public internet (Funnel)
  parachute migrate [--dry-run]     archive legacy files at ecosystem root
  parachute vault <args...>         vault-specific ops (tokens, 2fa, config, init,
                                    etc.) — forwards to parachute-vault.
                                    For lifecycle, use \`parachute start|stop|restart|logs vault\`.

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
  return `parachute status — show installed services, process state, and health

Usage:
  parachute status

What it does:
  Reads ~/.parachute/services.json. For each registered service:
    - checks PID file at ~/.parachute/<svc>/run/<svc>.pid → running/stopped
    - probes http://localhost:<port><health> (skipped for known-stopped processes)

  Stopped services show "-" for health and don't count toward the exit
  code — they're an expected state after fresh install before \`parachute
  start\`. Running or externally-managed services that fail health checks
  do exit 1.

Exit codes:
  0   all probed services healthy (or none running)
  1   one or more probed services unhealthy

Example:
  $ parachute status
  SERVICE          PORT  VERSION  PROCESS  PID    UPTIME  HEALTH  LATENCY
  parachute-vault  1940  0.2.4    running  12345  2h 13m  ok      2ms
  parachute-notes  5173  0.0.1    stopped  -      -       -       -
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

export function startHelp(): string {
  return `parachute start — spawn services in the background

Usage:
  parachute start                   start every installed service
  parachute start <service>         start just that one

What it does:
  For each target service, spawns its start command detached, redirects
  stdout+stderr to ~/.parachute/<service>/logs/<service>.log, and records
  the child PID at ~/.parachute/<service>/run/<service>.pid.

  Idempotent: if the service is already running, no-op.
  If a stale PID file exists (process died without cleanup), it's cleared
  and the service starts fresh.

Examples:
  parachute start                   bring everything up
  parachute start vault             just vault
  parachute logs vault              watch what just started

Start commands by service:
  vault     parachute-vault serve
  scribe    parachute-scribe serve
  channel   parachute-channel daemon
  notes     bun <cli>/notes-serve.ts --port <configured>
`;
}

export function stopHelp(): string {
  return `parachute stop — stop running services cleanly

Usage:
  parachute stop                    stop every installed service
  parachute stop <service>          stop just that one

What it does:
  Sends SIGTERM, waits up to 10s for a clean exit, then escalates to
  SIGKILL if the process is still alive. Removes the PID file on success.

  No-op if the service wasn't running.

Examples:
  parachute stop                    stop everything before sleep
  parachute stop vault              just vault
`;
}

export function restartHelp(): string {
  return `parachute restart — stop then start

Usage:
  parachute restart                 restart every installed service
  parachute restart <service>       restart just that one

What it does:
  Equivalent to \`parachute stop <svc> && parachute start <svc>\`.
`;
}

export function logsHelp(): string {
  return `parachute logs — print service logs

Usage:
  parachute logs <service>          print the last 200 lines
  parachute logs <service> -f       tail the log (like \`tail -f\`)

Log file:
  ~/.parachute/<service>/logs/<service>.log

If no log file exists yet, prints a hint to \`parachute start <service>\`.
`;
}

export function migrateHelp(): string {
  return `parachute migrate — archive legacy files at the ecosystem root

Usage:
  parachute migrate [--dry-run] [--yes]

What it does:
  Scans ~/.parachute/ for files and directories that don't belong to the
  post-restructure layout. Recognized entries — per-service dirs
  (vault/, notes/, scribe/, channel/, hub/), services.json,
  expose-state.json, well-known/ — stay in place. Anything else (plus
  known legacy cruft like daily.db, server.yaml) is moved under
  ~/.parachute/.archive-<YYYY-MM-DD>/, never deleted.

  Dotfiles at the root (.env, .DS_Store, prior .archive-* dirs) are left
  alone.

Flags:
  --dry-run     print the plan; make no changes
  --yes, -y     skip the confirmation prompt

Examples:
  parachute migrate --dry-run       see what would move, without touching anything
  parachute migrate                 interactive sweep (prompts before acting)
  parachute migrate --yes           sweep without prompting
`;
}

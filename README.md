# Parachute CLI

`parachute` — the top-level command for the [Parachute](https://parachute.computer) ecosystem.

Install, inspect, and (soon) expose Parachute services with one command. Each service (vault, notes, scribe, channel, …) stays a standalone package; this CLI is the coordinator.

## Install

```sh
bun add -g @openparachute/cli
```

Prereqs: [Bun](https://bun.sh) 1.3.0 or later. `parachute expose` also requires [Tailscale](https://tailscale.com/download) **1.82 or newer** (installed + `tailscale up` run once); the `expose` path is under active polish for launch, so expect rough edges.

## First 5 minutes

```sh
# 1. Install the CLI (one line)
bun add -g @openparachute/cli

# 2. Install a service (runs `bun add -g @openparachute/vault` + `parachute-vault init`)
parachute install vault

# 3. Start the service in the background (PID + logs tracked under ~/.parachute/vault/)
parachute start vault

# 4. Check it landed — reads ~/.parachute/services.json, shows process state + probes health
parachute status
# SERVICE          PORT  VERSION  PROCESS  PID    UPTIME  HEALTH  LATENCY
# parachute-vault  1940  0.2.4    running  12345  12s     ok      2ms

# 5. Use it. Vault is up on 127.0.0.1:1940; Claude Code picked up the MCP
#    on your next session. Point any other local MCP client (Codex, Goose,
#    OpenCode, Cursor, Zed, Cline, your own agent) at:
#      http://127.0.0.1:1940/vault/default/mcp

# 6. Expose beyond localhost — Tailscale Funnel or Cloudflare Tunnel.
#    Polishing for broad launch, but live today for early testers:
parachute expose --help
```

Tear down with `parachute expose tailnet off` or `parachute expose public off`. Layers are independent — `off` only affects the layer you name.

## Service lifecycle

`parachute start`, `stop`, `restart`, and `logs` manage services as background processes — no launchd, no manual `bun serve`, no hunting for PIDs.

```sh
parachute start               # start every installed service
parachute start vault         # just one
parachute stop                # SIGTERM, then SIGKILL after 10s if stuck
parachute restart vault       # stop + start
parachute logs vault          # last 200 lines
parachute logs vault -f       # tail (like `tail -f`)
```

State lives under `~/.parachute/<service>/`:

- `run/<service>.pid` — child PID; `parachute status` uses this to report running/stopped + uptime
- `logs/<service>.log` — stdout + stderr (appended)

`parachute start` is idempotent: if the service is already running, it's a no-op. Stale PID files (process died without cleanup) are cleared on the next start. Services whose PID file is absent are treated as *unknown* — status still probes their port, so externally-managed services (e.g. you ran `parachute-vault serve` directly) aren't misreported as stopped.

### Migrating from launchd (pre-launch beta)

If you previously ran vault under launchd, switch to `parachute start`:

```sh
launchctl unload ~/Library/LaunchAgents/computer.parachute.vault.plist
rm ~/Library/LaunchAgents/computer.parachute.vault.plist
parachute start vault
```

An at-login auto-start mode (`parachute start --boot`) is on the post-launch roadmap.

### Migrating from pre-CLI installs

If you've been running Parachute services by hand for a while, `~/.parachute/` may contain files from before the per-service restructure — top-level `daily.db`, `server.yaml`, a stray `logs/` directory, and so on. `parachute install` will print a one-line notice when it sees anything like that; run `parachute migrate` to sweep them:

```sh
parachute migrate --dry-run       # see the plan
parachute migrate                 # interactive (prompts before moving)
parachute migrate --yes           # unattended
```

Anything swept goes to `~/.parachute/.archive-<YYYY-MM-DD>/` with its original name — nothing is deleted. Recognized entries (per-service dirs, `services.json`, `expose-state.json`, `well-known/`) are left in place, and so is anything starting with a dot (so `.env` and prior `.archive-*` dirs are safe).

## Three layers of addressability

Each additive; each can be turned off without affecting the layer below.

- **Local** — services on loopback. Zero config. Browsers treat `localhost` as a secure context, so OAuth, PKCE, and Web Crypto all just work out of the box.
- **Tailnet** — `parachute expose tailnet` wraps `tailscale serve` for every registered service. HTTPS via Tailscale's MagicDNS cert. Only machines on your tailnet can reach the URL.
- **Public** — `parachute expose public` routes each handler through `tailscale funnel` so the same URLs become reachable from the public internet. At launch, Funnel is the only supported backend; Caddy + your-own-domain and cloudflared tunnels are planned post-launch.

Under the hood, tailnet mode uses `tailscale serve` and public mode uses `tailscale funnel`; both write into the same node-level serve config. The CLI records which layer is live so that `expose <other-layer> off` is a no-op rather than a surprise teardown of the active layer.

## Path-routing (and why)

Every service mounts under a path on a single canonical hostname. The root `/` is a hub page that auto-discovers everything installed on this node:

```
https://parachute.<tailnet>.ts.net/                              → hub (service directory)
https://parachute.<tailnet>.ts.net/vault/default                 → parachute-vault API
https://parachute.<tailnet>.ts.net/lens                          → parachute-lens
https://parachute.<tailnet>.ts.net/scribe                        → parachute-scribe
https://parachute.<tailnet>.ts.net/.well-known/parachute.json    ← discovery
```

The hub page fetches the discovery doc at load, then each service's `/.parachute/info` endpoint for display name, tagline, and icon. Adding a new service is zero CLI code — drop in its manifest entry and the hub picks it up.

Under the hood, `/` and `/.well-known/parachute.json` are proxied by a tiny internal HTTP server (`parachute-hub`) that `parachute expose` spawns on the loopback interface. Tailscale's file-serve mode is sandbox-restricted on macOS, so a localhost proxy is the portable shape. The hub process is stopped automatically when the last exposure layer is torn down; `parachute status` lists it under `(internal)`.

The `/.well-known/parachute.json` document is an always-present descriptor — flat `services[]` array that the hub iterates, plus top-level keys for legacy clients:

```json
{
  "vaults": [
    { "name": "default", "url": "https://parachute.taildf9ce2.ts.net/vault/default", "version": "0.2.4" }
  ],
  "services": [
    {
      "name": "parachute-vault",
      "url":  "https://parachute.taildf9ce2.ts.net/vault/default",
      "path": "/vault/default",
      "version": "0.2.4",
      "infoUrl": "https://parachute.taildf9ce2.ts.net/vault/default/.parachute/info"
    },
    {
      "name": "parachute-lens",
      "url":  "https://parachute.taildf9ce2.ts.net/lens",
      "path": "/lens",
      "version": "0.0.1",
      "infoUrl": "https://parachute.taildf9ce2.ts.net/lens/.parachute/info"
    }
  ],
  "lens": { "url": "https://parachute.taildf9ce2.ts.net/lens", "version": "0.0.1" }
}
```

Why path-routing and not subdomain-per-service? Two reasons:

1. **Tailscale Funnel HTTPS is capped at three ports per node** (443, 8443, 10000). Pinning every service to 443 behind a path means you can install any number of services without ever hitting that cap.
2. **Subdomain-per-service requires the Tailscale Services feature** (virtual-IP advertisement per service), which is more than a MagicDNS wildcard — it needs admin-side setup that's out of scope for a one-command install. When it's a launch-grade path, we'll add `parachute expose tailnet --mode subdomain`.

Funnel has bandwidth quotas on Tailscale's free tier. See [tailscale.com/kb/1223/funnel](https://tailscale.com/kb/1223/funnel) for current limits; for heavy traffic, the post-launch Caddy / cloudflared modes will be the answer.

## Ports

Parachute services reserve a block of loopback ports in the canonical range **1939–1949**. One range, one firewall rule, no surprises.

| Port | Service            |
| ---- | ------------------ |
| 1939 | parachute-hub (internal proxy + static) |
| 1940 | parachute-vault    |
| 1941 | parachute-channel  |
| 1942 | parachute-notes    |
| 1943 | parachute-scribe   |
| 1944–1949 | *unassigned (CLI fallback range)* |

The hub pins 1939 — no fallback. If something else is on 1939 when you run `parachute expose`, the command fails with a pointer to `lsof -iTCP:1939` rather than walking up into another service's slot.

**The CLI is the port authority.** `parachute install <svc>` picks the port at install time and writes `PORT=<port>` into `~/.parachute/<svc>/.env`; lifecycle.start merges that .env into the spawn env so the next daemon boot binds the port the CLI assigned. The algorithm:

1. Prefer the canonical slot (e.g. vault → 1940).
2. On collision, walk the unassigned range (1944–1949).
3. Range exhausted: assign past 1949 with a warning.

Idempotent: an existing `PORT=` in `~/.parachute/<svc>/.env` wins, so re-installs and operator-edited ports survive across upgrades. Services keep their compiled-in fallbacks (vault → 1940 etc.) so a stand-alone `bun run` still works without a CLI-managed .env.

`parachute expose` probes every service's port at bringup. A service that isn't responding still gets exposed, but you get a `⚠ parachute-<svc> (port …) is not responding` line so proxied requests never silently 502 without explanation.

## How services register

Each Parachute service writes a manifest entry to `~/.parachute/services.json` on install. The CLI reads that manifest to drive `parachute status`, `parachute expose tailnet`, and `parachute expose public`.

```json
{
  "services": [
    {
      "name":    "parachute-vault",
      "port":    1940,
      "paths":   ["/vault/default"],
      "health":  "/vault/default/health",
      "version": "0.2.4"
    }
  ]
}
```

Optional `displayName` and `tagline` may be added to personalize the hub-page card; if absent, the hub falls back to the short name and the service's own `/.parachute/info` response.

The schema is a bit-for-bit contract shared between the CLI and every service. Services own their write side; the CLI owns the read + exposure side.

### Claiming `/` — legacy manifests

Pre-hub services wrote `paths: ["/"]` (when there was only one service at `/`). On `parachute expose`, any such entry is remapped in-memory to `/<shortname>` with a one-line warning; re-running `parachute install <svc>` updates the on-disk manifest permanently. The hub always owns `/`.

If you want the CLI (and every service you install) to use a config directory other than `~/.parachute`, set `PARACHUTE_HOME`:

```sh
export PARACHUTE_HOME=/some/other/path
```

## Already have parachute-vault installed?

Install the CLI and `parachute vault ...` forwards to your existing `parachute-vault` binary:

```sh
bun add -g @openparachute/cli
parachute vault init     # dispatches to parachute-vault init
parachute vault --help   # dispatches to parachute-vault --help
```

Nothing about your existing vault moves or needs reconfiguring.

## Smoke walkthrough (post-install)

Copy-paste to verify the whole chain. Everything here is idempotent.

```sh
# Install
bun add -g @openparachute/cli

# Verify CLI
parachute --version
parachute --help

# Install a service
parachute install vault

# Manifest should now exist
cat ~/.parachute/services.json

# Start it in the background
parachute start vault

# Status should show vault as running + healthy
parachute status

# Peek at the service's logs
parachute logs vault

# Expose across your tailnet (requires tailscale + `tailscale up`)
parachute expose tailnet

# Open the URL printed above in a browser on any tailnet peer.
# Also confirm the discovery document:
curl -s https://parachute.<tailnet>.ts.net/.well-known/parachute.json | jq .

# Flip to public (Funnel)
parachute expose public
# Open the same URL in a browser NOT on your tailnet — phone on cell, say.

# Tear down
parachute expose public off
```

## Subcommand reference

Run `parachute --help` for the top-level list, and `parachute <subcommand> --help` for details on any individual command.

```
parachute install <service>       install and register a service
parachute status                  show installed services, process state, health
parachute start   [service]       start services in the background
parachute stop    [service]       stop services (SIGTERM → 10s → SIGKILL)
parachute restart [service]       stop + start
parachute logs <service> [-f]     print/tail service logs
parachute expose tailnet [off]    HTTPS across your tailnet
parachute expose public  [off]    HTTPS on the public internet (Funnel)
parachute migrate [--dry-run]     archive legacy files at ecosystem root
parachute vault <args...>         dispatch to parachute-vault
```

## Status

Pre-alpha. API surface is stabilizing but not frozen.

## License

AGPL-3.0 — same as the rest of the Parachute ecosystem.

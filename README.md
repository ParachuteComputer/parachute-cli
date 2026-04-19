# Parachute CLI

`parachute` — the top-level command for the [Parachute](https://parachute.computer) ecosystem.

Install, inspect, and expose Parachute services with one command. Each service (vault, notes, scribe, channel, …) stays a standalone package; this CLI is the coordinator.

## Install

```sh
bun add -g @openparachute/cli
```

Prereqs: [Bun](https://bun.sh), and — for `parachute expose` — [Tailscale](https://tailscale.com/download) installed and `tailscale up` run at least once.

## First 5 minutes

```sh
# 1. Install the CLI (one line)
bun add -g @openparachute/cli

# 2. Install a service (runs `bun add -g @openparachute/vault` + `parachute-vault init`)
parachute install vault

# 3. Check it landed — reads ~/.parachute/services.json, probes health
parachute status
# SERVICE          PORT  VERSION  STATUS  LATENCY
# parachute-vault  1940  0.2.4    ok      2ms

# 4. Expose across your tailnet (HTTPS via Tailscale MagicDNS)
parachute expose tailnet
# ✓ Tailnet exposure active. Open: https://parachute.<tailnet>.ts.net/

# 5. Go public (Tailscale Funnel — same URL, now reachable from the internet)
parachute expose public
# ✓ Public exposure active (Funnel). Open: https://parachute.<tailnet>.ts.net/
```

Tear down with `parachute expose tailnet off` or `parachute expose public off`. Layers are independent — `off` only affects the layer you name.

## Three layers of addressability

Each additive; each can be turned off without affecting the layer below.

- **Local** — services on loopback. Zero config. Browsers treat `localhost` as a secure context, so OAuth, PKCE, and Web Crypto all just work out of the box.
- **Tailnet** — `parachute expose tailnet` wraps `tailscale serve` for every registered service. HTTPS via Tailscale's MagicDNS cert. Only machines on your tailnet can reach the URL.
- **Public** — `parachute expose public` adds `--funnel` to each handler so the same URLs become reachable from the public internet. At launch, Funnel is the only supported backend; Caddy + your-own-domain and cloudflared tunnels are planned post-launch.

Under the hood, tailnet and public share a single `tailscale serve` config. The CLI records which layer is live so that `expose <other-layer> off` is a no-op rather than a surprise teardown of the active layer.

## Path-routing (and why)

Every service mounts under a path on a single canonical hostname:

```
https://parachute.<tailnet>.ts.net/           → parachute-vault
https://parachute.<tailnet>.ts.net/notes      → parachute-notes
https://parachute.<tailnet>.ts.net/scribe     → parachute-scribe
https://parachute.<tailnet>.ts.net/.well-known/parachute.json   ← discovery
```

The `/.well-known/parachute.json` document maps short names to absolute URLs so clients can discover each other without knowing install-local ports:

```json
{
  "vault":  { "url": "https://parachute.taildf9ce2.ts.net/",       "version": "0.2.4" },
  "notes":  { "url": "https://parachute.taildf9ce2.ts.net/notes",  "version": "0.0.1" }
}
```

Why path-routing and not subdomain-per-service? Two reasons:

1. **Tailscale Funnel HTTPS is capped at three ports per node** (443, 8443, 10000). Pinning every service to 443 behind a path means you can install any number of services without ever hitting that cap.
2. **Subdomain-per-service requires the Tailscale Services feature** (virtual-IP advertisement per service), which is more than a MagicDNS wildcard — it needs admin-side setup that's out of scope for a one-command install. When it's a launch-grade path, we'll add `parachute expose tailnet --mode subdomain`.

Funnel has bandwidth quotas on Tailscale's free tier. See [tailscale.com/kb/1223/funnel](https://tailscale.com/kb/1223/funnel) for current limits; for heavy traffic, the post-launch Caddy / cloudflared modes will be the answer.

## How services register

Each Parachute service writes a manifest entry to `~/.parachute/services.json` on install. The CLI reads that manifest to drive `parachute status`, `parachute expose tailnet`, and `parachute expose public`.

```json
{
  "services": [
    {
      "name":    "parachute-vault",
      "port":    1940,
      "paths":   ["/"],
      "health":  "/health",
      "version": "0.2.4"
    }
  ]
}
```

The schema is a bit-for-bit contract shared between the CLI and every service. Services own their write side; the CLI owns the read + exposure side.

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

# Status should show vault as healthy
parachute status

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
parachute status                  show installed services and health
parachute expose tailnet [off]    HTTPS across your tailnet
parachute expose public  [off]    HTTPS on the public internet (Funnel)
parachute vault <args...>         dispatch to parachute-vault
```

## Status

Pre-alpha. API surface is stabilizing but not frozen.

## License

AGPL-3.0 — same as the rest of the Parachute ecosystem.

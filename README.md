# Parachute CLI

`parachute` — the top-level command for the [Parachute](https://parachute.computer) ecosystem.

Install, inspect, and expose Parachute services with one command. Each service (vault, notes, scribe, channel, …) remains a standalone package; this CLI is the coordinator.

## Status

Pre-alpha, in development.

## Install

```sh
bun add -g @openparachute/cli
```

Then:

```sh
parachute install vault
parachute install notes
parachute vault init          # still works — dispatches to parachute-vault
parachute status              # what's running, where
parachute expose tailnet      # HTTPS across your tailnet
parachute expose public       # HTTPS to the public internet
```

## How it works

Each Parachute service writes a manifest entry to `~/.parachute/services.json` on install. The CLI reads that manifest to generate the right config for `parachute status`, `parachute expose tailnet`, and `parachute expose public`.

Cross-service discovery travels through `/.well-known/parachute.json` at the canonical origin — Parachute Notes and any future clients probe it to find the vault (and anything else).

## Three layers of addressability

Each additive; each can be turned off without affecting the layer below.

- **Local** — services on loopback. Zero config. Browsers treat `localhost` as a secure context, so OAuth + PKCE + crypto-subtle all just work.
- **Tailnet** — `parachute expose tailnet` wraps `tailscale serve` for each installed service, HTTPS via Tailscale's MagicDNS cert.
- **Public** — `parachute expose public` supports three modes: Tailscale Funnel (default), Caddy + your own domain, cloudflared tunnel + your own domain.

See [the decision note](https://github.com/ParachuteComputer/parachute-vault) for the full design rationale.

## License

AGPL-3.0 — same as the rest of the Parachute ecosystem.

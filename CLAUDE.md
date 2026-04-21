# Parachute CLI

`parachute` — the top-level CLI. Installs services, runs them as background processes, and exposes them over Tailscale. Coordinator, not a service: each Parachute package (`vault`, `notes`, `scribe`, `channel`) stays standalone; this CLI stitches them together.

User-facing README is the right intro for operators. This file is for agents and humans working *on* the CLI itself.

## Architecture

```
parachute install <svc>   →  bun add -g + init + services.json seed   (src/commands/install.ts)
parachute start/stop/...  →  spawn detached bun, pidfile + logs       (src/commands/lifecycle.ts)
parachute status          →  read services.json + probe health        (src/commands/status.ts)
parachute expose <layer>  →  tailscale serve/funnel + hub proxy       (src/commands/expose.ts)
parachute migrate         →  sweep legacy ~/.parachute/ layout         (src/commands/migrate.ts)
parachute vault <args>    →  exec parachute-vault (transparent)        (src/commands/vault.ts)
```

The flat shape matters: each command is a self-contained module in `src/commands/`, wired through `src/cli.ts`'s argv parser. No framework, no plugin system, no global state beyond a handful of pure module constants.

### Shared surfaces

- **`src/service-spec.ts`** — `SERVICE_SPECS` is the registry: which npm package backs each short name, what to run on install/start, the canonical seed entry. Adding a new service = one entry here.
- **`src/services-manifest.ts`** — `~/.parachute/services.json` read/write. This file is the contract between the CLI and every service; services own the write side, the CLI owns read + exposure. Validation is strict on required fields; optional fields (`displayName`, `tagline`) pass through.
- **`src/hub-server.ts`** — internal Bun server on port 1939. Serves `/` (discovery page) and `/.well-known/parachute.json`. Spawned by `parachute expose`, stopped when the last layer goes away. Tailscale serve can't directly serve files on macOS (sandboxed), so this loopback proxy is the portable shape.
- **`src/expose-state.ts`** — which layers (tailnet/public) are currently up, persisted to `~/.parachute/expose-state.json`. Lets `expose <layer> off` be precise rather than blowing away everything.
- **`src/tailscale/`** — thin wrappers around `tailscale serve` / `tailscale funnel`. Shape is pinned to 1.82+ (`funnel` as its own subcommand).

## Key design decisions

- **Services own their write side of `services.json`.** The CLI only seeds an entry if none exists post-install (`seedEntry` in SERVICE_SPECS) — version `"0.0.0-linked"` telegraphs "stopgap, service's own boot will overwrite." Real service boots are authoritative.
- **Hub owns `/`.** Path-routing at a single canonical hostname so we never hit Tailscale Funnel's 3-port-per-node cap. Subdomain-per-service needs Tailscale Services (admin setup); out of scope for one-command install. Legacy `paths: ["/"]` entries are remapped in-memory to `/<shortname>`; `parachute install <svc>` rewrites them permanently.
- **Canonical port range 1939–1949.** Hub pins 1939 with no fallback — `tailscale serve` needs a stable localhost target, so a walking fallback would silently break cross-machine URLs. Third-party ports warn but aren't blocked.
- **`bun link` detection.** `install` checks bun's global node_modules for a symlink before `bun add -g`. Motivator: scribe isn't on npm yet; without this, `bun add -g @openparachute/scribe` 404s.
- **Runner injection seam.** Every command that shells out accepts an injectable `Runner` (`readonly string[] => Promise<number>`). Tests drive it without touching `Bun.spawn`.

## Bun-native

Bun everywhere. No Node.js runtime assumptions, no tsc for emit (types only).

- `Bun.spawn` for child processes; `stdio: ["inherit", "inherit", "inherit"]` for shell-forward commands.
- `Bun.serve` for the hub process.
- `bun test` for tests (no jest, no vitest). Tests live in `src/__tests__/`.
- `bun` reads `.ts` directly — `bin` in `package.json` points at `src/cli.ts`.

## Running

```sh
bun src/cli.ts --help            # dogfood the CLI from source
bun test                         # run all tests
bun test src/__tests__/expose    # one suite
bunx biome check --write .       # format + lint
bun run typecheck                # tsc --noEmit (types only)
```

For end-to-end against a real install, `bun link` this repo; the linked `parachute` binary follows the checked-out branch (see post-merge hygiene below).

## Post-merge hygiene

**After a PR merges, locally:**

```sh
git checkout main && git pull
```

Aaron's `parachute` binary is bun-linked to this checkout. Leaving the repo on a feature branch after merge means his next `parachute ...` runs stale feature-branch code, not the merged `main`. Caught 2026-04-21 after several stewards (including the old cli steward) left repos on feature branches after merge.

Every PR here is reviewer-gated — no direct-to-main, even for one-line fixes. `hotfix:` title prefix signals urgency; it doesn't skip review.

## Naming

- Domain: `parachute.computer`
- npm scope: `@openparachute/` (this package: `@openparachute/cli`)
- Bin name: `parachute`
- Config root: `~/.parachute/` (override with `PARACHUTE_HOME`)
- Per-service dirs: `~/.parachute/<short>/` (e.g. `~/.parachute/vault/`)
- Short names (map to `manifestName` via `SERVICE_SPECS`): `vault`, `notes`, `scribe`, `channel`

## License

AGPL-3.0.

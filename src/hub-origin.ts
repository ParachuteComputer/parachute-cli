/**
 * The Parachute hub is the ecosystem's OAuth issuer (Phase 0 of the hub-as-
 * portal design at DESIGN-2026-04-20-hub-as-portal-oauth-and-service-catalog.md).
 * Every service that participates in OAuth (today just vault; scribe + channel
 * later) needs to know what URL clients will use to discover and reach the
 * issuer — and that URL has to match what tailscale actually serves.
 *
 *   exposed (tailnet or public) → `https://<fqdn>`
 *   not exposed (local dev)     → `http://127.0.0.1:<hub-port>`
 *   user override               → whatever --hub-origin was passed
 *
 * One source of truth — expose/start both route through `deriveHubOrigin`.
 */

export const HUB_ORIGIN_ENV = "PARACHUTE_HUB_ORIGIN";

export interface DeriveHubOriginOpts {
  /** Explicit user override (e.g., `--hub-origin`). Wins over everything else. */
  override?: string;
  /**
   * Tailnet FQDN from a live exposure. Present when `expose-state.json`
   * carries a canonicalFqdn; absent for unexposed local dev.
   */
  exposeFqdn?: string;
  /**
   * Bound hub port for the localhost fallback. When no exposure and no hub
   * port exists, we pass through `undefined` and callers decide what to do
   * (typically: skip setting the env so vault advertises its own issuer).
   */
  hubPort?: number;
}

/**
 * Resolve the canonical hub origin. Returns `undefined` only when no source
 * of truth is available (no override, no exposure, no hub port). Callers that
 * set `PARACHUTE_HUB_ORIGIN` on a child process should skip the env var
 * entirely in that case so the service falls back to its own defaults.
 */
export function deriveHubOrigin(opts: DeriveHubOriginOpts): string | undefined {
  if (opts.override) return opts.override.replace(/\/+$/, "");
  if (opts.exposeFqdn) return `https://${opts.exposeFqdn}`;
  if (opts.hubPort !== undefined) return `http://127.0.0.1:${opts.hubPort}`;
  return undefined;
}

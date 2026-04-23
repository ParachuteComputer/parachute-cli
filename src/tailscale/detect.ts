import type { Runner } from "./run.ts";
import { TailscaleError } from "./run.ts";

/** ACL capability key Tailscale emits on `Self.CapMap` when the node is
 * allowed to run Funnel. Internal-ish surface: the key string is stable in
 * practice but not documented as API. Treat the probe as best-effort (see
 * {@link hasFunnelCapability}). */
const FUNNEL_CAP_KEY = "https://tailscale.com/cap/funnel";

export async function isTailscaleInstalled(runner: Runner): Promise<boolean> {
  try {
    const { code } = await runner(["tailscale", "version"]);
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Returns `true` when `tailscale status --json` responds with a node logged
 * into a tailnet (Self.DNSName is non-empty). False on `Logged out`, `Stopped`,
 * install/PATH errors, or parse failures — callers use this to decide whether
 * to prompt the user to run `tailscale up` before anything else.
 */
export async function isTailscaleLoggedIn(runner: Runner): Promise<boolean> {
  try {
    const result = await runner(["tailscale", "status", "--json"]);
    if (result.code !== 0) return false;
    const parsed = JSON.parse(result.stdout) as { Self?: { DNSName?: unknown } };
    const dnsName = parsed.Self?.DNSName;
    return typeof dnsName === "string" && dnsName.length > 0;
  } catch {
    return false;
  }
}

/**
 * Best-effort probe for whether this node is allowed to expose Funnel. Reads
 * `Self.CapMap` from `tailscale status --json` and checks for the Funnel
 * capability key.
 *
 * Caveat: `CapMap` is a semi-internal field whose shape Tailscale can shift
 * across versions. This probe is not load-bearing — a false negative only
 * means we'll point the user at the admin console when they don't actually
 * need to do anything. The downstream `tailscale funnel` call is the real
 * gate; this just lets us nudge the user earlier in the flow.
 */
export async function hasFunnelCapability(runner: Runner): Promise<boolean> {
  try {
    const result = await runner(["tailscale", "status", "--json"]);
    if (result.code !== 0) return false;
    const parsed = JSON.parse(result.stdout) as { Self?: { CapMap?: Record<string, unknown> } };
    const capMap = parsed.Self?.CapMap;
    if (!capMap || typeof capMap !== "object") return false;
    return FUNNEL_CAP_KEY in capMap;
  } catch {
    return false;
  }
}

export async function getFqdn(runner: Runner): Promise<string> {
  const result = await runner(["tailscale", "status", "--json"]);
  if (result.code !== 0) {
    throw new TailscaleError(
      `tailscale status --json exited ${result.code}: ${result.stderr.trim()}`,
      ["tailscale", "status", "--json"],
      result,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new TailscaleError(
      `failed to parse tailscale status JSON: ${err instanceof Error ? err.message : String(err)}`,
      ["tailscale", "status", "--json"],
      result,
    );
  }
  const self = (parsed as { Self?: { DNSName?: unknown } }).Self;
  const dnsName = self?.DNSName;
  if (typeof dnsName !== "string" || dnsName.length === 0) {
    throw new TailscaleError(
      "tailscale status did not return Self.DNSName — is this machine logged in?",
      ["tailscale", "status", "--json"],
      result,
    );
  }
  return dnsName.replace(/\.$/, "");
}

/**
 * Detect whether wildcard MagicDNS is active — i.e. whether subdomains of the
 * current machine (vault.<fqdn>, notes.<fqdn>, …) resolve back to this node.
 *
 * Tailscale's standard MagicDNS gives each machine a single hostname and does
 * not auto-resolve arbitrary subdomains; wildcard MagicDNS exists in the
 * Services feature but requires explicit advertisement. For launch we return
 * false (path-routing) and let a later PR add real detection once the
 * subdomain-per-service path is supported end-to-end.
 */
export async function detectWildcardMagicDNS(_runner: Runner): Promise<boolean> {
  return false;
}

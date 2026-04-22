import type { Runner } from "./run.ts";
import { TailscaleError } from "./run.ts";

export async function isTailscaleInstalled(runner: Runner): Promise<boolean> {
  try {
    const { code } = await runner(["tailscale", "version"]);
    return code === 0;
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

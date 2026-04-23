import type { Runner } from "../tailscale/run.ts";

/**
 * Detect whether `cloudflared` is installed and on PATH. We don't require
 * any particular version — cloudflared's tunnel CLI has been stable for
 * years, so `cloudflared version` exiting successfully is a sufficient signal.
 */
export async function isCloudflaredInstalled(runner: Runner): Promise<boolean> {
  try {
    const result = await runner(["cloudflared", "version"]);
    return result.code === 0;
  } catch {
    return false;
  }
}

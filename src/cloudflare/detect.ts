import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../tailscale/run.ts";

export const DEFAULT_CLOUDFLARED_HOME = join(homedir(), ".cloudflared");

/**
 * `cloudflared --version` is the canonical liveness probe. Wrap in try/catch
 * so that an ENOENT from Bun.spawn (binary not on PATH) reads as "not
 * installed" rather than bubbling up as an unhandled error — same shape as
 * `isTailscaleInstalled`.
 */
export async function isCloudflaredInstalled(runner: Runner): Promise<boolean> {
  try {
    const { code } = await runner(["cloudflared", "--version"]);
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * `cloudflared tunnel login` drops a cert at `~/.cloudflared/cert.pem` — its
 * presence is cloudflared's own login marker. Every `cloudflared tunnel
 * create|list|route` call reads this file; without it those commands fail
 * with "Cannot determine default origin certificate path", which is a worse
 * surface than catching the missing cert up front.
 */
export function isCloudflaredLoggedIn(cloudflaredHome: string = DEFAULT_CLOUDFLARED_HOME): boolean {
  return existsSync(join(cloudflaredHome, "cert.pem"));
}

export function cloudflaredInstallHint(platform: NodeJS.Platform = process.platform): string {
  const url =
    "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
  if (platform === "darwin") {
    return `Install cloudflared:\n  brew install cloudflared\n(or see ${url})`;
  }
  if (platform === "linux") {
    return `Install cloudflared: ${url}`;
  }
  return `Install cloudflared: ${url}`;
}

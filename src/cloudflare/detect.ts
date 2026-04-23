import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../tailscale/run.ts";

export const DEFAULT_CLOUDFLARED_HOME = join(homedir(), ".cloudflared");

/**
 * `cloudflared --version` is the canonical liveness probe. Swallow only
 * "binary not on PATH" errors — anything else (EACCES from a non-executable
 * file, corrupted binary, etc.) propagates so we don't silently report
 * "not installed" when something more specific is wrong.
 */
export async function isCloudflaredInstalled(runner: Runner): Promise<boolean> {
  try {
    const { code } = await runner(["cloudflared", "--version"]);
    return code === 0;
  } catch (err) {
    if (isBinaryNotFoundError(err)) return false;
    throw err;
  }
}

function isBinaryNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "ENOENT") return true;
  // Bun.spawn's error shape varies across versions; fall back to message
  // string matching so we catch "Executable not found in $PATH" and
  // "ENOENT" variants without pinning to one runtime detail.
  if (typeof e.message === "string") {
    return /ENOENT|not found|No such file/i.test(e.message);
  }
  return false;
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

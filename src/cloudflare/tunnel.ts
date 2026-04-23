/**
 * Minimal wrapper around `cloudflared tunnel --url http://127.0.0.1:<port>`.
 *
 * Spawns a long-lived quick tunnel pointed at a local service and parses the
 * generated `*.trycloudflare.com` URL out of cloudflared's log output. Returns
 * the child PID + URL so the caller can write state, print guidance, and tear
 * the tunnel down later by killing the PID.
 *
 * Quick tunnels are ephemeral — the URL changes every time cloudflared starts.
 * They're useful for demos and claude.ai connector testing but not for durable
 * public exposure. Named tunnel support (with a domain) is tracked as a
 * follow-up; that path will land here alongside this shim.
 */

import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { CONFIG_DIR } from "../config.ts";

export interface QuickTunnelResult {
  pid: number;
  url: string;
  logPath: string;
}

export interface SpawnQuickTunnelOpts {
  /** Port of the local service to tunnel to (e.g. the vault at 1940). */
  port: number;
  /** Override cloudflared command (tests inject a shim). Default: "cloudflared". */
  bin?: string;
  /** Override the log directory. Default: ~/.parachute/cloudflared/. */
  logDir?: string;
  /** Max ms to wait for the URL to appear in stderr. Default 15s. */
  timeoutMs?: number;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export async function spawnQuickTunnel(opts: SpawnQuickTunnelOpts): Promise<QuickTunnelResult> {
  const bin = opts.bin ?? "cloudflared";
  const logDir = opts.logDir ?? join(CONFIG_DIR, "cloudflared");
  const timeoutMs = opts.timeoutMs ?? 15_000;

  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "quick-tunnel.log");

  const logFd = Bun.file(logPath).writer();

  const proc = Bun.spawn(
    [bin, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${opts.port}`],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // cloudflared writes the URL to stderr in a multi-line banner. Tail both
  // streams until we find the URL (or time out / process exits).
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for cloudflared URL (${timeoutMs}ms)`));
    }, timeoutMs);

    let found = false;

    const tail = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          const chunk = decoder.decode(value, { stream: true });
          logFd.write(chunk);
          if (!found) {
            const match = chunk.match(URL_RE);
            if (match) {
              found = true;
              clearTimeout(timer);
              resolve(match[0]);
            }
          }
        }
      } catch {
        // stream closed; ignore
      }
    };

    void tail(proc.stdout as ReadableStream<Uint8Array> | null);
    void tail(proc.stderr as ReadableStream<Uint8Array> | null);

    proc.exited.then((code) => {
      if (!found) {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited ${code} before emitting a URL`));
      }
    });
  });

  return { pid: proc.pid, url, logPath };
}

/**
 * Stop a running cloudflared PID. Returns true if the process was still alive
 * and received the signal; false if it was already gone.
 */
export function stopQuickTunnel(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    throw err;
  }
}

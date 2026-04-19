export interface ServeEntry {
  kind: "proxy" | "file";
  mount: string;
  target: string;
  service: string;
}

export interface BringupOpts {
  funnel?: boolean;
  port?: number;
}

export function bringupCommand(entry: ServeEntry, opts: BringupOpts = {}): string[] {
  const port = opts.port ?? 443;
  const cmd = ["tailscale", "serve", "--bg"];
  if (opts.funnel) cmd.push("--funnel");
  cmd.push(`--https=${port}`);
  cmd.push(`--set-path=${entry.mount}`);
  cmd.push(entry.target);
  return cmd;
}

export function teardownCommand(entry: ServeEntry, opts: BringupOpts = {}): string[] {
  const port = opts.port ?? 443;
  return ["tailscale", "serve", `--https=${port}`, `--set-path=${entry.mount}`, "off"];
}

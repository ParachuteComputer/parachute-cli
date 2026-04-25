import { fileURLToPath } from "node:url";
import type { ServiceEntry } from "./services-manifest.ts";

/**
 * Canonical Parachute port range. Every ecosystem service reserves a slot in
 * 1939–1949; third-party integrators are expected to avoid it.
 *
 *   1939  parachute-hub      internal static + proxy, CLI-managed
 *   1940  parachute-vault
 *   1941  parachute-channel
 *   1942  parachute-notes    static server over the PWA bundle
 *   1943  parachute-scribe
 *   1944  reserved — pendant
 *   1945  reserved — daily-v2
 *   1946–1949  reserved
 *
 * Hub pins 1939: `parachute expose` composes hub targets as
 * `http://127.0.0.1:1939/` and that URL has to be stable across machines for
 * tailscale serve to proxy it correctly. The hub-port fallback range is 1
 * (see hub-control.ts) — if something else is on 1939 we fail loudly rather
 * than walking up into a service's slot.
 *
 * Ports outside the range aren't blocked. `parachute install` warns but
 * proceeds, since forks and non-standard deployments sometimes land on other
 * ports intentionally.
 */
export const CANONICAL_PORT_MIN = 1939;
export const CANONICAL_PORT_MAX = 1949;

export interface PortReservation {
  readonly port: number;
  readonly name: string;
  readonly status: "assigned" | "reserved";
}

export const PORT_RESERVATIONS: readonly PortReservation[] = [
  { port: 1939, name: "parachute-hub", status: "assigned" },
  { port: 1940, name: "parachute-vault", status: "assigned" },
  { port: 1941, name: "parachute-channel", status: "assigned" },
  { port: 1942, name: "parachute-notes", status: "assigned" },
  { port: 1943, name: "parachute-scribe", status: "assigned" },
  { port: 1944, name: "pendant", status: "reserved" },
  { port: 1945, name: "daily-v2", status: "reserved" },
  { port: 1946, name: "unassigned", status: "reserved" },
  { port: 1947, name: "unassigned", status: "reserved" },
  { port: 1948, name: "unassigned", status: "reserved" },
  { port: 1949, name: "unassigned", status: "reserved" },
];

export function isCanonicalPort(port: number): boolean {
  return port >= CANONICAL_PORT_MIN && port <= CANONICAL_PORT_MAX;
}

/**
 * Broad shape of a service. Matches the hub's card-kind taxonomy.
 *   "frontend"  a user-facing UI (notes). Safe to expose by default.
 *   "api"       a programmatic surface (vault, channel, scribe). Whether
 *               it's safe to expose depends on `hasAuth`.
 *   "tool"      like "api" but specifically MCP-shaped / agent-callable.
 *               Treated the same as "api" for exposure defaults.
 */
export type ServiceKind = "api" | "tool" | "frontend";

export interface ServiceSpec {
  readonly package: string;
  readonly manifestName: string;
  readonly init?: readonly string[];
  /**
   * Command to spawn for `parachute start <svc>`. Receives the services.json
   * entry so commands that need per-install data (e.g., the notes static-serve
   * shim needs the configured port) can pull it from there.
   *
   * Returns `undefined` to declare "lifecycle not supported for this service."
   * That never applies today but leaves a seam for future services that
   * shouldn't be managed by `parachute start`.
   */
  readonly startCmd?: (entry: ServiceEntry) => readonly string[] | undefined;
  /**
   * Canonical initial services.json entry used when the service hasn't
   * written its own entry yet. Fires post-install only if `findService`
   * returns undefined — normal npm installs hit this almost never (the
   * service's init or first boot writes the authoritative entry first).
   *
   * Main use case: `bun link` local-dev installs where the service hasn't
   * run yet but `parachute expose` / `parachute start` need an entry to
   * plan against. First service boot overwrites the seed with its own
   * authoritative version.
   */
  readonly seedEntry?: () => ServiceEntry;
  /**
   * Declares the service's broad shape. Drives exposure defaults: api/tool
   * services without auth fall back to `publicExposure: "auth-required"`
   * (treated as loopback at launch); frontends default to "allowed".
   */
  readonly kind?: ServiceKind;
  /**
   * Does the service gate its endpoints behind auth today? Used together with
   * `kind` to pick a safe default when the services.json entry omits
   * `publicExposure`. True for vault/channel (owner-authenticated);
   * conservatively false for scribe until its auth-gate ships.
   */
  readonly hasAuth?: boolean;
  /**
   * Canonical reachable URL for the service given its manifest entry. Drives
   * the URL column in `parachute status` and any other place we need to
   * render "where do I point a client?". Most services use port + paths[0],
   * but some need to append a fixed suffix (vault's MCP endpoint lives at
   * `/vault/<name>/mcp`, not the bare mount path).
   *
   * Returns undefined when the entry doesn't carry enough info — callers
   * should fall back to the bare `http://127.0.0.1:<port>` form.
   */
  readonly urlForEntry?: (entry: ServiceEntry) => string | undefined;
  /**
   * Lines printed at the end of `parachute install <svc>` so the user has a
   * clear next step. Vault's footer comes from `parachute-vault init` itself
   * (PR #166) — richer because it can read the freshly-minted API token —
   * so vault's spec leaves this off.
   */
  readonly postInstallFooter?: () => readonly string[];
}

const NOTES_SERVE_PATH = fileURLToPath(new URL("./notes-serve.ts", import.meta.url));

/**
 * Seed entries land in services.json as placeholder rows when a freshly
 * installed service hasn't written its own. Version `"0.0.0-linked"`
 * telegraphs the state: the row is a stopgap, and the service's first boot
 * will overwrite with its own authoritative write.
 */
const SEED_VERSION = "0.0.0-linked";

function pathBasedUrl(entry: ServiceEntry): string {
  const first = entry.paths[0] ?? "";
  // Strip a trailing slash so concatenation never doubles up.
  const path = first.replace(/\/+$/, "");
  return `http://127.0.0.1:${entry.port}${path}`;
}

export const SERVICE_SPECS: Record<string, ServiceSpec> = {
  vault: {
    package: "@openparachute/vault",
    manifestName: "parachute-vault",
    init: ["parachute-vault", "init"],
    startCmd: () => ["parachute-vault", "serve"],
    kind: "api",
    hasAuth: true,
    seedEntry: () => ({
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
      version: SEED_VERSION,
    }),
    // Vault's MCP endpoint lives one segment past the mount path. The bare
    // `/vault/<name>` URL is the discovery shape; clients (claude.ai et al.)
    // need `/vault/<name>/mcp` to actually open the stream.
    urlForEntry: (entry) => `${pathBasedUrl(entry)}/mcp`,
  },
  notes: {
    // Frontend product name is "Notes". vault's internal `/api/notes` endpoint
    // is unrelated — different concept (vault data primitive vs. PWA brand).
    package: "@openparachute/notes",
    manifestName: "parachute-notes",
    startCmd: (entry) => {
      const first = entry.paths[0] ?? "/notes";
      const mount = first === "/" ? "" : first.replace(/\/+$/, "");
      return ["bun", NOTES_SERVE_PATH, "--port", String(entry.port), "--mount", mount];
    },
    kind: "frontend",
    seedEntry: () => ({
      name: "parachute-notes",
      port: 1942,
      paths: ["/notes"],
      health: "/notes/health",
      version: SEED_VERSION,
    }),
    urlForEntry: pathBasedUrl,
    postInstallFooter: () => [
      "",
      "Open your Notes UI at http://localhost:1942/notes — paste the vault URL",
      "  http://127.0.0.1:1940/vault/default",
      "and the API token from your vault install.",
    ],
  },
  scribe: {
    package: "@openparachute/scribe",
    manifestName: "parachute-scribe",
    startCmd: () => ["parachute-scribe", "serve"],
    // No auth gate today. Scribe's launch PR adds optional SCRIBE_AUTH_TOKEN;
    // once it lands and scribe writes `publicExposure: "allowed"` when a token
    // is configured, that explicit declaration overrides this default.
    kind: "api",
    hasAuth: false,
    seedEntry: () => ({
      name: "parachute-scribe",
      port: 1943,
      paths: ["/scribe"],
      health: "/scribe/health",
      version: SEED_VERSION,
    }),
    // Scribe's API is at the root, not under `/scribe`. The path prefix only
    // shows up in the health endpoint; clients hit the bare port.
    urlForEntry: (entry) => `http://127.0.0.1:${entry.port}`,
    postInstallFooter: () => [
      "",
      "Scribe is listening on http://127.0.0.1:1943.",
      "Vault will auto-call this for transcription (SCRIBE_URL has been wired to the vault env).",
      "Configure the transcription provider at ~/.parachute/scribe/scribe.config.json — defaults",
      "to `parakeet-mlx` (Apple Silicon, requires `parakeet-mlx` binary). Pick `groq` / `openai`",
      "/ `cloudflare` / `whisper-cpp` if you want a different one.",
    ],
  },
  channel: {
    package: "@openparachute/channel",
    manifestName: "parachute-channel",
    startCmd: () => ["parachute-channel", "daemon"],
    kind: "api",
    hasAuth: true,
    seedEntry: () => ({
      name: "parachute-channel",
      port: 1941,
      paths: ["/channel"],
      health: "/channel/health",
      version: SEED_VERSION,
    }),
    urlForEntry: pathBasedUrl,
  },
};

/**
 * Effective publicExposure for a service, given what's on its services.json
 * entry. Explicit wins. If absent, derive from the spec: known api/tool
 * services without declared auth fall back to "auth-required" (treated as
 * loopback at launch); everything else defaults to "allowed" — so vault,
 * notes, channel and unknown third-party services continue to be exposed
 * without needing to opt in.
 */
export function effectivePublicExposure(
  entry: ServiceEntry,
): "allowed" | "loopback" | "auth-required" {
  if (entry.publicExposure !== undefined) return entry.publicExposure;
  const short = shortNameForManifest(entry.name);
  const spec = short !== undefined ? SERVICE_SPECS[short] : undefined;
  if (spec && (spec.kind === "api" || spec.kind === "tool") && spec.hasAuth === false) {
    return "auth-required";
  }
  return "allowed";
}

export function knownServices(): string[] {
  return Object.keys(SERVICE_SPECS);
}

export function getSpec(service: string): ServiceSpec | undefined {
  return SERVICE_SPECS[service];
}

/**
 * Legacy manifest names kept so `parachute start` / `stop` / `logs` keep
 * working on an already-installed services.json that still carries the
 * old name.
 *
 * `parachute-notes` was the original; it became `parachute-lens` for ~3
 * days during the Lens rebrand window (2026-04-19 → 2026-04-22), then
 * reverted. Users who installed during that window have `parachute-lens`
 * in their services.json and need lifecycle commands to keep finding
 * their install — without this alias, `parachute start/stop/logs/status`
 * silently skip those rows. Remove after launch, alongside the `lens →
 * notes` install alias.
 */
const LEGACY_MANIFEST_ALIASES: Record<string, string> = {
  "parachute-lens": "notes",
};

/** Short name (the key into SERVICE_SPECS) for a given manifest name, e.g.
 *  `parachute-vault` → `vault`. Returns undefined for unknown manifests. */
export function shortNameForManifest(manifestName: string): string | undefined {
  for (const [short, spec] of Object.entries(SERVICE_SPECS)) {
    if (spec.manifestName === manifestName) return short;
  }
  return LEGACY_MANIFEST_ALIASES[manifestName];
}

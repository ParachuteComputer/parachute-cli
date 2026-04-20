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
}

const NOTES_SERVE_PATH = fileURLToPath(new URL("./notes-serve.ts", import.meta.url));

/**
 * Seed entries land in services.json as placeholder rows when a freshly
 * installed service hasn't written its own. Version `"0.0.0-linked"`
 * telegraphs the state: the row is a stopgap, and the service's first boot
 * will overwrite with its own authoritative write.
 */
const SEED_VERSION = "0.0.0-linked";

export const SERVICE_SPECS: Record<string, ServiceSpec> = {
  vault: {
    package: "@openparachute/vault",
    manifestName: "parachute-vault",
    init: ["parachute-vault", "init"],
    startCmd: () => ["parachute-vault", "serve"],
    seedEntry: () => ({
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
      version: SEED_VERSION,
    }),
  },
  notes: {
    package: "@openparachute/notes",
    manifestName: "parachute-notes",
    startCmd: (entry) => ["bun", NOTES_SERVE_PATH, "--port", String(entry.port)],
    seedEntry: () => ({
      name: "parachute-notes",
      port: 1942,
      paths: ["/notes"],
      health: "/notes/health",
      version: SEED_VERSION,
    }),
  },
  scribe: {
    package: "@openparachute/scribe",
    manifestName: "parachute-scribe",
    startCmd: () => ["parachute-scribe", "serve"],
    seedEntry: () => ({
      name: "parachute-scribe",
      port: 1943,
      paths: ["/scribe"],
      health: "/scribe/health",
      version: SEED_VERSION,
    }),
  },
  channel: {
    package: "@openparachute/channel",
    manifestName: "parachute-channel",
    startCmd: () => ["parachute-channel", "daemon"],
    seedEntry: () => ({
      name: "parachute-channel",
      port: 1941,
      paths: ["/channel"],
      health: "/channel/health",
      version: SEED_VERSION,
    }),
  },
};

export function knownServices(): string[] {
  return Object.keys(SERVICE_SPECS);
}

export function getSpec(service: string): ServiceSpec | undefined {
  return SERVICE_SPECS[service];
}

/** Short name (the key into SERVICE_SPECS) for a given manifest name, e.g.
 *  `parachute-vault` → `vault`. Returns undefined for unknown manifests. */
export function shortNameForManifest(manifestName: string): string | undefined {
  for (const [short, spec] of Object.entries(SERVICE_SPECS)) {
    if (spec.manifestName === manifestName) return short;
  }
  return undefined;
}

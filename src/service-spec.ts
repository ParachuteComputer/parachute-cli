import { fileURLToPath } from "node:url";
import type { ServiceEntry } from "./services-manifest.ts";

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
}

const NOTES_SERVE_PATH = fileURLToPath(new URL("./notes-serve.ts", import.meta.url));

export const SERVICE_SPECS: Record<string, ServiceSpec> = {
  vault: {
    package: "@openparachute/vault",
    manifestName: "parachute-vault",
    init: ["parachute-vault", "init"],
    startCmd: () => ["parachute-vault", "serve"],
  },
  notes: {
    package: "@openparachute/notes",
    manifestName: "parachute-notes",
    startCmd: (entry) => ["bun", NOTES_SERVE_PATH, "--port", String(entry.port)],
  },
  scribe: {
    package: "@openparachute/scribe",
    manifestName: "parachute-scribe",
    startCmd: () => ["parachute-scribe", "serve"],
  },
  channel: {
    package: "@openparachute/channel",
    manifestName: "parachute-channel",
    startCmd: () => ["parachute-channel", "daemon"],
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

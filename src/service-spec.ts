export interface ServiceSpec {
  readonly package: string;
  readonly manifestName: string;
  readonly init?: readonly string[];
}

export const SERVICE_SPECS: Record<string, ServiceSpec> = {
  vault: {
    package: "@openparachute/vault",
    manifestName: "parachute-vault",
    init: ["parachute-vault", "init"],
  },
  notes: {
    package: "@openparachute/notes",
    manifestName: "parachute-notes",
  },
  scribe: {
    package: "@openparachute/scribe",
    manifestName: "parachute-scribe",
  },
  channel: {
    package: "@openparachute/channel",
    manifestName: "parachute-channel",
  },
};

export function knownServices(): string[] {
  return Object.keys(SERVICE_SPECS);
}

export function getSpec(service: string): ServiceSpec | undefined {
  return SERVICE_SPECS[service];
}

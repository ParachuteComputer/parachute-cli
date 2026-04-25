import { parseEnvFile, upsertEnvLine, writeEnvFile } from "./env-file.ts";
import { CANONICAL_PORT_MAX, CANONICAL_PORT_MIN, PORT_RESERVATIONS } from "./service-spec.ts";

/**
 * The CLI is the port authority for Parachute services. At install time it
 * picks a port for each service, writes `PORT=<port>` into the service's
 * `~/.parachute/<svc>/.env`, and reflects the chosen port in services.json.
 * Services keep a compiled-in fallback (e.g. vault → 1940) so a stand-alone
 * `bun run` still works, but the CLI's PORT env var wins on installs it
 * manages.
 *
 * Why up-front assignment instead of detect-on-collision-at-boot:
 *   - Two services racing to bind the same port produces an opaque "address in
 *     use" deep inside one of them. Assigning at install lets the CLI keep
 *     a single coherent picture of who owns what.
 *   - The hub's reverse-proxy targets are computed from services.json. If a
 *     service silently falls back to a different port at runtime, the hub
 *     proxies to a dead port and the user sees a 502 with no explanation.
 *   - Re-installs stay idempotent: the existing `PORT=` in .env wins, so a
 *     user who edited their port keeps it across upgrades.
 */

export type AssignmentSource = "canonical" | "fallback-in-range" | "fallback-out-of-range";

export interface PortAssignment {
  readonly port: number;
  readonly source: AssignmentSource;
  /** Set when the canonical slot wasn't available — caller logs it. */
  readonly warning?: string;
}

/**
 * Pure: pick a port given the canonical default and the set of ports we
 * already know to be taken.
 *
 *   1. Prefer canonical (the slot the service expects, e.g. vault → 1940).
 *   2. On collision, walk the unassigned canonical reservations (1944..1949
 *      today) — keeps the install inside the Parachute range so other
 *      software doesn't accidentally land on the same port.
 *   3. Range exhausted: walk past CANONICAL_PORT_MAX. The warning lets the
 *      caller surface it; the install still proceeds.
 *
 * Third-party services (no canonical slot) skip step 1 and start at step 2.
 */
export function assignPort(
  canonical: number | undefined,
  occupied: Iterable<number>,
): PortAssignment {
  const taken = new Set(occupied);

  if (canonical !== undefined && !taken.has(canonical)) {
    return { port: canonical, source: "canonical" };
  }

  for (const reservation of PORT_RESERVATIONS) {
    if (reservation.status !== "reserved") continue;
    if (taken.has(reservation.port)) continue;
    const warning =
      canonical !== undefined
        ? `canonical port ${canonical} is in use; assigned ${reservation.port} from the unassigned Parachute range.`
        : `assigned port ${reservation.port} from the unassigned Parachute range (no canonical slot for this service).`;
    return { port: reservation.port, source: "fallback-in-range", warning };
  }

  let p = CANONICAL_PORT_MAX + 1;
  while (taken.has(p) && p < 65536) p++;
  return {
    port: p,
    source: "fallback-out-of-range",
    warning: `Parachute canonical range (${CANONICAL_PORT_MIN}–${CANONICAL_PORT_MAX}) is full; assigned ${p} outside the range — may conflict with other software.`,
  };
}

export interface AssignServicePortOpts {
  /** Path to the service's `.env` file. */
  readonly envPath: string;
  /** Canonical default for this service, or undefined for third-party. */
  readonly canonical?: number;
  /** Ports we already know to be taken. */
  readonly occupied: Iterable<number>;
}

export interface AssignServicePortResult {
  readonly port: number;
  /** "preserved" when an existing PORT in .env was kept; otherwise the
   *  source from `assignPort`. */
  readonly source: "preserved" | AssignmentSource;
  /** True when we wrote PORT into .env on this call. */
  readonly written: boolean;
  /** Warning to surface to the user, if any. */
  readonly warning?: string;
}

/**
 * Reconcile a service's PORT with its `.env`. Idempotent:
 *   - If PORT is already set in .env, preserve it (`source: "preserved"`).
 *     Re-installs and user-edited ports survive across upgrades.
 *   - Otherwise call `assignPort` and write `PORT=<port>` into .env.
 *
 * Reads only the value of PORT from .env; everything else is round-tripped
 * untouched via `parseEnvFile` / `upsertEnvLine` / `writeEnvFile`.
 */
export function assignServicePort(opts: AssignServicePortOpts): AssignServicePortResult {
  const env = parseEnvFile(opts.envPath);
  const existing = env.values.PORT;
  if (existing !== undefined && /^[1-9]\d{0,4}$/.test(existing)) {
    const port = Number(existing);
    if (port > 0 && port < 65536) {
      return { port, source: "preserved", written: false };
    }
  }

  const assignment = assignPort(opts.canonical, opts.occupied);
  const nextLines = upsertEnvLine(env.lines, "PORT", String(assignment.port));
  writeEnvFile(opts.envPath, nextLines);
  const result: AssignServicePortResult = {
    port: assignment.port,
    source: assignment.source,
    written: true,
  };
  if (assignment.warning) {
    return { ...result, warning: assignment.warning };
  }
  return result;
}

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root config directory. Honors `$PARACHUTE_HOME` to match the convention
 * used by `parachute-vault` — both sides must resolve the same path for the
 * shared `services.json` to round-trip.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PARACHUTE_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".parachute");
}

export const CONFIG_DIR = configDir();
export const SERVICES_MANIFEST_PATH = join(CONFIG_DIR, "services.json");

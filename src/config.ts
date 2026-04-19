import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".parachute");
export const SERVICES_MANIFEST_PATH = join(CONFIG_DIR, "services.json");

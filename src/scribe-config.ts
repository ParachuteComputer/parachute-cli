import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnvFile, upsertEnvLine, writeEnvFile } from "./env-file.ts";

/**
 * Reads / merges scribe's transcription provider into
 * `<configDir>/scribe/config.json` and writes the corresponding API key (when
 * the chosen provider needs one) into `<configDir>/scribe/.env`.
 *
 * Both files are merged in place so we never clobber unrelated keys — auto-wire
 * already owns `auth.required_token` in the same config, and operators
 * sometimes hand-edit other top-level blocks.
 */

/**
 * Transcription providers scribe ships with today (per `parachute-scribe`
 * 0.x README). Source-of-truth is intentionally hand-maintained on the CLI
 * side: the install prompt needs a curated, ordered list with platform
 * caveats for each option, which scribe's runtime registry doesn't surface.
 *
 * Drift caught by the test that asserts the keys here match scribe's
 * `availableProviders().transcription`.
 */
export const SCRIBE_PROVIDERS = [
  {
    key: "parakeet-mlx",
    label: "parakeet-mlx",
    blurb: "local, Apple Silicon, fastest — requires `parakeet-mlx` binary on PATH",
    apiKeyEnv: undefined,
  },
  {
    key: "onnx-asr",
    label: "onnx-asr",
    blurb: "local, cross-platform (Sherpa-ONNX)",
    apiKeyEnv: undefined,
  },
  {
    key: "whisper",
    label: "whisper",
    blurb:
      "local, any platform — requires `whisper-ctranslate2` (`pip install whisper-ctranslate2`)",
    apiKeyEnv: undefined,
  },
  {
    key: "groq",
    label: "groq",
    blurb: "cloud, generous free tier, very fast",
    apiKeyEnv: "GROQ_API_KEY",
  },
  {
    key: "openai",
    label: "openai",
    blurb: "cloud, paid, reference Whisper API",
    apiKeyEnv: "OPENAI_API_KEY",
  },
] as const;

export type ScribeProviderKey = (typeof SCRIBE_PROVIDERS)[number]["key"];

/** Default provider scribe falls back to when the config doesn't pick one. */
export const SCRIBE_DEFAULT_PROVIDER: ScribeProviderKey = "parakeet-mlx";

export function isKnownScribeProvider(value: string): value is ScribeProviderKey {
  return SCRIBE_PROVIDERS.some((p) => p.key === value);
}

export function apiKeyEnvFor(provider: ScribeProviderKey): string | undefined {
  return SCRIBE_PROVIDERS.find((p) => p.key === provider)?.apiKeyEnv;
}

export function scribeConfigPath(configDir: string): string {
  return join(configDir, "scribe", "config.json");
}

export function scribeEnvPath(configDir: string): string {
  return join(configDir, "scribe", ".env");
}

export interface ScribeProviderState {
  provider: string | undefined;
  /** True when the file exists; false on a fresh install. */
  configExists: boolean;
}

export function readScribeProviderState(configDir: string): ScribeProviderState {
  const path = scribeConfigPath(configDir);
  if (!existsSync(path)) return { provider: undefined, configExists: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const provider =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.transcribe
        ? typeof parsed.transcribe.provider === "string"
          ? parsed.transcribe.provider
          : undefined
        : undefined;
    return { provider, configExists: true };
  } catch {
    // Malformed JSON — treat as empty so the writer can repair it. The auth
    // block belongs to auto-wire; if it's broken, downstream auto-wire will
    // overwrite when it next runs anyway.
    return { provider: undefined, configExists: true };
  }
}

/**
 * Merge `transcribe.provider = <provider>` into the scribe config.json,
 * preserving any other top-level keys (notably `auth.required_token` written
 * by auto-wire).
 */
export function writeScribeProvider(configDir: string, provider: ScribeProviderKey): void {
  const path = scribeConfigPath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed → overwrite, same convention as auto-wire's writeScribeConfig.
    }
  }
  const existingTranscribe =
    typeof current.transcribe === "object" &&
    current.transcribe !== null &&
    !Array.isArray(current.transcribe)
      ? (current.transcribe as Record<string, unknown>)
      : {};
  const next = {
    ...current,
    transcribe: { ...existingTranscribe, provider },
  };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Idempotent upsert of a single `KEY=value` into `<configDir>/scribe/.env`.
 * Used for the API-key prompt result. Other lines (auto-wire keys, manual
 * operator edits) are preserved.
 */
export function writeScribeApiKey(configDir: string, envKey: string, value: string): void {
  const path = scribeEnvPath(configDir);
  const parsed = parseEnvFile(path);
  const lines = upsertEnvLine(parsed.lines, envKey, value);
  writeEnvFile(path, lines);
}

import { createInterface } from "node:readline/promises";
import { type AliveFn, defaultAlive, processState } from "../process-state.ts";
import {
  SCRIBE_DEFAULT_PROVIDER,
  SCRIBE_PROVIDERS,
  type ScribeProviderKey,
  apiKeyEnvFor,
  isKnownScribeProvider,
  readScribeProviderState,
  writeScribeApiKey,
  writeScribeProvider,
} from "../scribe-config.ts";
import { restart as lifecycleRestart } from "./lifecycle.ts";

/**
 * Owns the post-install scribe setup: pick a transcription provider, capture
 * an API key when needed, persist both, and restart scribe if it's already
 * running so the new wiring takes effect immediately.
 *
 * Routing (in order):
 *   1. `preselectProvider` (the `--scribe-provider <name>` flag) — validate,
 *      use directly, no prompt.
 *   2. Existing config has a non-default provider → assume the user already
 *      chose; skip silently.
 *   3. Interactive TTY → numbered-list prompt, then API-key prompt for the
 *      cloud providers that need one.
 *   4. Anything else (non-TTY, no flag) → leave the file untouched. The CLI
 *      footer points at `scribe.config.json` so scripts that need a non-
 *      default provider can write it themselves.
 *
 * Errors don't fail the install: a flaky restart or a config write that loses
 * a race shouldn't undo a successful `bun add`. The user gets a clear log
 * line and can re-run by hand.
 */

export type InteractiveAvailability =
  | { kind: "available"; prompt: (q: string) => Promise<string> }
  | { kind: "not-tty" };

function defaultAvailability(): InteractiveAvailability {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return { kind: "not-tty" };
  return {
    kind: "available",
    prompt: async (question: string) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

export interface SetupScribeProviderOpts {
  configDir: string;
  log?: (line: string) => void;
  /**
   * Pre-chosen provider from `--scribe-provider <name>` (or programmatic
   * caller). Bypasses the picker entirely and the existing-config check —
   * passing the flag is itself an explicit choice.
   */
  preselectProvider?: string;
  /**
   * Pre-supplied API key from `--scribe-key <key>`. Only consulted for
   * providers that need one (groq / openai). Ignored for local providers.
   */
  preselectKey?: string;
  /**
   * Interactive availability + prompt seam. Tests inject `{ kind: "available",
   * prompt: ... }` to drive the picker without a real TTY; production lets the
   * default sense `process.stdin.isTTY`.
   */
  availability?: InteractiveAvailability;
  /** Restart-vault test seam, mirroring auto-wire's. */
  alive?: AliveFn;
  restartService?: (short: string) => Promise<number>;
}

export interface SetupScribeProviderResult {
  /** True when this call wrote a new provider into config.json. */
  configured: boolean;
  /** Provider value present in scribe's config.json after this call. */
  provider: string | undefined;
  /** True when this call wrote a new API key into scribe/.env. */
  wroteApiKey: boolean;
  /** True when scribe was running and this call issued a restart. */
  restartedScribe: boolean;
  /** When non-empty, why the prompt was skipped (for telemetry / tests). */
  skippedReason?: "preselected" | "already-configured" | "non-interactive";
}

export async function setupScribeProvider(
  opts: SetupScribeProviderOpts,
): Promise<SetupScribeProviderResult> {
  const log = opts.log ?? (() => {});
  const availability = opts.availability ?? defaultAvailability();
  const alive = opts.alive ?? defaultAlive;
  const restartService =
    opts.restartService ??
    ((short: string) => lifecycleRestart(short, { configDir: opts.configDir, log }));

  const initial = readScribeProviderState(opts.configDir);

  // 1. Flag-driven path: --scribe-provider wins outright.
  if (opts.preselectProvider) {
    if (!isKnownScribeProvider(opts.preselectProvider)) {
      log(
        `⚠ unknown --scribe-provider "${opts.preselectProvider}". Known: ${SCRIBE_PROVIDERS.map((p) => p.key).join(", ")}. Leaving config unchanged.`,
      );
      return {
        configured: false,
        provider: initial.provider,
        wroteApiKey: false,
        restartedScribe: false,
        skippedReason: "preselected",
      };
    }
    return await applyProviderChoice(opts.preselectProvider, opts.preselectKey, "preselected", {
      configDir: opts.configDir,
      log,
      alive,
      restartService,
    });
  }

  // 2. Detect-and-skip: a previous run (or the operator) has set a non-default
  //    provider. Leave it alone.
  if (initial.provider !== undefined && initial.provider !== SCRIBE_DEFAULT_PROVIDER) {
    log(
      `Scribe transcription provider already set to "${initial.provider}" — leaving as-is. Edit ${opts.configDir}/scribe/config.json to change.`,
    );
    return {
      configured: false,
      provider: initial.provider,
      wroteApiKey: false,
      restartedScribe: false,
      skippedReason: "already-configured",
    };
  }

  // 3. Non-interactive (no TTY, no flag): don't prompt, don't write. The
  //    install footer tells the user where to look later.
  if (availability.kind !== "available") {
    return {
      configured: false,
      provider: initial.provider,
      wroteApiKey: false,
      restartedScribe: false,
      skippedReason: "non-interactive",
    };
  }

  // 4. Prompt loop.
  const picked = await pickProvider(availability.prompt, log);
  if (!picked) {
    log(
      "No transcription provider chosen — leaving scribe at its built-in default (parakeet-mlx).",
    );
    return {
      configured: false,
      provider: initial.provider,
      wroteApiKey: false,
      restartedScribe: false,
    };
  }

  let apiKey: string | undefined;
  const envKey = apiKeyEnvFor(picked);
  if (envKey) {
    apiKey = (await availability.prompt(`Paste your ${envKey} (or blank to skip): `)).trim();
    if (apiKey === "") {
      log(
        `Skipped ${envKey} entry. Set it later via \`echo '${envKey}=<value>' >> ${opts.configDir}/scribe/.env\` then \`parachute restart scribe\`.`,
      );
      apiKey = undefined;
    }
  }

  return await applyProviderChoice(picked, apiKey, undefined, {
    configDir: opts.configDir,
    log,
    alive,
    restartService,
  });
}

interface ApplyDeps {
  configDir: string;
  log: (line: string) => void;
  alive: AliveFn;
  restartService: (short: string) => Promise<number>;
}

async function applyProviderChoice(
  provider: ScribeProviderKey,
  apiKey: string | undefined,
  skippedReason: SetupScribeProviderResult["skippedReason"],
  deps: ApplyDeps,
): Promise<SetupScribeProviderResult> {
  writeScribeProvider(deps.configDir, provider);
  let wroteApiKey = false;
  const envKey = apiKeyEnvFor(provider);
  if (envKey && apiKey && apiKey.length > 0) {
    writeScribeApiKey(deps.configDir, envKey, apiKey);
    wroteApiKey = true;
  }

  if (envKey && apiKey) {
    deps.log(
      `Set scribe transcription provider to "${provider}" and saved ${envKey} to ${deps.configDir}/scribe/.env.`,
    );
  } else if (envKey) {
    deps.log(
      `Set scribe transcription provider to "${provider}". Add ${envKey} to ${deps.configDir}/scribe/.env before transcribing.`,
    );
  } else {
    deps.log(`Set scribe transcription provider to "${provider}".`);
  }

  let restartedScribe = false;
  if (processState("scribe", deps.configDir, deps.alive).status === "running") {
    deps.log("Restarting scribe to pick up the new transcription provider…");
    const code = await deps.restartService("scribe");
    if (code === 0) {
      restartedScribe = true;
    } else {
      deps.log(
        "⚠ scribe restart failed. Run manually once the issue is resolved: parachute restart scribe",
      );
    }
  }

  const result: SetupScribeProviderResult = {
    configured: true,
    provider,
    wroteApiKey,
    restartedScribe,
  };
  if (skippedReason) result.skippedReason = skippedReason;
  return result;
}

async function pickProvider(
  prompt: (q: string) => Promise<string>,
  log: (line: string) => void,
): Promise<ScribeProviderKey | undefined> {
  log("");
  log("Which transcription provider would you like to use?");
  for (let i = 0; i < SCRIBE_PROVIDERS.length; i++) {
    const p = SCRIBE_PROVIDERS[i];
    if (!p) continue;
    log(`  [${i + 1}] ${p.label.padEnd(13)} ${p.blurb}`);
  }
  log(`  [s] skip — leave at default (${SCRIBE_DEFAULT_PROVIDER})`);

  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = (await prompt("> ")).trim().toLowerCase();
    if (raw === "" || raw === "s" || raw === "skip") return undefined;
    const asNumber = Number.parseInt(raw, 10);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= SCRIBE_PROVIDERS.length) {
      return SCRIBE_PROVIDERS[asNumber - 1]?.key;
    }
    if (isKnownScribeProvider(raw)) return raw;
    log(`Sorry — expected 1..${SCRIBE_PROVIDERS.length}, a name, or s (got "${raw}"). Try again.`);
  }
  log("Too many invalid entries; skipping.");
  return undefined;
}

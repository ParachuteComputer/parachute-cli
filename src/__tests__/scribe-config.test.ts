import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCRIBE_DEFAULT_PROVIDER,
  SCRIBE_PROVIDERS,
  apiKeyEnvFor,
  isKnownScribeProvider,
  readScribeProviderState,
  scribeConfigPath,
  scribeEnvPath,
  writeScribeApiKey,
  writeScribeProvider,
} from "../scribe-config.ts";

function makeHarness(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-scribecfg-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("provider catalog", () => {
  test("default provider is in the catalog", () => {
    expect(SCRIBE_PROVIDERS.some((p) => p.key === SCRIBE_DEFAULT_PROVIDER)).toBe(true);
  });

  test("isKnownScribeProvider matches every catalog key", () => {
    for (const p of SCRIBE_PROVIDERS) {
      expect(isKnownScribeProvider(p.key)).toBe(true);
    }
    expect(isKnownScribeProvider("not-a-provider")).toBe(false);
    expect(isKnownScribeProvider("cloudflare")).toBe(false);
  });

  test("apiKeyEnvFor maps cloud providers to env keys, locals to undefined", () => {
    expect(apiKeyEnvFor("groq")).toBe("GROQ_API_KEY");
    expect(apiKeyEnvFor("openai")).toBe("OPENAI_API_KEY");
    expect(apiKeyEnvFor("parakeet-mlx")).toBeUndefined();
    expect(apiKeyEnvFor("onnx-asr")).toBeUndefined();
    expect(apiKeyEnvFor("whisper")).toBeUndefined();
  });
});

describe("readScribeProviderState", () => {
  test("missing file: configExists false, no provider", () => {
    const h = makeHarness();
    try {
      const state = readScribeProviderState(h.dir);
      expect(state.configExists).toBe(false);
      expect(state.provider).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("file exists without transcribe block: configExists true, no provider", () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(scribeConfigPath(h.dir), JSON.stringify({ auth: { required_token: "x" } }));
      const state = readScribeProviderState(h.dir);
      expect(state.configExists).toBe(true);
      expect(state.provider).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("transcribe.provider set: returns it", () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(
        scribeConfigPath(h.dir),
        JSON.stringify({ transcribe: { provider: "groq" }, auth: { required_token: "x" } }),
      );
      const state = readScribeProviderState(h.dir);
      expect(state.provider).toBe("groq");
    } finally {
      h.cleanup();
    }
  });

  test("malformed JSON: configExists true, provider undefined (no throw)", () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(scribeConfigPath(h.dir), "{ not valid json");
      const state = readScribeProviderState(h.dir);
      expect(state.configExists).toBe(true);
      expect(state.provider).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("writeScribeProvider", () => {
  test("creates new config with transcribe.provider when none exists", () => {
    const h = makeHarness();
    try {
      writeScribeProvider(h.dir, "groq");
      const parsed = JSON.parse(readFileSync(scribeConfigPath(h.dir), "utf8"));
      expect(parsed).toEqual({ transcribe: { provider: "groq" } });
    } finally {
      h.cleanup();
    }
  });

  test("preserves auth.required_token written by auto-wire", () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(
        scribeConfigPath(h.dir),
        JSON.stringify({ auth: { required_token: "secret-token" } }),
      );
      writeScribeProvider(h.dir, "openai");
      const parsed = JSON.parse(readFileSync(scribeConfigPath(h.dir), "utf8"));
      expect(parsed.auth).toEqual({ required_token: "secret-token" });
      expect(parsed.transcribe).toEqual({ provider: "openai" });
    } finally {
      h.cleanup();
    }
  });

  test("merges into an existing transcribe block", () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(
        scribeConfigPath(h.dir),
        JSON.stringify({ transcribe: { provider: "parakeet-mlx", language: "en" } }),
      );
      writeScribeProvider(h.dir, "groq");
      const parsed = JSON.parse(readFileSync(scribeConfigPath(h.dir), "utf8"));
      expect(parsed.transcribe).toEqual({ provider: "groq", language: "en" });
    } finally {
      h.cleanup();
    }
  });

  test("overwrites malformed config (does not throw)", () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(scribeConfigPath(h.dir), "{ broken");
      writeScribeProvider(h.dir, "whisper");
      const parsed = JSON.parse(readFileSync(scribeConfigPath(h.dir), "utf8"));
      expect(parsed).toEqual({ transcribe: { provider: "whisper" } });
    } finally {
      h.cleanup();
    }
  });
});

describe("writeScribeApiKey", () => {
  test("creates scribe/.env with the key when missing", () => {
    const h = makeHarness();
    try {
      writeScribeApiKey(h.dir, "GROQ_API_KEY", "gsk_test_123");
      expect(readFileSync(scribeEnvPath(h.dir), "utf8")).toBe("GROQ_API_KEY=gsk_test_123\n");
    } finally {
      h.cleanup();
    }
  });

  test("upserts in place when the key is already present", () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(scribeEnvPath(h.dir), "OTHER=keep\nGROQ_API_KEY=old_value\nLAST=tail\n");
      writeScribeApiKey(h.dir, "GROQ_API_KEY", "new_value");
      const text = readFileSync(scribeEnvPath(h.dir), "utf8");
      expect(text).toBe("OTHER=keep\nGROQ_API_KEY=new_value\nLAST=tail\n");
    } finally {
      h.cleanup();
    }
  });

  test("preserves unrelated lines on first-time write", () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(scribeEnvPath(h.dir), "EXISTING=value\n");
      writeScribeApiKey(h.dir, "OPENAI_API_KEY", "sk-test");
      const text = readFileSync(scribeEnvPath(h.dir), "utf8");
      expect(text).toBe("EXISTING=value\nOPENAI_API_KEY=sk-test\n");
    } finally {
      h.cleanup();
    }
  });
});

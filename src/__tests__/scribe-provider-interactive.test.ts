import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InteractiveAvailability,
  setupScribeProvider,
} from "../commands/scribe-provider-interactive.ts";
import { writePid } from "../process-state.ts";
import { scribeConfigPath, scribeEnvPath } from "../scribe-config.ts";

function makeHarness(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-scribepick-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Stub {
  availability: InteractiveAvailability;
  asked: string[];
}

function scriptedAvailability(answers: string[]): Stub {
  const asked: string[] = [];
  let i = 0;
  return {
    asked,
    availability: {
      kind: "available",
      prompt: async (q: string) => {
        asked.push(q);
        const next = answers[i++];
        if (next === undefined) throw new Error(`prompt asked more than scripted (${q})`);
        return next;
      },
    },
  };
}

describe("setupScribeProvider — preselected flag path", () => {
  test("--scribe-provider groq + --scribe-key writes both files, no prompt", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const stub = scriptedAvailability([]);
      const result = await setupScribeProvider({
        configDir: h.dir,
        log: (l) => logs.push(l),
        preselectProvider: "groq",
        preselectKey: "gsk_abc123",
        availability: stub.availability,
        alive: () => false,
        restartService: async () => 0,
      });

      expect(result.configured).toBe(true);
      expect(result.provider).toBe("groq");
      expect(result.wroteApiKey).toBe(true);
      expect(result.skippedReason).toBe("preselected");
      expect(stub.asked).toEqual([]);

      const cfg = JSON.parse(readFileSync(scribeConfigPath(h.dir), "utf8"));
      expect(cfg.transcribe).toEqual({ provider: "groq" });
      expect(readFileSync(scribeEnvPath(h.dir), "utf8")).toContain("GROQ_API_KEY=gsk_abc123");
    } finally {
      h.cleanup();
    }
  });

  test("--scribe-provider with local provider does not write a key even if --scribe-key passed", async () => {
    const h = makeHarness();
    try {
      const result = await setupScribeProvider({
        configDir: h.dir,
        preselectProvider: "parakeet-mlx",
        preselectKey: "should-be-ignored",
        availability: { kind: "not-tty" },
        alive: () => false,
        restartService: async () => 0,
      });
      expect(result.configured).toBe(true);
      expect(result.wroteApiKey).toBe(false);
      expect(existsSync(scribeEnvPath(h.dir))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("unknown --scribe-provider logs a warning and leaves config alone", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const result = await setupScribeProvider({
        configDir: h.dir,
        log: (l) => logs.push(l),
        preselectProvider: "cloudflare",
        availability: { kind: "not-tty" },
        alive: () => false,
        restartService: async () => 0,
      });
      expect(result.configured).toBe(false);
      expect(result.skippedReason).toBe("preselected");
      expect(existsSync(scribeConfigPath(h.dir))).toBe(false);
      expect(logs.join("\n")).toMatch(/unknown --scribe-provider/);
    } finally {
      h.cleanup();
    }
  });
});

describe("setupScribeProvider — detect-skip", () => {
  test("config with non-default provider already set: leave alone", async () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(
        scribeConfigPath(h.dir),
        JSON.stringify({ transcribe: { provider: "openai" } }),
      );
      const logs: string[] = [];
      const stub = scriptedAvailability([]);
      const result = await setupScribeProvider({
        configDir: h.dir,
        log: (l) => logs.push(l),
        availability: stub.availability,
        alive: () => false,
        restartService: async () => 0,
      });
      expect(result.configured).toBe(false);
      expect(result.skippedReason).toBe("already-configured");
      expect(stub.asked).toEqual([]);
      expect(logs.join("\n")).toMatch(/already set to "openai"/);
    } finally {
      h.cleanup();
    }
  });

  test("config with default provider parakeet-mlx still re-prompts", async () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(
        scribeConfigPath(h.dir),
        JSON.stringify({ transcribe: { provider: "parakeet-mlx" } }),
      );
      const stub = scriptedAvailability(["s"]);
      const result = await setupScribeProvider({
        configDir: h.dir,
        availability: stub.availability,
        alive: () => false,
        restartService: async () => 0,
      });
      expect(result.skippedReason).toBeUndefined();
      // User skipped → nothing written.
      expect(result.configured).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

describe("setupScribeProvider — non-TTY", () => {
  test("no flag, no TTY: skips silently with non-interactive reason", async () => {
    const h = makeHarness();
    try {
      const result = await setupScribeProvider({
        configDir: h.dir,
        availability: { kind: "not-tty" },
        alive: () => false,
        restartService: async () => 0,
      });
      expect(result.configured).toBe(false);
      expect(result.skippedReason).toBe("non-interactive");
      expect(existsSync(scribeConfigPath(h.dir))).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

describe("setupScribeProvider — interactive prompt", () => {
  test("number selection chooses provider, then prompts for API key", async () => {
    const h = makeHarness();
    try {
      const stub = scriptedAvailability(["4", "gsk_picked"]);
      const result = await setupScribeProvider({
        configDir: h.dir,
        availability: stub.availability,
        alive: () => false,
        restartService: async () => 0,
      });
      expect(result.provider).toBe("groq");
      expect(result.wroteApiKey).toBe(true);
      expect(stub.asked.length).toBe(2);
      expect(stub.asked[1]).toMatch(/GROQ_API_KEY/);
    } finally {
      h.cleanup();
    }
  });

  test("name selection works (case-insensitive)", async () => {
    const h = makeHarness();
    try {
      const stub = scriptedAvailability(["OpenAI", "sk-x"]);
      const result = await setupScribeProvider({
        configDir: h.dir,
        availability: stub.availability,
        alive: () => false,
        restartService: async () => 0,
      });
      expect(result.provider).toBe("openai");
      expect(result.wroteApiKey).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("local provider chosen: no key prompt", async () => {
    const h = makeHarness();
    try {
      const stub = scriptedAvailability(["parakeet-mlx"]);
      const result = await setupScribeProvider({
        configDir: h.dir,
        availability: stub.availability,
        alive: () => false,
        restartService: async () => 0,
      });
      expect(result.provider).toBe("parakeet-mlx");
      expect(result.wroteApiKey).toBe(false);
      expect(stub.asked.length).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("'s' / skip / blank exits the picker without writing", async () => {
    const h = makeHarness();
    try {
      const stub = scriptedAvailability(["s"]);
      const result = await setupScribeProvider({
        configDir: h.dir,
        availability: stub.availability,
        alive: () => false,
        restartService: async () => 0,
      });
      expect(result.configured).toBe(false);
      expect(result.provider).toBeUndefined();
      expect(existsSync(scribeConfigPath(h.dir))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("retries on garbage then accepts a valid pick", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const stub = scriptedAvailability(["nope", "9999", "1"]);
      const result = await setupScribeProvider({
        configDir: h.dir,
        log: (l) => logs.push(l),
        availability: stub.availability,
        alive: () => false,
        restartService: async () => 0,
      });
      expect(result.provider).toBe("parakeet-mlx");
      expect(stub.asked.length).toBe(3);
      expect(logs.filter((l) => /Try again/.test(l)).length).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  test("blank API key answer logs hint and leaves env file untouched", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const stub = scriptedAvailability(["groq", ""]);
      const result = await setupScribeProvider({
        configDir: h.dir,
        log: (l) => logs.push(l),
        availability: stub.availability,
        alive: () => false,
        restartService: async () => 0,
      });
      expect(result.provider).toBe("groq");
      expect(result.wroteApiKey).toBe(false);
      expect(existsSync(scribeEnvPath(h.dir))).toBe(false);
      expect(logs.join("\n")).toMatch(/Skipped GROQ_API_KEY/);
    } finally {
      h.cleanup();
    }
  });
});

describe("setupScribeProvider — restart on running scribe", () => {
  test("running scribe → restart called", async () => {
    const h = makeHarness();
    try {
      writePid("scribe", 4321, h.dir);
      const restartCalls: string[] = [];
      const result = await setupScribeProvider({
        configDir: h.dir,
        preselectProvider: "groq",
        preselectKey: "gsk_x",
        availability: { kind: "not-tty" },
        alive: (pid) => pid === 4321,
        restartService: async (svc) => {
          restartCalls.push(svc);
          return 0;
        },
      });
      expect(result.restartedScribe).toBe(true);
      expect(restartCalls).toEqual(["scribe"]);
    } finally {
      h.cleanup();
    }
  });

  test("running scribe but restart fails: log warning, do not throw", async () => {
    const h = makeHarness();
    try {
      writePid("scribe", 4321, h.dir);
      const logs: string[] = [];
      const result = await setupScribeProvider({
        configDir: h.dir,
        log: (l) => logs.push(l),
        preselectProvider: "groq",
        preselectKey: "gsk_x",
        availability: { kind: "not-tty" },
        alive: (pid) => pid === 4321,
        restartService: async () => 1,
      });
      expect(result.restartedScribe).toBe(false);
      expect(logs.join("\n")).toMatch(/scribe restart failed/);
    } finally {
      h.cleanup();
    }
  });

  test("scribe not running: no restart attempt", async () => {
    const h = makeHarness();
    try {
      let called = false;
      const result = await setupScribeProvider({
        configDir: h.dir,
        preselectProvider: "groq",
        preselectKey: "gsk_x",
        availability: { kind: "not-tty" },
        alive: () => false,
        restartService: async () => {
          called = true;
          return 0;
        },
      });
      expect(result.restartedScribe).toBe(false);
      expect(called).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

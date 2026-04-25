import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIBE_AUTH_ENV_KEY, SCRIBE_URL_ENV_KEY, autoWireScribeAuth } from "../auto-wire.ts";
import { writePid } from "../process-state.ts";

function makeHarness(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-autowire-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const DEFAULT_SCRIBE_URL = "http://127.0.0.1:1943";

describe("autoWireScribeAuth", () => {
  test("first call: writes new token + SCRIBE_URL to vault .env and token to scribe config.json", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const result = await autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "deadbeef00".repeat(6),
        log: (l) => logs.push(l),
      });
      expect(result.generated).toBe(true);
      expect(result.token).toBe("deadbeef00".repeat(6));
      expect(result.scribeUrl).toBe(DEFAULT_SCRIBE_URL);

      const envText = readFileSync(join(h.dir, "vault", ".env"), "utf8");
      expect(envText).toContain(`${SCRIBE_AUTH_ENV_KEY}=${result.token}`);
      expect(envText).toContain(`${SCRIBE_URL_ENV_KEY}=${DEFAULT_SCRIBE_URL}`);

      const scribeCfg = JSON.parse(readFileSync(join(h.dir, "scribe", "config.json"), "utf8"));
      expect(scribeCfg).toEqual({ auth: { required_token: result.token } });

      expect(logs.join("\n")).toMatch(/Auto-wired shared secret \+ SCRIBE_URL/);
    } finally {
      h.cleanup();
    }
  });

  test("idempotent: pre-existing SCRIBE_AUTH_TOKEN in vault .env is preserved; SCRIBE_URL still wired", async () => {
    const h = makeHarness();
    try {
      // Seed a prior wire (or operator-set token). The helper must not
      // regenerate on repeat install — churning the token would break a
      // running vault worker that already has the old one in its process env.
      // SCRIBE_URL was missing from the prior write (this is a 0.2.4 → 0.2.5
      // upgrade scenario), so it should still be added.
      const envPath = join(h.dir, "vault", ".env");
      const seed = "seeded-token-abc123";
      mkdirSync(join(h.dir, "vault"), { recursive: true });
      writeFileSync(envPath, `FOO=bar\n${SCRIBE_AUTH_ENV_KEY}=${seed}\nOTHER=baz\n`);

      const result = await autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "should-not-be-used",
        log: () => {},
      });
      expect(result.generated).toBe(false);
      expect(result.token).toBe(seed);
      expect(result.scribeUrl).toBe(DEFAULT_SCRIBE_URL);

      const envText = readFileSync(envPath, "utf8");
      expect(envText).toContain("FOO=bar");
      expect(envText).toContain(`${SCRIBE_AUTH_ENV_KEY}=${seed}`);
      expect(envText).toContain("OTHER=baz");
      expect(envText).toContain(`${SCRIBE_URL_ENV_KEY}=${DEFAULT_SCRIBE_URL}`);
      // And scribe config.json gets the seeded value (so drift between the
      // two sides repairs on repeat install).
      const scribeCfg = JSON.parse(readFileSync(join(h.dir, "scribe", "config.json"), "utf8"));
      expect(scribeCfg.auth.required_token).toBe(seed);
    } finally {
      h.cleanup();
    }
  });

  test("preserves operator-set SCRIBE_URL (e.g., a non-loopback override)", async () => {
    const h = makeHarness();
    try {
      const envPath = join(h.dir, "vault", ".env");
      const customUrl = "http://scribe.lan:1943";
      mkdirSync(join(h.dir, "vault"), { recursive: true });
      writeFileSync(envPath, `${SCRIBE_URL_ENV_KEY}=${customUrl}\n`);

      const result = await autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "fresh-token",
        log: () => {},
      });
      expect(result.scribeUrl).toBe(customUrl);

      const envText = readFileSync(envPath, "utf8");
      expect(envText).toContain(`${SCRIBE_URL_ENV_KEY}=${customUrl}`);
      expect(envText).not.toContain(`${SCRIBE_URL_ENV_KEY}=${DEFAULT_SCRIBE_URL}`);
    } finally {
      h.cleanup();
    }
  });

  test("appends SCRIBE_AUTH_TOKEN without clobbering other vault .env keys", async () => {
    const h = makeHarness();
    try {
      const envPath = join(h.dir, "vault", ".env");
      mkdirSync(join(h.dir, "vault"), { recursive: true });
      writeFileSync(envPath, "VAULT_SECRET=xyz\nLOG_LEVEL=debug\n");

      await autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "fresh-token-123",
        log: () => {},
      });

      const envText = readFileSync(envPath, "utf8");
      expect(envText).toContain("VAULT_SECRET=xyz");
      expect(envText).toContain("LOG_LEVEL=debug");
      expect(envText).toContain(`${SCRIBE_AUTH_ENV_KEY}=fresh-token-123`);
      expect(envText).toContain(`${SCRIBE_URL_ENV_KEY}=${DEFAULT_SCRIBE_URL}`);
    } finally {
      h.cleanup();
    }
  });

  test("merges into existing scribe config.json, preserving other keys", async () => {
    const h = makeHarness();
    try {
      const scribeCfgPath = join(h.dir, "scribe", "config.json");
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(
        scribeCfgPath,
        JSON.stringify({ whisper: { model: "medium.en" }, auth: { other: "kept" } }, null, 2),
      );

      await autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "tok",
        log: () => {},
      });

      const cfg = JSON.parse(readFileSync(scribeCfgPath, "utf8"));
      expect(cfg.whisper.model).toBe("medium.en");
      expect(cfg.auth.other).toBe("kept");
      expect(cfg.auth.required_token).toBe("tok");
    } finally {
      h.cleanup();
    }
  });

  test("handles quoted token values in vault .env (preserves the raw value)", async () => {
    const h = makeHarness();
    try {
      const envPath = join(h.dir, "vault", ".env");
      mkdirSync(join(h.dir, "vault"), { recursive: true });
      writeFileSync(envPath, `${SCRIBE_AUTH_ENV_KEY}="quoted-value"\n`);

      const result = await autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "should-not-be-used",
        log: () => {},
      });
      expect(result.generated).toBe(false);
      expect(result.token).toBe("quoted-value");

      const cfg = JSON.parse(readFileSync(join(h.dir, "scribe", "config.json"), "utf8"));
      expect(cfg.auth.required_token).toBe("quoted-value");
    } finally {
      h.cleanup();
    }
  });

  test("creates vault/ and scribe/ dirs if missing", async () => {
    const h = makeHarness();
    try {
      expect(existsSync(join(h.dir, "vault"))).toBe(false);
      expect(existsSync(join(h.dir, "scribe"))).toBe(false);
      await autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "tok",
        log: () => {},
      });
      expect(existsSync(join(h.dir, "vault", ".env"))).toBe(true);
      expect(existsSync(join(h.dir, "scribe", "config.json"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("restarts vault when the worker is running so the new env takes effect", async () => {
    // The whole point of writing SCRIBE_URL is that vault's transcription
    // worker can find scribe. If vault is already running when we wire,
    // the worker keeps its stale env until we restart it — exactly the
    // launch-day footgun where voice memos sat on `_Transcript pending._`
    // forever. Mirrors the auto-restart-on-expose pattern from PR #39.
    const h = makeHarness();
    try {
      writePid("vault", 4242, h.dir);
      const restartCalls: string[] = [];
      const result = await autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "tok",
        log: () => {},
        alive: () => true,
        restartService: async (short) => {
          restartCalls.push(short);
          return 0;
        },
      });
      expect(result.restartedVault).toBe(true);
      expect(restartCalls).toEqual(["vault"]);
    } finally {
      h.cleanup();
    }
  });

  test("does not restart vault when nothing changed (idempotent repeat call)", async () => {
    // Both keys already present, vault running — there's nothing to pick up
    // on restart, so we shouldn't churn a healthy daemon.
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "vault"), { recursive: true });
      writeFileSync(
        join(h.dir, "vault", ".env"),
        `${SCRIBE_AUTH_ENV_KEY}=already\n${SCRIBE_URL_ENV_KEY}=${DEFAULT_SCRIBE_URL}\n`,
      );
      writePid("vault", 4242, h.dir);
      const restartCalls: string[] = [];
      const result = await autoWireScribeAuth({
        configDir: h.dir,
        log: () => {},
        alive: () => true,
        restartService: async (short) => {
          restartCalls.push(short);
          return 0;
        },
      });
      expect(result.restartedVault).toBe(false);
      expect(restartCalls).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("does not restart vault when it isn't running", async () => {
    // No PID file → processState reports "unknown" → no restart. Avoids
    // launching a daemon as a side effect of install.
    const h = makeHarness();
    try {
      const restartCalls: string[] = [];
      const result = await autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "tok",
        log: () => {},
        restartService: async (short) => {
          restartCalls.push(short);
          return 0;
        },
      });
      expect(result.restartedVault).toBe(false);
      expect(restartCalls).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("logs a clear hint when the auto-restart fails", async () => {
    const h = makeHarness();
    try {
      writePid("vault", 4242, h.dir);
      const logs: string[] = [];
      const result = await autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "tok",
        log: (l) => logs.push(l),
        alive: () => true,
        restartService: async () => 1,
      });
      expect(result.restartedVault).toBe(false);
      expect(logs.join("\n")).toMatch(/vault restart failed.*parachute restart vault/);
    } finally {
      h.cleanup();
    }
  });
});

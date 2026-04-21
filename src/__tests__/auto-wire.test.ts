import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIBE_AUTH_ENV_KEY, autoWireScribeAuth } from "../auto-wire.ts";

function makeHarness(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-autowire-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("autoWireScribeAuth", () => {
  test("first call: writes new token to both vault .env and scribe config.json", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const result = autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "deadbeef00".repeat(6),
        log: (l) => logs.push(l),
      });
      expect(result.generated).toBe(true);
      expect(result.token).toBe("deadbeef00".repeat(6));

      const envText = readFileSync(join(h.dir, "vault", ".env"), "utf8");
      expect(envText).toBe(`${SCRIBE_AUTH_ENV_KEY}=${result.token}\n`);

      const scribeCfg = JSON.parse(readFileSync(join(h.dir, "scribe", "config.json"), "utf8"));
      expect(scribeCfg).toEqual({ auth: { required_token: result.token } });

      expect(logs.join("\n")).toMatch(/Auto-wired shared secret for vault → scribe/);
    } finally {
      h.cleanup();
    }
  });

  test("idempotent: pre-existing SCRIBE_AUTH_TOKEN in vault .env is preserved", async () => {
    const h = makeHarness();
    try {
      // Seed a prior wire (or operator-set value). The helper must not
      // regenerate on repeat install — churning the token would break a
      // running vault worker that already has the old one in its process env.
      const envPath = join(h.dir, "vault", ".env");
      const seed = "seeded-token-abc123";
      mkdirSync(join(h.dir, "vault"), { recursive: true });
      writeFileSync(envPath, `FOO=bar\n${SCRIBE_AUTH_ENV_KEY}=${seed}\nOTHER=baz\n`);

      const result = autoWireScribeAuth({
        configDir: h.dir,
        // If randomToken is ever called, test would notice — result.token
        // would change, assertion fails.
        randomToken: () => "should-not-be-used",
        log: () => {},
      });
      expect(result.generated).toBe(false);
      expect(result.token).toBe(seed);

      // vault .env unchanged — other keys intact, token unchanged.
      const envText = readFileSync(envPath, "utf8");
      expect(envText).toContain("FOO=bar");
      expect(envText).toContain(`${SCRIBE_AUTH_ENV_KEY}=${seed}`);
      expect(envText).toContain("OTHER=baz");
      // And scribe config.json gets the seeded value (so drift between the
      // two sides repairs on repeat install).
      const scribeCfg = JSON.parse(readFileSync(join(h.dir, "scribe", "config.json"), "utf8"));
      expect(scribeCfg.auth.required_token).toBe(seed);
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

      autoWireScribeAuth({
        configDir: h.dir,
        randomToken: () => "fresh-token-123",
        log: () => {},
      });

      const envText = readFileSync(envPath, "utf8");
      expect(envText).toContain("VAULT_SECRET=xyz");
      expect(envText).toContain("LOG_LEVEL=debug");
      expect(envText).toContain(`${SCRIBE_AUTH_ENV_KEY}=fresh-token-123`);
    } finally {
      h.cleanup();
    }
  });

  test("merges into existing scribe config.json, preserving other keys", async () => {
    const h = makeHarness();
    try {
      // Simulate a scribe with its own config already on disk (e.g., user
      // set a whisper model) — auto-wire must add `auth.required_token`
      // without nuking the rest.
      const scribeCfgPath = join(h.dir, "scribe", "config.json");
      mkdirSync(join(h.dir, "scribe"), { recursive: true });
      writeFileSync(
        scribeCfgPath,
        JSON.stringify({ whisper: { model: "medium.en" }, auth: { other: "kept" } }, null, 2),
      );

      autoWireScribeAuth({
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
    // Operators sometimes quote .env values. Parse the quotes off so the
    // token we write to scribe config.json matches what vault actually reads.
    const h = makeHarness();
    try {
      const envPath = join(h.dir, "vault", ".env");
      mkdirSync(join(h.dir, "vault"), { recursive: true });
      writeFileSync(envPath, `${SCRIBE_AUTH_ENV_KEY}="quoted-value"\n`);

      const result = autoWireScribeAuth({
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
      // Fresh config dir — no per-service subdirs yet. Helper must create
      // them (matches how the rest of the CLI creates dirs on demand).
      expect(existsSync(join(h.dir, "vault"))).toBe(false);
      expect(existsSync(join(h.dir, "scribe"))).toBe(false);
      autoWireScribeAuth({
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
});

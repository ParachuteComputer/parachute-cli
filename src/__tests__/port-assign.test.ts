import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignPort, assignServicePort } from "../port-assign.ts";
import { CANONICAL_PORT_MAX, CANONICAL_PORT_MIN } from "../service-spec.ts";

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-port-assign-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("assignPort (pure)", () => {
  test("returns the canonical slot when free", () => {
    const result = assignPort(1940, []);
    expect(result.port).toBe(1940);
    expect(result.source).toBe("canonical");
    expect(result.warning).toBeUndefined();
  });

  test("returns canonical even when other unrelated ports are taken", () => {
    const result = assignPort(1940, [1939, 1942, 1943, 5173]);
    expect(result.port).toBe(1940);
    expect(result.source).toBe("canonical");
  });

  test("walks the unassigned reservation range when canonical is occupied", () => {
    // 1940 is taken; canonical reserved range starts at 1944 → first hit.
    const result = assignPort(1940, [1940]);
    expect(result.port).toBe(1944);
    expect(result.source).toBe("fallback-in-range");
    expect(result.warning).toMatch(/canonical port 1940 is in use/);
    expect(result.warning).toMatch(/1944/);
  });

  test("skips reservations that are also occupied", () => {
    // Canonical 1940 + the first three reserved slots are all in use.
    const result = assignPort(1940, [1940, 1944, 1945, 1946]);
    expect(result.port).toBe(1947);
    expect(result.source).toBe("fallback-in-range");
  });

  test("falls outside the range with a warning when reservations are exhausted", () => {
    const occupied = [];
    for (let p = CANONICAL_PORT_MIN; p <= CANONICAL_PORT_MAX; p++) occupied.push(p);
    const result = assignPort(1940, occupied);
    expect(result.port).toBe(CANONICAL_PORT_MAX + 1);
    expect(result.source).toBe("fallback-out-of-range");
    expect(result.warning).toMatch(/canonical range/);
    expect(result.warning).toMatch(/1950/);
    expect(result.warning).toMatch(/may conflict/);
  });

  test("walks past out-of-range collisions too", () => {
    const occupied = [];
    for (let p = CANONICAL_PORT_MIN; p <= CANONICAL_PORT_MAX + 2; p++) occupied.push(p);
    const result = assignPort(1940, occupied);
    expect(result.port).toBe(CANONICAL_PORT_MAX + 3);
    expect(result.source).toBe("fallback-out-of-range");
  });

  test("third-party (no canonical slot) jumps straight to the reservation range", () => {
    const result = assignPort(undefined, []);
    expect(result.port).toBe(1944);
    expect(result.source).toBe("fallback-in-range");
    expect(result.warning).toMatch(/no canonical slot/);
    expect(result.warning).toMatch(/1944/);
  });

  test("third-party with reservations occupied walks further in the range", () => {
    const result = assignPort(undefined, [1944, 1945]);
    expect(result.port).toBe(1946);
    expect(result.source).toBe("fallback-in-range");
  });
});

describe("assignServicePort (.env round-trip)", () => {
  test("preserves an existing PORT in .env (idempotent re-install)", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "PORT=1944\nOTHER=keepme\n");
      const result = assignServicePort({
        envPath,
        canonical: 1940,
        // Even though canonical is free, the existing .env wins.
        occupied: [],
      });
      expect(result.port).toBe(1944);
      expect(result.source).toBe("preserved");
      expect(result.written).toBe(false);
      // File untouched — no rewrite means OTHER stays as-is.
      const text = readFileSync(envPath, "utf8");
      expect(text).toContain("PORT=1944");
      expect(text).toContain("OTHER=keepme");
    } finally {
      cleanup();
    }
  });

  test("writes PORT into a fresh .env when canonical is free", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const envPath = join(dir, "subdir", ".env");
      const result = assignServicePort({
        envPath,
        canonical: 1940,
        occupied: [],
      });
      expect(result.port).toBe(1940);
      expect(result.source).toBe("canonical");
      expect(result.written).toBe(true);
      expect(result.warning).toBeUndefined();
      expect(existsSync(envPath)).toBe(true);
      expect(readFileSync(envPath, "utf8")).toContain("PORT=1940");
    } finally {
      cleanup();
    }
  });

  test("writes a fallback PORT and surfaces the warning when canonical is occupied", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const envPath = join(dir, ".env");
      const result = assignServicePort({
        envPath,
        canonical: 1940,
        occupied: [1940],
      });
      expect(result.port).toBe(1944);
      expect(result.source).toBe("fallback-in-range");
      expect(result.written).toBe(true);
      expect(result.warning).toMatch(/canonical port 1940 is in use/);
      expect(readFileSync(envPath, "utf8")).toContain("PORT=1944");
    } finally {
      cleanup();
    }
  });

  test("ignores a non-numeric PORT and assigns a fresh one", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "PORT=garbage\n");
      const result = assignServicePort({
        envPath,
        canonical: 1940,
        occupied: [],
      });
      expect(result.port).toBe(1940);
      expect(result.written).toBe(true);
      // The garbage value got upserted to a real number.
      expect(readFileSync(envPath, "utf8")).toContain("PORT=1940");
    } finally {
      cleanup();
    }
  });

  test("preserves surrounding lines on rewrite", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "FOO=bar\nBAZ=qux\n");
      const result = assignServicePort({
        envPath,
        canonical: 1940,
        occupied: [],
      });
      expect(result.written).toBe(true);
      const text = readFileSync(envPath, "utf8");
      expect(text).toContain("FOO=bar");
      expect(text).toContain("BAZ=qux");
      expect(text).toContain("PORT=1940");
    } finally {
      cleanup();
    }
  });
});

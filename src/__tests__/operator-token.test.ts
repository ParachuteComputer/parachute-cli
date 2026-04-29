import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import {
  OPERATOR_TOKEN_AUDIENCE,
  OPERATOR_TOKEN_FILENAME,
  OPERATOR_TOKEN_SCOPES,
  OPERATOR_TOKEN_TTL_SECONDS,
  issueOperatorToken,
  mintOperatorToken,
  operatorTokenPath,
  readOperatorTokenFile,
  writeOperatorTokenFile,
} from "../operator-token.ts";
import { rotateSigningKey } from "../signing-keys.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-operator-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const TEST_ISSUER = "http://127.0.0.1:1939";

describe("mintOperatorToken", () => {
  test("returns a JWT with operator audience, broad scopes, and ~1y TTL", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const minted = await mintOperatorToken(db, "user-abc", {
          issuer: TEST_ISSUER,
          now: () => new Date("2026-04-26T00:00:00Z"),
        });
        expect(minted.token.split(".")).toHaveLength(3);
        const validated = await validateAccessToken(db, minted.token, TEST_ISSUER);
        expect(validated.payload.sub).toBe("user-abc");
        expect(validated.payload.aud).toBe(OPERATOR_TOKEN_AUDIENCE);
        expect(validated.payload.iss).toBe(TEST_ISSUER);
        expect(validated.payload.scope).toBe(OPERATOR_TOKEN_SCOPES.join(" "));
        const exp = validated.payload.exp ?? 0;
        const iat = validated.payload.iat ?? 0;
        expect(exp - iat).toBe(OPERATOR_TOKEN_TTL_SECONDS);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("scopes include hub:admin + parachute:host:admin + vault:admin + scribe:admin + channel:send", () => {
    expect(OPERATOR_TOKEN_SCOPES).toEqual([
      "hub:admin",
      "parachute:host:admin",
      "vault:admin",
      "scribe:admin",
      "channel:send",
    ]);
  });
});

describe("writeOperatorTokenFile + readOperatorTokenFile", () => {
  test("writes mode 0600 and round-trips the plaintext", async () => {
    const h = makeHarness();
    try {
      const path = await writeOperatorTokenFile("plaintext-abc", h.dir);
      expect(path).toBe(join(h.dir, OPERATOR_TOKEN_FILENAME));
      const stat = statSync(path);
      // Mask off file-type bits; just compare permission bits.
      expect(stat.mode & 0o777).toBe(0o600);
      const round = await readOperatorTokenFile(h.dir);
      expect(round).toBe("plaintext-abc");
    } finally {
      h.cleanup();
    }
  });

  test("readOperatorTokenFile returns null when missing", async () => {
    const h = makeHarness();
    try {
      expect(await readOperatorTokenFile(h.dir)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("overwrite is atomic — second write replaces the first plaintext", async () => {
    const h = makeHarness();
    try {
      await writeOperatorTokenFile("first", h.dir);
      await writeOperatorTokenFile("second", h.dir);
      const round = await readOperatorTokenFile(h.dir);
      expect(round).toBe("second");
      // No leftover .tmp
      const tmp = `${operatorTokenPath(h.dir)}.tmp`;
      await readFile(tmp).then(
        () => expect.unreachable("tmp file should be renamed away"),
        (err: NodeJS.ErrnoException) => expect(err.code).toBe("ENOENT"),
      );
    } finally {
      h.cleanup();
    }
  });
});

describe("issueOperatorToken", () => {
  test("mints + writes the token to disk in one call", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const issued = await issueOperatorToken(db, "user-xyz", {
          dir: h.dir,
          issuer: TEST_ISSUER,
        });
        expect(issued.path).toBe(join(h.dir, OPERATOR_TOKEN_FILENAME));
        const fromDisk = await readOperatorTokenFile(h.dir);
        expect(fromDisk).toBe(issued.token);
        const validated = await validateAccessToken(db, issued.token, TEST_ISSUER);
        expect(validated.payload.sub).toBe("user-xyz");
        expect(validated.payload.iss).toBe(TEST_ISSUER);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

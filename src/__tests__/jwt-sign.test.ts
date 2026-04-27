import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  findRefreshToken,
  signAccessToken,
  signRefreshToken,
  validateAccessToken,
} from "../jwt-sign.ts";
import { getActiveSigningKey, rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

function makeDb() {
  const configDir = mkdtempSync(join(tmpdir(), "phub-jwt-"));
  const db = openHubDb(hubDbPath(configDir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

describe("signAccessToken", () => {
  test("issues an RS256 JWT keyed by the active signing key", async () => {
    const { db, cleanup } = makeDb();
    try {
      const active = getActiveSigningKey(db);
      const { token, jti, expiresAt } = await signAccessToken(db, {
        sub: "user-1",
        scopes: ["vault.read", "vault.write"],
        audience: "vault",
        clientId: "notes-pwa",
      });
      const header = decodeProtectedHeader(token);
      expect(header.alg).toBe("RS256");
      expect(header.kid).toBe(active.kid);
      const payload = decodeJwt(token);
      expect(payload.sub).toBe("user-1");
      expect(payload.aud).toBe("vault");
      expect(payload.scope).toBe("vault.read vault.write");
      expect(payload.client_id).toBe("notes-pwa");
      expect(payload.jti).toBe(jti);
      expect(typeof payload.exp).toBe("number");
      expect(typeof payload.iat).toBe("number");
      expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(ACCESS_TOKEN_TTL_SECONDS);
      // expiresAt round-trips to the JWT exp.
      expect(new Date(expiresAt).getTime() / 1000).toBeCloseTo(payload.exp ?? 0, -1);
    } finally {
      cleanup();
    }
  });

  test("does NOT write to the tokens table (pure)", async () => {
    const { db, cleanup } = makeDb();
    try {
      await signAccessToken(db, {
        sub: "user-1",
        scopes: ["vault.read"],
        audience: "vault",
        clientId: "c",
      });
      const count = (
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get() ?? {
          n: -1,
        }
      ).n;
      expect(count).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("signRefreshToken", () => {
  test("inserts a tokens row with the hash, returns the plaintext", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "pw");
      const { token, refreshTokenHash, expiresAt } = signRefreshToken(db, {
        jti: "jti-1",
        userId: u.id,
        clientId: "notes",
        scopes: ["vault.read"],
      });
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect(refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
      const row = db
        .query<
          {
            jti: string;
            user_id: string;
            client_id: string;
            scopes: string;
            refresh_token_hash: string;
            expires_at: string;
          },
          [string]
        >("SELECT * FROM tokens WHERE jti = ?")
        .get("jti-1");
      expect(row).not.toBeNull();
      expect(row?.user_id).toBe(u.id);
      expect(row?.client_id).toBe("notes");
      expect(row?.scopes).toBe("vault.read");
      expect(row?.refresh_token_hash).toBe(refreshTokenHash);
      expect(row?.expires_at).toBe(expiresAt);
    } finally {
      cleanup();
    }
  });

  test("expiresAt is 30 days from now (sliding TTL initial value)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "pw");
      const fixed = new Date("2026-04-26T00:00:00.000Z");
      const { expiresAt } = signRefreshToken(db, {
        jti: "j",
        userId: u.id,
        clientId: "c",
        scopes: [],
        now: () => fixed,
      });
      expect(new Date(expiresAt).getTime() - fixed.getTime()).toBe(REFRESH_TOKEN_TTL_MS);
    } finally {
      cleanup();
    }
  });
});

describe("findRefreshToken", () => {
  test("finds the row by hashing the plaintext", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "pw");
      const { token } = signRefreshToken(db, {
        jti: "jti-1",
        userId: u.id,
        clientId: "c",
        scopes: ["a", "b"],
      });
      const row = findRefreshToken(db, token);
      expect(row?.jti).toBe("jti-1");
      expect(row?.userId).toBe(u.id);
      expect(row?.scopes).toEqual(["a", "b"]);
      expect(row?.revokedAt).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("returns null for an unknown token", async () => {
    const { db, cleanup } = makeDb();
    try {
      expect(findRefreshToken(db, "not-a-real-token")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("validateAccessToken", () => {
  test("verifies a freshly-signed token", async () => {
    const { db, cleanup } = makeDb();
    try {
      const { token } = await signAccessToken(db, {
        sub: "u",
        scopes: ["s"],
        audience: "vault",
        clientId: "c",
      });
      const { payload, kid } = await validateAccessToken(db, token);
      expect(payload.sub).toBe("u");
      expect(kid.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("verifies a token signed by a recently-retired key (rotation tolerance)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const { token } = await signAccessToken(db, {
        sub: "u",
        scopes: [],
        audience: "vault",
        clientId: "c",
      });
      // Rotate — old key becomes retired but stays in JWKS for 24h.
      rotateSigningKey(db);
      const { payload } = await validateAccessToken(db, token);
      expect(payload.sub).toBe("u");
    } finally {
      cleanup();
    }
  });

  test("rejects a token whose kid no longer appears in JWKS", async () => {
    const { db, cleanup } = makeDb();
    try {
      const { token } = await signAccessToken(db, {
        sub: "u",
        scopes: [],
        audience: "vault",
        clientId: "c",
      });
      // Force the prior active key past 24h retention.
      const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      db.exec(`UPDATE signing_keys SET retired_at = '${past}' WHERE retired_at IS NULL`);
      // And rotate so there's a fresh active key, leaving the original
      // beyond JWKS retention.
      rotateSigningKey(db);
      await expect(validateAccessToken(db, token)).rejects.toThrow(/unknown or expired kid/);
    } finally {
      cleanup();
    }
  });

  test("rejects a token with no kid header", async () => {
    const { db, cleanup } = makeDb();
    try {
      // Hand-rolled JWT with no kid.
      const header = { alg: "RS256" };
      const payload = { sub: "u", iat: 1, exp: 9_999_999_999 };
      const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const fake = `${enc(header)}.${enc(payload)}.sig`;
      await expect(validateAccessToken(db, fake)).rejects.toThrow(/missing kid/);
    } finally {
      cleanup();
    }
  });
});

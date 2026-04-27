import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvalidRedirectUriError,
  getClient,
  isValidRedirectUri,
  registerClient,
  requireRegisteredRedirectUri,
  verifyClientSecret,
} from "../clients.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";

function makeDb() {
  const configDir = mkdtempSync(join(tmpdir(), "phub-clients-"));
  const db = openHubDb(hubDbPath(configDir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

describe("registerClient", () => {
  test("public client has no client_secret", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, {
        redirectUris: ["https://example.com/cb"],
        scopes: ["vault.read"],
        clientName: "test",
      });
      expect(r.clientSecret).toBeNull();
      expect(r.client.clientSecretHash).toBeNull();
      expect(r.client.clientId.length).toBeGreaterThan(0);
      expect(r.client.redirectUris).toEqual(["https://example.com/cb"]);
      expect(r.client.scopes).toEqual(["vault.read"]);
      expect(r.client.clientName).toBe("test");
    } finally {
      cleanup();
    }
  });

  test("confidential client returns plaintext secret once and stores hash", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, {
        redirectUris: ["https://example.com/cb"],
        confidential: true,
      });
      expect(r.clientSecret).not.toBeNull();
      expect(r.clientSecret?.length).toBeGreaterThan(20);
      // Hash is sha256 hex (64 chars).
      expect(r.client.clientSecretHash).toMatch(/^[0-9a-f]{64}$/);
      // The plaintext is not recoverable from the row.
      const fetched = getClient(db, r.client.clientId);
      expect(fetched?.clientSecretHash).toBe(r.client.clientSecretHash);
    } finally {
      cleanup();
    }
  });

  test("rejects empty redirect_uris", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(() => registerClient(db, { redirectUris: [] })).toThrow(/redirect_uri/);
    } finally {
      cleanup();
    }
  });

  test("rejects non-http(s) redirect_uri", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(() => registerClient(db, { redirectUris: ["javascript:alert(1)"] })).toThrow(
        /invalid redirect_uri/,
      );
      expect(() => registerClient(db, { redirectUris: ["/relative/path"] })).toThrow(
        /invalid redirect_uri/,
      );
    } finally {
      cleanup();
    }
  });
});

describe("getClient", () => {
  test("returns null for unknown clientId", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(getClient(db, "nope")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("round-trips a registered client", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, {
        redirectUris: ["https://a.example/cb", "https://b.example/cb"],
        scopes: ["vault.read", "vault.write"],
      });
      const fetched = getClient(db, r.client.clientId);
      expect(fetched?.redirectUris).toEqual(["https://a.example/cb", "https://b.example/cb"]);
      expect(fetched?.scopes).toEqual(["vault.read", "vault.write"]);
    } finally {
      cleanup();
    }
  });
});

describe("requireRegisteredRedirectUri", () => {
  test("returns the matched URI on exact match", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, { redirectUris: ["https://example.com/cb"] });
      expect(requireRegisteredRedirectUri(r.client, "https://example.com/cb")).toBe(
        "https://example.com/cb",
      );
    } finally {
      cleanup();
    }
  });

  test("throws on prefix-only / loose match (open-redirect guard)", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, { redirectUris: ["https://example.com/cb"] });
      expect(() => requireRegisteredRedirectUri(r.client, "https://example.com/cb/extra")).toThrow(
        InvalidRedirectUriError,
      );
      expect(() => requireRegisteredRedirectUri(r.client, "https://evil.com/cb")).toThrow(
        InvalidRedirectUriError,
      );
    } finally {
      cleanup();
    }
  });
});

describe("verifyClientSecret", () => {
  test("matches the issued secret, rejects others", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, {
        redirectUris: ["https://example.com/cb"],
        confidential: true,
      });
      expect(r.clientSecret).not.toBeNull();
      expect(verifyClientSecret(r.client, r.clientSecret ?? "")).toBe(true);
      expect(verifyClientSecret(r.client, "wrong")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("returns false for public clients regardless of presented secret", () => {
    const { db, cleanup } = makeDb();
    try {
      const r = registerClient(db, { redirectUris: ["https://example.com/cb"] });
      expect(verifyClientSecret(r.client, "anything")).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("isValidRedirectUri", () => {
  test("accepts http and https", () => {
    expect(isValidRedirectUri("http://localhost:3000/cb")).toBe(true);
    expect(isValidRedirectUri("https://example.com/cb")).toBe(true);
  });
  test("rejects javascript:, data:, relative paths, garbage", () => {
    expect(isValidRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isValidRedirectUri("data:text/html,x")).toBe(false);
    expect(isValidRedirectUri("/relative")).toBe(false);
    expect(isValidRedirectUri("not a url")).toBe(false);
  });
});

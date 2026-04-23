import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVaultAuthStatus } from "../vault/auth-status.ts";

function makeVaultHome(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "pcli-vault-auth-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

function writeConfig(vaultHome: string, body: string): void {
  writeFileSync(join(vaultHome, "config.yaml"), body);
}

function seedVault(vaultHome: string, name: string, opts: { withDb?: boolean } = {}): string {
  const dir = join(vaultHome, "data", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vault.yaml"), "# placeholder\n");
  const dbPath = join(dir, "vault.db");
  if (opts.withDb) writeFileSync(dbPath, ""); // exists but opaque to the fake counter
  return dbPath;
}

describe("readVaultAuthStatus — config.yaml parse", () => {
  test("missing config.yaml → hasOwnerPassword + hasTotp both false", () => {
    const env = makeVaultHome();
    try {
      const status = readVaultAuthStatus({ vaultHome: env.path, countTokens: () => 0 });
      expect(status.hasOwnerPassword).toBe(false);
      expect(status.hasTotp).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  test("both keys present and non-empty → both true", () => {
    const env = makeVaultHome();
    try {
      writeConfig(
        env.path,
        [
          "port: 1940",
          'owner_password_hash: "$2b$12$somehashhere"',
          'totp_secret: "JBSWY3DPEHPK3PXP"',
          "",
        ].join("\n"),
      );
      const status = readVaultAuthStatus({ vaultHome: env.path, countTokens: () => 0 });
      expect(status.hasOwnerPassword).toBe(true);
      expect(status.hasTotp).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("empty quoted values are treated as absent (matches vault's readGlobalConfig)", () => {
    const env = makeVaultHome();
    try {
      writeConfig(env.path, ['owner_password_hash: ""', 'totp_secret: ""', ""].join("\n"));
      const status = readVaultAuthStatus({ vaultHome: env.path, countTokens: () => 0 });
      expect(status.hasOwnerPassword).toBe(false);
      expect(status.hasTotp).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  test("only owner_password_hash present", () => {
    const env = makeVaultHome();
    try {
      writeConfig(env.path, 'owner_password_hash: "$2b$12$abc"\n');
      const status = readVaultAuthStatus({ vaultHome: env.path, countTokens: () => 0 });
      expect(status.hasOwnerPassword).toBe(true);
      expect(status.hasTotp).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});

describe("readVaultAuthStatus — vault discovery", () => {
  test("no data/ dir → vaultNames empty, tokenCount 0", () => {
    const env = makeVaultHome();
    try {
      const status = readVaultAuthStatus({ vaultHome: env.path, countTokens: () => 999 });
      expect(status.vaultNames).toEqual([]);
      expect(status.tokenCount).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  test("directories without vault.yaml are skipped", () => {
    const env = makeVaultHome();
    try {
      // "real" vault
      seedVault(env.path, "default", { withDb: true });
      // garbage dir that happens to sit under data/
      mkdirSync(join(env.path, "data", "stray"), { recursive: true });
      const status = readVaultAuthStatus({ vaultHome: env.path, countTokens: () => 0 });
      expect(status.vaultNames).toEqual(["default"]);
    } finally {
      env.cleanup();
    }
  });
});

describe("readVaultAuthStatus — token count resilience", () => {
  test("sums across multiple vaults", () => {
    const env = makeVaultHome();
    try {
      seedVault(env.path, "default", { withDb: true });
      seedVault(env.path, "work", { withDb: true });
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: (dbPath) => (dbPath.includes("/default/") ? 2 : 3),
      });
      expect(status.tokenCount).toBe(5);
      expect(new Set(status.vaultNames)).toEqual(new Set(["default", "work"]));
    } finally {
      env.cleanup();
    }
  });

  test("vault.yaml present but vault.db missing → count that vault as 0, keep going", () => {
    const env = makeVaultHome();
    try {
      seedVault(env.path, "default", { withDb: false });
      seedVault(env.path, "work", { withDb: true });
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: (dbPath) => {
          // Should only be called for the vault whose DB exists.
          if (dbPath.includes("/default/")) throw new Error("should not open missing DB");
          return 4;
        },
      });
      expect(status.tokenCount).toBe(4);
    } finally {
      env.cleanup();
    }
  });

  test("countTokens throws → tokenCount degrades to null (not partial)", () => {
    const env = makeVaultHome();
    try {
      seedVault(env.path, "default", { withDb: true });
      seedVault(env.path, "work", { withDb: true });
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: (dbPath) => {
          if (dbPath.includes("/work/")) throw new Error("locked");
          return 2;
        },
      });
      // Even though "default" succeeded with 2, we return null — callers
      // shouldn't see a misleading partial count.
      expect(status.tokenCount).toBeNull();
    } finally {
      env.cleanup();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceEntry } from "../services-manifest.ts";
import {
  buildWellKnown,
  isVaultEntry,
  shortName,
  vaultInstanceName,
  writeWellKnownFile,
} from "../well-known.ts";

const vault: ServiceEntry = {
  name: "parachute-vault",
  port: 1940,
  paths: ["/vault/default"],
  health: "/vault/default/health",
  version: "0.2.4",
};

const notes: ServiceEntry = {
  name: "parachute-notes",
  port: 5173,
  paths: ["/notes"],
  health: "/notes/health",
  version: "0.0.1",
};

const scribe: ServiceEntry = {
  name: "parachute-scribe",
  port: 3200,
  paths: ["/scribe"],
  health: "/scribe/health",
  version: "0.1.0",
};

describe("shortName", () => {
  test("strips parachute- prefix", () => {
    expect(shortName("parachute-vault")).toBe("vault");
    expect(shortName("parachute-notes")).toBe("notes");
    expect(shortName("custom-service")).toBe("custom-service");
  });
});

describe("isVaultEntry", () => {
  test("matches bare parachute-vault", () => {
    expect(isVaultEntry(vault)).toBe(true);
  });

  test("matches prefixed vault instances", () => {
    expect(isVaultEntry({ ...vault, name: "parachute-vault-work" })).toBe(true);
    expect(isVaultEntry({ ...vault, name: "parachute-vault-personal" })).toBe(true);
  });

  test("rejects non-vault services", () => {
    expect(isVaultEntry(notes)).toBe(false);
    expect(isVaultEntry(scribe)).toBe(false);
  });

  test("does not match an unrelated name that merely starts with parachute-vaultish", () => {
    expect(isVaultEntry({ ...vault, name: "parachute-vaultkeeper" })).toBe(false);
  });
});

describe("vaultInstanceName", () => {
  test("prefers /vault/<name> path segment", () => {
    expect(vaultInstanceName({ ...vault, paths: ["/vault/work"] })).toBe("work");
    expect(vaultInstanceName({ ...vault, paths: ["/vault/default"] })).toBe("default");
  });

  test("falls back to manifest-name suffix when path is non-vault", () => {
    expect(vaultInstanceName({ ...vault, name: "parachute-vault-personal", paths: ["/"] })).toBe(
      "personal",
    );
  });

  test("defaults to 'default' when nothing else matches", () => {
    expect(vaultInstanceName({ ...vault, paths: ["/"] })).toBe("default");
    expect(vaultInstanceName({ ...vault, paths: [] })).toBe("default");
  });

  test("path wins over name suffix", () => {
    expect(
      vaultInstanceName({
        ...vault,
        name: "parachute-vault-work",
        paths: ["/vault/override"],
      }),
    ).toBe("override");
  });
});

describe("buildWellKnown", () => {
  test("vaults is always an array, other services are flat entries", () => {
    const doc = buildWellKnown({
      services: [vault, notes, scribe],
      canonicalOrigin: "https://parachute.taildf9ce2.ts.net",
    });
    expect(doc).toEqual({
      vaults: [
        {
          name: "default",
          url: "https://parachute.taildf9ce2.ts.net/vault/default",
          version: "0.2.4",
        },
      ],
      notes: { url: "https://parachute.taildf9ce2.ts.net/notes", version: "0.0.1" },
      scribe: { url: "https://parachute.taildf9ce2.ts.net/scribe", version: "0.1.0" },
    });
  });

  test("vaults array is present even when no vault is installed", () => {
    const doc = buildWellKnown({
      services: [notes],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vaults).toEqual([]);
    expect(doc.notes).toEqual({ url: "https://x.example/notes", version: "0.0.1" });
  });

  test("multiple vault instances all land in the vaults array", () => {
    const work: ServiceEntry = {
      ...vault,
      name: "parachute-vault-work",
      paths: ["/vault/work"],
      port: 1941,
      version: "0.2.4",
    };
    const doc = buildWellKnown({
      services: [vault, work],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vaults).toHaveLength(2);
    expect(doc.vaults.map((v) => v.name).sort()).toEqual(["default", "work"]);
  });

  test("handles canonicalOrigin with trailing slash", () => {
    const doc = buildWellKnown({
      services: [vault],
      canonicalOrigin: "https://parachute.taildf9ce2.ts.net/",
    });
    expect(doc.vaults[0]?.url).toBe("https://parachute.taildf9ce2.ts.net/vault/default");
  });

  test("falls back to / for empty paths", () => {
    const entry: ServiceEntry = { ...vault, paths: [] };
    const doc = buildWellKnown({
      services: [entry],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vaults[0]?.url).toBe("https://x.example/");
  });
});

describe("writeWellKnownFile", () => {
  test("writes pretty JSON and creates nested directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-wk-"));
    try {
      const path = join(dir, "nested", "parachute.json");
      const doc = buildWellKnown({
        services: [vault],
        canonicalOrigin: "https://x.example",
      });
      writeWellKnownFile(doc, path);
      const round = JSON.parse(readFileSync(path, "utf8"));
      expect(round).toEqual(doc);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

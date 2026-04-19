import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceEntry } from "../services-manifest.ts";
import { buildWellKnown, shortName, writeWellKnownFile } from "../well-known.ts";

const vault: ServiceEntry = {
  name: "parachute-vault",
  port: 1940,
  paths: ["/"],
  health: "/health",
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

describe("well-known document", () => {
  test("shortName strips parachute- prefix", () => {
    expect(shortName("parachute-vault")).toBe("vault");
    expect(shortName("parachute-notes")).toBe("notes");
    expect(shortName("custom-service")).toBe("custom-service");
  });

  test("builds map keyed by short name with absolute URLs", () => {
    const doc = buildWellKnown({
      services: [vault, notes, scribe],
      canonicalOrigin: "https://parachute.taildf9ce2.ts.net",
    });
    expect(doc).toEqual({
      vault: { url: "https://parachute.taildf9ce2.ts.net/", version: "0.2.4" },
      notes: { url: "https://parachute.taildf9ce2.ts.net/notes", version: "0.0.1" },
      scribe: { url: "https://parachute.taildf9ce2.ts.net/scribe", version: "0.1.0" },
    });
  });

  test("handles canonicalOrigin with trailing slash", () => {
    const doc = buildWellKnown({
      services: [vault],
      canonicalOrigin: "https://parachute.taildf9ce2.ts.net/",
    });
    expect(doc.vault?.url).toBe("https://parachute.taildf9ce2.ts.net/");
  });

  test("falls back to / for empty paths", () => {
    const entry: ServiceEntry = { ...vault, paths: [] };
    const doc = buildWellKnown({
      services: [entry],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vault?.url).toBe("https://x.example/");
  });

  test("writeWellKnownFile writes pretty JSON and creates dir", () => {
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

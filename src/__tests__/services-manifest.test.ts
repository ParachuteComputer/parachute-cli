import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ServiceEntry,
  ServicesManifestError,
  findService,
  readManifest,
  removeService,
  upsertService,
  writeManifest,
} from "../services-manifest.ts";

function makeTempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-"));
  const path = join(dir, "services.json");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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

describe("services-manifest", () => {
  test("readManifest returns empty when file missing", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(readManifest(path)).toEqual({ services: [] });
    } finally {
      cleanup();
    }
  });

  test("writeManifest + readManifest round-trip", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeManifest({ services: [vault] }, path);
      expect(readManifest(path)).toEqual({ services: [vault] });
    } finally {
      cleanup();
    }
  });

  test("upsertService adds a new entry", () => {
    const { path, cleanup } = makeTempPath();
    try {
      const m = upsertService(vault, path);
      expect(m.services).toHaveLength(1);
      expect(m.services[0]).toEqual(vault);
      expect(readManifest(path)).toEqual(m);
    } finally {
      cleanup();
    }
  });

  test("upsertService updates by name, never duplicates", () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(vault, path);
      upsertService({ ...vault, version: "0.3.0", port: 1941 }, path);
      const m = readManifest(path);
      expect(m.services).toHaveLength(1);
      expect(m.services[0]?.version).toBe("0.3.0");
      expect(m.services[0]?.port).toBe(1941);
    } finally {
      cleanup();
    }
  });

  test("upsertService preserves other services", () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(vault, path);
      upsertService(notes, path);
      const m = readManifest(path);
      expect(m.services).toHaveLength(2);
      expect(m.services.map((s) => s.name).sort()).toEqual(["parachute-notes", "parachute-vault"]);
    } finally {
      cleanup();
    }
  });

  test("removeService drops entry by name", () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(vault, path);
      upsertService(notes, path);
      removeService("parachute-vault", path);
      const m = readManifest(path);
      expect(m.services).toHaveLength(1);
      expect(m.services[0]?.name).toBe("parachute-notes");
    } finally {
      cleanup();
    }
  });

  test("findService returns entry or undefined", () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(vault, path);
      expect(findService("parachute-vault", path)).toEqual(vault);
      expect(findService("parachute-none", path)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("readManifest throws on invalid JSON", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, "{ not json");
      expect(() => readManifest(path)).toThrow(ServicesManifestError);
    } finally {
      cleanup();
    }
  });

  test("readManifest throws on malformed entry", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, JSON.stringify({ services: [{ name: "x" }] }));
      expect(() => readManifest(path)).toThrow(/port/);
    } finally {
      cleanup();
    }
  });

  test("upsertService validates entry", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(() => upsertService({ ...vault, port: 99999 } as ServiceEntry, path)).toThrow(
        ServicesManifestError,
      );
    } finally {
      cleanup();
    }
  });

  test("round-trips optional displayName and tagline", () => {
    const { path, cleanup } = makeTempPath();
    try {
      const full: ServiceEntry = {
        ...vault,
        displayName: "Vault",
        tagline: "Your notes, sovereign",
      };
      upsertService(full, path);
      expect(readManifest(path).services[0]).toEqual(full);
    } finally {
      cleanup();
    }
  });

  test("rejects non-string displayName", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(() => upsertService({ ...vault, displayName: 42 as unknown as string }, path)).toThrow(
        /displayName/,
      );
    } finally {
      cleanup();
    }
  });
});

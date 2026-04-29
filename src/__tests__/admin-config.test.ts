import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPathFor,
  discoverConfigurableModules,
  readModuleConfig,
  validateAndCoerce,
  writeModuleConfig,
} from "../admin-config.ts";
import type { ConfigSchema, ModuleManifest } from "../module-manifest.ts";
import type { ServicesManifest } from "../services-manifest.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "admin-config-"));
}

const VAULT_SCHEMA: ConfigSchema = {
  type: "object",
  required: ["transcribe_provider"],
  properties: {
    transcribe_provider: {
      type: "string",
      description: "Speech-to-text backend.",
      enum: ["openai", "deepgram", "groq"],
      default: "openai",
    },
    max_tags_per_note: { type: "integer", default: 10 },
    public: { type: "boolean", default: false },
  },
};

const VAULT_MANIFEST: ModuleManifest = {
  name: "vault",
  manifestName: "parachute-vault",
  displayName: "Vault",
  kind: "api",
  port: 1940,
  paths: ["/vault"],
  health: "/health",
  configSchema: VAULT_SCHEMA,
};

const NOTES_MANIFEST: ModuleManifest = {
  name: "notes",
  manifestName: "parachute-notes",
  displayName: "Notes",
  kind: "frontend",
  port: 1941,
  paths: ["/"],
  health: "/health",
  // No configSchema — should be skipped.
};

function services(...entries: { name: string; installDir?: string }[]): ServicesManifest {
  return {
    services: entries.map((e) => ({
      name: e.name,
      port: 1940,
      paths: ["/"],
      health: "/health",
      version: "0.0.0",
      ...(e.installDir ? { installDir: e.installDir } : {}),
    })),
  };
}

describe("discoverConfigurableModules", () => {
  test("includes only modules with a configSchema", async () => {
    const dir = tmp();
    try {
      const result = await discoverConfigurableModules({
        loadServicesManifest: () =>
          services(
            { name: "vault", installDir: "/fake/vault" },
            { name: "notes", installDir: "/fake/notes" },
          ),
        configDir: dir,
        readManifest: async (installDir) => {
          if (installDir === "/fake/vault") return VAULT_MANIFEST;
          if (installDir === "/fake/notes") return NOTES_MANIFEST;
          return null;
        },
      });
      expect(result.map((m) => m.name)).toEqual(["vault"]);
      const first = result[0]!;
      expect(first.schema).toBe(VAULT_SCHEMA);
      expect(first.configPath).toBe(configPathFor(dir, "vault"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips entries without an installDir", async () => {
    const result = await discoverConfigurableModules({
      loadServicesManifest: () => services({ name: "vault" }),
      configDir: tmp(),
      readManifest: async () => VAULT_MANIFEST,
    });
    expect(result).toEqual([]);
  });

  test("skips entries whose manifest fails to read (returns null)", async () => {
    const result = await discoverConfigurableModules({
      loadServicesManifest: () => services({ name: "vault", installDir: "/missing" }),
      configDir: tmp(),
      readManifest: async () => null,
    });
    expect(result).toEqual([]);
  });

  test("doesn't take down the portal when one manifest throws", async () => {
    const result = await discoverConfigurableModules({
      loadServicesManifest: () =>
        services(
          { name: "vault", installDir: "/fake/vault" },
          { name: "rogue", installDir: "/fake/rogue" },
        ),
      configDir: tmp(),
      readManifest: async (installDir) => {
        if (installDir === "/fake/vault") return VAULT_MANIFEST;
        throw new Error("malformed module.json");
      },
    });
    expect(result.map((m) => m.name)).toEqual(["vault"]);
  });

  test("sorts results by displayName", async () => {
    const aManifest: ModuleManifest = { ...VAULT_MANIFEST, name: "alpha", displayName: "Alpha" };
    const zManifest: ModuleManifest = { ...VAULT_MANIFEST, name: "omega", displayName: "Omega" };
    const result = await discoverConfigurableModules({
      loadServicesManifest: () =>
        services({ name: "omega", installDir: "/o" }, { name: "alpha", installDir: "/a" }),
      configDir: tmp(),
      readManifest: async (d) => (d === "/o" ? zManifest : aManifest),
    });
    expect(result.map((m) => m.name)).toEqual(["alpha", "omega"]);
  });
});

describe("validateAndCoerce", () => {
  test("coerces strings, integers, numbers, booleans", () => {
    const r = validateAndCoerce(
      {
        transcribe_provider: "deepgram",
        max_tags_per_note: "42",
        public: true,
      },
      VAULT_SCHEMA,
    );
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({
      transcribe_provider: "deepgram",
      max_tags_per_note: 42,
      public: true,
    });
  });

  test("rejects an integer that is not an integer", () => {
    const r = validateAndCoerce(
      { transcribe_provider: "openai", max_tags_per_note: "3.14", public: false },
      VAULT_SCHEMA,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.max_tags_per_note).toBe("must be an integer");
  });

  test("rejects values outside the enum", () => {
    const r = validateAndCoerce(
      { transcribe_provider: "whisper", max_tags_per_note: "10", public: false },
      VAULT_SCHEMA,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.transcribe_provider).toContain("must be one of");
  });

  test("rejects required fields when missing", () => {
    const r = validateAndCoerce({ public: false }, VAULT_SCHEMA);
    expect(r.ok).toBe(false);
    expect(r.errors.transcribe_provider).toBe("required");
  });

  test("missing optional non-boolean fields are omitted from output", () => {
    const r = validateAndCoerce({ transcribe_provider: "openai", public: false }, VAULT_SCHEMA);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ transcribe_provider: "openai", public: false });
    expect("max_tags_per_note" in (r.data ?? {})).toBe(false);
  });

  test("missing booleans default to false rather than failing required", () => {
    const required: ConfigSchema = {
      type: "object",
      required: ["public"],
      properties: { public: { type: "boolean" } },
    };
    const r = validateAndCoerce({}, required);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ public: false });
  });

  test("number coercion accepts decimals", () => {
    const schema: ConfigSchema = {
      type: "object",
      properties: { ratio: { type: "number" } },
    };
    expect(validateAndCoerce({ ratio: "0.25" }, schema).data).toEqual({ ratio: 0.25 });
    expect(validateAndCoerce({ ratio: "garbage" }, schema).errors.ratio).toBe("must be a number");
  });

  test("string values pass through verbatim", () => {
    const schema: ConfigSchema = {
      type: "object",
      properties: { motto: { type: "string" } },
    };
    const r = validateAndCoerce({ motto: "  whitespace preserved  " }, schema);
    expect(r.data?.motto).toBe("  whitespace preserved  ");
  });
});

describe("readModuleConfig + writeModuleConfig", () => {
  test("returns {} when the file does not exist", () => {
    const dir = tmp();
    try {
      expect(readModuleConfig(join(dir, "missing.json"))).toEqual({ data: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trips a config object atomically", () => {
    const dir = tmp();
    try {
      const path = join(dir, "vault", "config.json");
      writeModuleConfig(path, { transcribe_provider: "openai", max_tags_per_note: 10 });
      expect(existsSync(path)).toBe(true);
      const { data, parseError } = readModuleConfig(path);
      expect(parseError).toBeUndefined();
      expect(data).toEqual({ transcribe_provider: "openai", max_tags_per_note: 10 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("surfaces a parse error without erroring", () => {
    const dir = tmp();
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, "{not valid json");
      const r = readModuleConfig(path);
      expect(r.data).toEqual({});
      expect(r.parseError).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("surfaces a parse error when the file is a JSON array, not object", () => {
    const dir = tmp();
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, "[]");
      const r = readModuleConfig(path);
      expect(r.data).toEqual({});
      expect(r.parseError).toContain("must contain a JSON object");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trailing newline preserved on write", () => {
    const dir = tmp();
    try {
      const path = join(dir, "config.json");
      writeModuleConfig(path, { x: 1 });
      expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CloudflaredState,
  CloudflaredStateError,
  clearCloudflaredState,
  readCloudflaredState,
  writeCloudflaredState,
} from "../cloudflare/state.ts";

function makeTempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-cfstate-"));
  return {
    path: join(dir, "cloudflared-state.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const sample: CloudflaredState = {
  version: 1,
  pid: 12345,
  tunnelUuid: "2c1a7c7e-1234-5678-9abc-def012345678",
  tunnelName: "parachute",
  hostname: "vault.example.com",
  startedAt: "2026-04-22T12:00:00.000Z",
  configPath: "/home/x/.parachute/cloudflared/config.yml",
};

describe("cloudflared state", () => {
  test("read returns undefined when the file doesn't exist", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(readCloudflaredState(path)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("write + read round-trip", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeCloudflaredState(sample, path);
      expect(readCloudflaredState(path)).toEqual(sample);
    } finally {
      cleanup();
    }
  });

  test("clear removes the file", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeCloudflaredState(sample, path);
      expect(existsSync(path)).toBe(true);
      clearCloudflaredState(path);
      expect(existsSync(path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("throws on unsupported version", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, JSON.stringify({ ...sample, version: 99 }));
      expect(() => readCloudflaredState(path)).toThrow(/unsupported version/);
    } finally {
      cleanup();
    }
  });

  test("throws on non-positive pid", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, JSON.stringify({ ...sample, pid: -1 }));
      expect(() => readCloudflaredState(path)).toThrow(CloudflaredStateError);
    } finally {
      cleanup();
    }
  });

  test("throws on malformed JSON", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, "{not json");
      expect(() => readCloudflaredState(path)).toThrow(/failed to parse/);
    } finally {
      cleanup();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderConfig, writeConfig } from "../cloudflare/config.ts";

describe("cloudflare config", () => {
  test("renderConfig produces a valid cloudflared YAML with one-hostname ingress + catch-all 404", () => {
    const yaml = renderConfig({
      tunnelUuid: "2c1a7c7e-1234-5678-9abc-def012345678",
      credentialsFile: "/Users/x/.cloudflared/2c1a7c7e-1234-5678-9abc-def012345678.json",
      hostname: "vault.example.com",
      servicePort: 1940,
    });
    expect(yaml).toContain("tunnel: 2c1a7c7e-1234-5678-9abc-def012345678");
    expect(yaml).toContain(
      'credentials-file: "/Users/x/.cloudflared/2c1a7c7e-1234-5678-9abc-def012345678.json"',
    );
    expect(yaml).toContain("- hostname: vault.example.com");
    expect(yaml).toContain("service: http://localhost:1940");
    expect(yaml).toContain("- service: http_status:404");
  });

  test("renderConfig double-quotes credentials-file so paths with spaces survive YAML parse", () => {
    const yaml = renderConfig({
      tunnelUuid: "uuid",
      credentialsFile: "/Users/John Doe/.cloudflared/uuid.json",
      hostname: "vault.example.com",
      servicePort: 1940,
    });
    expect(yaml).toContain('credentials-file: "/Users/John Doe/.cloudflared/uuid.json"');
  });

  test("writeConfig creates the parent directory and writes to the given path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-cfg-"));
    const path = join(dir, "nested", "subdir", "config.yml");
    try {
      writeConfig(
        {
          tunnelUuid: "uuid",
          credentialsFile: "/tmp/creds.json",
          hostname: "vault.example.com",
          servicePort: 1940,
        },
        path,
      );
      const contents = readFileSync(path, "utf8");
      expect(contents).toContain("tunnel: uuid");
      expect(contents).toContain("hostname: vault.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

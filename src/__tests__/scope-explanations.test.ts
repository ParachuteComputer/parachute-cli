import { describe, expect, test } from "bun:test";
import {
  FIRST_PARTY_SCOPES,
  SCOPE_EXPLANATIONS,
  explainScope,
  scopeIsAdmin,
} from "../scope-explanations.ts";

describe("SCOPE_EXPLANATIONS", () => {
  test("covers every canonical first-party scope from oauth-scopes.md", () => {
    // Source of truth: parachute-patterns/patterns/oauth-scopes.md.
    const expected = [
      "vault:read",
      "vault:write",
      "vault:admin",
      "scribe:transcribe",
      "scribe:admin",
      "channel:send",
      "hub:admin",
    ];
    for (const s of expected) {
      expect(SCOPE_EXPLANATIONS[s]).toBeDefined();
      expect(SCOPE_EXPLANATIONS[s]?.label.length).toBeGreaterThan(10);
    }
  });

  test("FIRST_PARTY_SCOPES is sorted and matches the keys of SCOPE_EXPLANATIONS", () => {
    expect(FIRST_PARTY_SCOPES).toEqual([...FIRST_PARTY_SCOPES].sort());
    expect(new Set(FIRST_PARTY_SCOPES)).toEqual(new Set(Object.keys(SCOPE_EXPLANATIONS)));
  });
});

describe("explainScope", () => {
  test("returns the entry for a known scope", () => {
    expect(explainScope("vault:read")?.level).toBe("read");
  });

  test("returns null for an unknown scope", () => {
    expect(explainScope("notes:weird-thing")).toBeNull();
  });
});

describe("scopeIsAdmin", () => {
  test("true for admin scopes", () => {
    expect(scopeIsAdmin("vault:admin")).toBe(true);
    expect(scopeIsAdmin("hub:admin")).toBe(true);
  });

  test("false for non-admin and unknown scopes", () => {
    expect(scopeIsAdmin("vault:read")).toBe(false);
    expect(scopeIsAdmin("channel:send")).toBe(false);
    expect(scopeIsAdmin("unknown:anything")).toBe(false);
  });
});

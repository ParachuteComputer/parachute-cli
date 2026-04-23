import { describe, expect, test } from "bun:test";
import { runAuthPreflight } from "../commands/expose-auth-preflight.ts";
import type { VaultAuthStatus } from "../vault/auth-status.ts";

interface Harness {
  logs: string[];
  prompts: string[];
  promptAnswers: string[];
  commands: string[][];
}

function makeHarness(answers: string[] = []): Harness {
  return { logs: [], prompts: [], promptAnswers: answers, commands: [] };
}

function wire(h: Harness) {
  let i = 0;
  return {
    log: (line: string) => h.logs.push(line),
    prompt: async (q: string) => {
      h.prompts.push(q);
      const answer = h.promptAnswers[i++];
      if (answer === undefined) throw new Error(`prompt exhausted at: ${q}`);
      return answer;
    },
    interactiveRunner: async (cmd: readonly string[]) => {
      h.commands.push([...cmd]);
      return 0;
    },
  };
}

function status(partial: Partial<VaultAuthStatus> = {}): VaultAuthStatus {
  return {
    hasOwnerPassword: false,
    hasTotp: false,
    tokenCount: 0,
    vaultNames: ["default"],
    ...partial,
  };
}

describe("runAuthPreflight — wide open (no password, no tokens)", () => {
  test("warns loudly and offers password, 2FA, and token creation", async () => {
    const h = makeHarness(["y", "n", "n"]); // password yes, 2fa no, token no
    await runAuthPreflight({ status: status(), ...wire(h) });
    const joined = h.logs.join("\n");
    expect(joined).toContain("No owner password and no API tokens");
    expect(joined).toContain("public internet");
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toEqual(["parachute", "auth", "set-password"]);
  });

  test("user declines every prompt → no subprocesses run", async () => {
    const h = makeHarness(["", "", ""]); // all Enter = skip
    await runAuthPreflight({ status: status(), ...wire(h) });
    expect(h.commands).toHaveLength(0);
    // Still prompted on all three lines, even though each was declined.
    expect(h.prompts).toHaveLength(3);
  });

  test("user accepts all three → all three commands invoked in order", async () => {
    const h = makeHarness(["y", "y", "y"]);
    await runAuthPreflight({ status: status(), ...wire(h) });
    expect(h.commands.map((c) => c.join(" "))).toEqual([
      "parachute auth set-password",
      "parachute auth 2fa enroll",
      "parachute vault tokens create",
    ]);
  });
});

describe("runAuthPreflight — password set, no 2FA", () => {
  test("short nudge, offers 2FA only", async () => {
    const h = makeHarness(["y"]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: true, tokenCount: 3 }),
      ...wire(h),
    });
    const joined = h.logs.join("\n");
    expect(joined).toContain("Owner password is set");
    expect(joined).toContain("2FA");
    expect(h.prompts).toHaveLength(1);
    expect(h.commands).toEqual([["parachute", "auth", "2fa", "enroll"]]);
  });

  test("user declines → no command runs", async () => {
    const h = makeHarness([""]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: true, tokenCount: 3 }),
      ...wire(h),
    });
    expect(h.commands).toHaveLength(0);
  });
});

describe("runAuthPreflight — tokens exist, no password", () => {
  test("notes that OAuth is not set up, offers password", async () => {
    const h = makeHarness(["y"]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: false, tokenCount: 2 }),
      ...wire(h),
    });
    const joined = h.logs.join("\n");
    expect(joined).toContain("API tokens exist");
    expect(joined).toContain("no owner password");
    expect(h.prompts).toHaveLength(1);
    expect(h.commands).toEqual([["parachute", "auth", "set-password"]]);
  });
});

describe("runAuthPreflight — unknown token count (SQLite failed)", () => {
  test("advises running `tokens list`, no token-dependent prompts", async () => {
    const h = makeHarness([]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: false, hasTotp: false, tokenCount: null }),
      ...wire(h),
    });
    const joined = h.logs.join("\n");
    expect(joined).toContain("Couldn't read vault token state");
    expect(joined).toContain("parachute vault tokens list");
    // No prompts because we don't offer password/token flow when token
    // state is unknown (it'd be ambiguous whether we're dealing with the
    // wide-open or the tokens-only case).
    expect(h.prompts).toHaveLength(0);
  });

  test("password set + 2FA absent + tokens unknown → still offers 2FA", async () => {
    const h = makeHarness([""]); // decline 2FA
    await runAuthPreflight({
      status: status({ hasOwnerPassword: true, hasTotp: false, tokenCount: null }),
      ...wire(h),
    });
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.toLowerCase()).toContain("2fa");
  });
});

describe("runAuthPreflight — all good", () => {
  test("single positive line, no prompts", async () => {
    const h = makeHarness([]);
    await runAuthPreflight({
      status: status({ hasOwnerPassword: true, hasTotp: true, tokenCount: 1 }),
      ...wire(h),
    });
    const joined = h.logs.join("\n");
    expect(joined).toContain("looks good");
    expect(h.prompts).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
  });
});

describe("runAuthPreflight — subprocess failure handling", () => {
  test("non-zero exit from auth command doesn't abort the rest of the preflight", async () => {
    const h = makeHarness(["y", "y", "y"]);
    // Override the interactive runner to return non-zero on the first call.
    let first = true;
    const interactiveRunner = async (cmd: readonly string[]) => {
      h.commands.push([...cmd]);
      if (first) {
        first = false;
        return 7;
      }
      return 0;
    };
    await runAuthPreflight({
      status: status(),
      log: (l) => h.logs.push(l),
      prompt: async (q) => {
        h.prompts.push(q);
        return h.promptAnswers.shift() ?? "";
      },
      interactiveRunner,
    });
    // All three commands still attempted, none aborted the flow.
    expect(h.commands.map((c) => c[0])).toEqual(["parachute", "parachute", "parachute"]);
    const joined = h.logs.join("\n");
    expect(joined).toContain("exited 7");
  });
});

describe("runAuthPreflight — case-insensitive yes", () => {
  test('"Y", "YES", and "y" all count as affirmative; anything else is decline', async () => {
    for (const yes of ["y", "Y", "yes", "YES"]) {
      const h = makeHarness([yes]);
      await runAuthPreflight({
        status: status({ hasOwnerPassword: true, tokenCount: 1 }),
        ...wire(h),
      });
      expect(h.commands).toHaveLength(1);
    }
    for (const no of ["", "n", "no", "q", "bogus"]) {
      const h = makeHarness([no]);
      await runAuthPreflight({
        status: status({ hasOwnerPassword: true, tokenCount: 1 }),
        ...wire(h),
      });
      expect(h.commands).toHaveLength(0);
    }
  });
});

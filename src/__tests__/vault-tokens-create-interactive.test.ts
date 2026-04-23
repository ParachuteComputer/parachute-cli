import { describe, expect, test } from "bun:test";
import { runVaultTokensCreateInteractive } from "../commands/vault-tokens-create-interactive.ts";

interface Harness {
  logs: string[];
  prompts: string[];
  promptAnswers: string[];
  commands: string[][];
  exitCode: number;
}

function makeHarness(
  answers: string[],
  opts: { exitCode?: number } = {},
): {
  harness: Harness;
  wire: {
    log: (l: string) => void;
    prompt: (q: string) => Promise<string>;
    interactiveRunner: (cmd: readonly string[]) => Promise<number>;
  };
} {
  const harness: Harness = {
    logs: [],
    prompts: [],
    promptAnswers: [...answers],
    commands: [],
    exitCode: opts.exitCode ?? 0,
  };
  let i = 0;
  return {
    harness,
    wire: {
      log: (line) => harness.logs.push(line),
      prompt: async (q) => {
        harness.prompts.push(q);
        const a = harness.promptAnswers[i++];
        if (a === undefined) throw new Error(`prompt exhausted at: ${q}`);
        return a;
      },
      interactiveRunner: async (cmd) => {
        harness.commands.push([...cmd]);
        return harness.exitCode;
      },
    },
  };
}

describe("runVaultTokensCreateInteractive — scope picker", () => {
  test("Enter defaults to read (safer choice)", async () => {
    const { harness, wire } = makeHarness(["", ""]); // scope=default, label=skip
    const code = await runVaultTokensCreateInteractive({ args: [], ...wire });
    expect(code).toBe(0);
    expect(harness.commands).toHaveLength(1);
    const cmd = harness.commands[0]!;
    expect(cmd).toEqual(["parachute-vault", "tokens", "create", "--read"]);
  });

  test("'1' also selects read", async () => {
    const { harness, wire } = makeHarness(["1", ""]);
    await runVaultTokensCreateInteractive({ args: [], ...wire });
    expect(harness.commands[0]).toContain("--read");
  });

  test("'2' selects write (vault:write scope)", async () => {
    const { harness, wire } = makeHarness(["2", ""]);
    await runVaultTokensCreateInteractive({ args: [], ...wire });
    const cmd = harness.commands[0]!;
    expect(cmd).toEqual(["parachute-vault", "tokens", "create", "--scope", "vault:write"]);
  });

  test("'3' selects admin (vault:admin scope)", async () => {
    const { harness, wire } = makeHarness(["3", ""]);
    await runVaultTokensCreateInteractive({ args: [], ...wire });
    const cmd = harness.commands[0]!;
    expect(cmd).toEqual(["parachute-vault", "tokens", "create", "--scope", "vault:admin"]);
  });

  test("'4' cancels with exit 0 and no subprocess", async () => {
    const { harness, wire } = makeHarness(["4"]);
    const code = await runVaultTokensCreateInteractive({ args: [], ...wire });
    expect(code).toBe(0);
    expect(harness.commands).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain("Cancelled");
  });

  test("'q' also cancels", async () => {
    const { harness, wire } = makeHarness(["q"]);
    const code = await runVaultTokensCreateInteractive({ args: [], ...wire });
    expect(code).toBe(0);
    expect(harness.commands).toHaveLength(0);
  });

  test("word aliases accepted case-insensitively", async () => {
    for (const [answer, expected] of [
      ["READ", "--read"],
      ["Write", "vault:write"],
      ["admin", "vault:admin"],
    ] as const) {
      const { harness, wire } = makeHarness([answer, ""]);
      await runVaultTokensCreateInteractive({ args: [], ...wire });
      expect(harness.commands[0]!.join(" ")).toContain(expected);
    }
  });

  test("garbage input reprompts, keeping the scope picker tight", async () => {
    const { harness, wire } = makeHarness(["bogus", "5", "2", ""]);
    await runVaultTokensCreateInteractive({ args: [], ...wire });
    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toContain("vault:write");
    // Three scope prompts were asked (bogus, 5, then the valid 2); one label.
    expect(harness.prompts.filter((p) => p.startsWith("Choice"))).toHaveLength(3);
  });
});

describe("runVaultTokensCreateInteractive — label prompt", () => {
  test("blank label = no --label flag forwarded", async () => {
    const { harness, wire } = makeHarness(["1", ""]);
    await runVaultTokensCreateInteractive({ args: [], ...wire });
    expect(harness.commands[0]!.includes("--label")).toBe(false);
  });

  test("non-blank label is appended verbatim", async () => {
    const { harness, wire } = makeHarness(["1", "n8n-sync"]);
    await runVaultTokensCreateInteractive({ args: [], ...wire });
    const cmd = harness.commands[0]!;
    expect(cmd).toContain("--label");
    expect(cmd[cmd.indexOf("--label") + 1]).toBe("n8n-sync");
  });

  test("label with spaces is passed as a single arg (not re-split)", async () => {
    const { harness, wire } = makeHarness(["1", "pendant prototype"]);
    await runVaultTokensCreateInteractive({ args: [], ...wire });
    const cmd = harness.commands[0]!;
    expect(cmd[cmd.indexOf("--label") + 1]).toBe("pendant prototype");
  });

  test("pre-supplied --label skips the label prompt entirely", async () => {
    const { harness, wire } = makeHarness(["1"]); // ONLY the scope prompt
    await runVaultTokensCreateInteractive({
      args: ["--label", "existing"],
      ...wire,
    });
    // Prompts only include the scope picker, not a label prompt.
    expect(harness.prompts.some((p) => p.toLowerCase().includes("label"))).toBe(false);
    // The user-supplied --label stays in place; we didn't double-append.
    const cmd = harness.commands[0]!;
    const labelIdxs: number[] = [];
    cmd.forEach((a, idx) => {
      if (a === "--label") labelIdxs.push(idx);
    });
    expect(labelIdxs).toHaveLength(1);
    expect(cmd[labelIdxs[0]! + 1]).toBe("existing");
  });
});

describe("runVaultTokensCreateInteractive — passthrough of pre-supplied args", () => {
  test("--vault / --expires forwarded verbatim, scope appended", async () => {
    const { harness, wire } = makeHarness(["1", ""]);
    await runVaultTokensCreateInteractive({
      args: ["--vault", "work", "--expires", "30d"],
      ...wire,
    });
    const cmd = harness.commands[0]!;
    // Original argv stays in order, scope flag appended after.
    expect(cmd).toEqual([
      "parachute-vault",
      "tokens",
      "create",
      "--vault",
      "work",
      "--expires",
      "30d",
      "--read",
    ]);
  });

  test("subprocess exit code is returned to the caller", async () => {
    const { wire } = makeHarness(["1", ""], { exitCode: 5 });
    const code = await runVaultTokensCreateInteractive({ args: [], ...wire });
    expect(code).toBe(5);
  });
});

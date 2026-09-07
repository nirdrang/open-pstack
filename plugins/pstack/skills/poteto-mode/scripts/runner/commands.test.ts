import { describe, expect, it } from "bun:test";
import {
  invocationCommand,
  preflightCommand,
  verificationCommand,
} from "./commands.ts";
import type { RunnerOptions } from "./types.ts";

function options(overrides: Partial<RunnerOptions> = {}): RunnerOptions {
  return {
    parent: "claude",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "max",
    mode: "read-only",
    promptPath: "/tmp/prompt.md",
    cwd: "/tmp/worktree",
    outputPath: "/tmp/output.md",
    receiptPath: "/tmp/receipt.json",
    timeoutMs: null,
    ...overrides,
  };
}

describe("invocationCommand", () => {
  it("pins Codex model, effort, sandbox, cwd, and JSONL output", () => {
    const spec = invocationCommand(options());
    expect(spec.command).toBe("codex");
    expect(spec.stdin).toBe("prompt");
    expect(spec.args).toEqual([
      "exec",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="max"',
      "--sandbox",
      "read-only",
      "--cd",
      "/tmp/worktree",
      "--skip-git-repo-check",
      "--ephemeral",
      "--disable",
      "plugins",
      "--disable",
      "multi_agent",
      "--disable",
      "hooks",
      "--disable",
      "memories",
      "--json",
      "-",
    ]);
    expect(spec.args).not.toContain("danger-full-access");
  });

  it("passes Claude model, effort, permissions, and no-recursion controls", () => {
    const spec = invocationCommand(
      options({
        parent: "codex",
        provider: "claude",
        model: "fable",
      })
    );
    expect(spec.command).toBe("claude");
    expect(spec.stdin).toBe("prompt");
    expect(spec.args).toEqual([
      "-p",
      "--model",
      "fable",
      "--effort",
      "max",
      "--permission-mode",
      "plan",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--tools",
      "Read,Grep,Glob,Bash",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--disallowed-tools",
      "Agent,Task,WebSearch,WebFetch,Edit,Write,NotebookEdit",
      "--output-format",
      "json",
    ]);
    expect(spec.args).not.toContain("bypassPermissions");
  });

  it("limits Grok to the assigned cwd and disables recursive agents", () => {
    const spec = invocationCommand(
      options({ provider: "grok", model: "grok-4.6", effort: "xhigh" })
    );
    expect(spec.command).toBe("grok");
    expect(spec.stdin).toBe("none");
    expect(spec.args).toEqual([
      "--prompt-file",
      "/tmp/prompt.md",
      "--model",
      "grok-4.6",
      "--reasoning-effort",
      "xhigh",
      "--permission-mode",
      "plan",
      "--sandbox",
      "read-only",
      "--tools",
      "read_file,grep,list_dir,run_terminal_cmd",
      "--disallowed-tools",
      "Agent,search_tool,use_tool",
      "--output-format",
      "streaming-messages-json",
      "--cwd",
      "/tmp/worktree",
      "--no-subagents",
      "--disable-web-search",
      "--verbatim",
    ]);
  });

  it("bounds opencode through an injected agent and pins model and variant", () => {
    const spec = invocationCommand(
      options({ provider: "opencode", model: "opencode-go/kimi-k3" })
    );
    expect(spec.command).toBe("opencode");
    expect(spec.stdin).toBe("prompt");
    expect(spec.args).toEqual([
      "run",
      "--pure",
      "--format",
      "json",
      "--model",
      "opencode-go/kimi-k3",
      "--variant",
      "max",
      "--agent",
      "pstack-read-only",
      "--dir",
      "/tmp/worktree",
    ]);
    expect(spec.args).not.toContain("--auto");
    const config = JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(config.agent["pstack-read-only"].permission).toMatchObject({
      edit: "deny",
      bash: "deny",
      task: "deny",
      webfetch: "deny",
      websearch: "deny",
      todowrite: "deny",
      external_directory: "deny",
    });

    const writer = invocationCommand(
      options({ provider: "opencode", model: "opencode-go/kimi-k3", mode: "isolated-write" })
    );
    expect(writer.args).toEqual(
      expect.arrayContaining(["--agent", "pstack-isolated-write"])
    );
    const writerConfig = JSON.parse(writer.env?.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(writerConfig.agent["pstack-isolated-write"].permission).toMatchObject({
      edit: "allow",
      bash: "allow",
      task: "deny",
      webfetch: "deny",
    });
  });

  it("preflights opencode against its provider listing and verifies through export", () => {
    expect(preflightCommand("opencode", "opencode-go/kimi-k3")).toEqual({
      command: "opencode",
      args: ["models", "opencode-go", "--verbose"],
      stdin: "none",
    });
    expect(verificationCommand("opencode", "ses_1")).toEqual({
      command: "opencode",
      args: ["export", "ses_1"],
      stdin: "none",
    });
    for (const provider of ["claude", "codex", "grok"] as const) {
      expect(verificationCommand(provider, "ses_1")).toBeNull();
    }
  });

  it("uses bounded write modes without blanket bypasses", () => {
    const codex = invocationCommand(options({ mode: "isolated-write" }));
    expect(codex.args).toEqual(
      expect.arrayContaining(["--sandbox", "workspace-write"])
    );
    const grok = invocationCommand(
      options({ provider: "grok", model: "grok-4.6", mode: "isolated-write" })
    );
    expect(grok.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "acceptEdits",
        "--sandbox",
        "workspace",
        "--tools",
        "read_file,grep,list_dir,run_terminal_cmd,search_replace",
      ])
    );
    expect(grok.args).not.toContain("--always-approve");

    const claude = invocationCommand(
      options({ provider: "claude", model: "fable", mode: "isolated-write" })
    );
    expect(claude.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "acceptEdits",
        "--tools",
        "Read,Write,Edit,Grep,Glob,Bash",
      ])
    );
  });

  it("covers low, medium, and high for every external provider", () => {
    const cases = [
      {
        provider: "claude" as const,
        model: "fable",
        flag: (effort: "low" | "medium" | "high") => ["--effort", effort],
      },
      {
        provider: "codex" as const,
        model: "gpt-5.6-sol",
        flag: (effort: "low" | "medium" | "high") => [
          "--config",
          `model_reasoning_effort="${effort}"`,
        ],
      },
      {
        provider: "grok" as const,
        model: "grok-4.6",
        flag: (effort: "low" | "medium" | "high") => [
          "--reasoning-effort",
          effort,
        ],
      },
      {
        provider: "opencode" as const,
        model: "opencode-go/gpt-5.6-luna",
        flag: (effort: "low" | "medium" | "high") => ["--variant", effort],
      },
    ];
    for (const { provider, model, flag } of cases) {
      for (const effort of ["low", "medium", "high"] as const) {
        const spec = invocationCommand(options({ provider, model, effort }));
        expect(spec.args).toEqual(expect.arrayContaining(flag(effort)));
      }
    }
  });
});

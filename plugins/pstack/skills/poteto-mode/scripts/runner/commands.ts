import type {
  AccessMode,
  Effort,
  Provider,
  RunnerOptions,
} from "./types.ts";

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: "prompt" | "none";
  readonly env?: Readonly<Record<string, string>>;
}

export function opencodeProviderId(model: string): string {
  return model.slice(0, model.indexOf("/"));
}

export function preflightCommand(provider: Provider, model: string): CommandSpec {
  switch (provider) {
    case "claude":
      return {
        command: "claude",
        args: ["auth", "status", "--json"],
        stdin: "none",
      };
    case "codex":
      return {
        command: "codex",
        args: ["login", "status"],
        stdin: "none",
      };
    case "grok":
      return { command: "grok", args: ["models"], stdin: "none" };
    case "opencode":
      return {
        command: "opencode",
        args: ["models", opencodeProviderId(model), "--verbose"],
        stdin: "none",
      };
  }
}

export function verificationCommand(
  provider: Provider,
  sessionId: string
): CommandSpec | null {
  return provider === "opencode"
    ? { command: "opencode", args: ["export", sessionId], stdin: "none" }
    : null;
}

function claudeDeniedTools(mode: AccessMode): string {
  const always = ["Agent", "Task", "WebSearch", "WebFetch"];
  const readonly = ["Edit", "Write", "NotebookEdit"];
  return [...always, ...(mode === "read-only" ? readonly : [])].join(",");
}

function claudeTools(mode: AccessMode): string {
  return mode === "read-only"
    ? "Read,Grep,Glob,Bash"
    : "Read,Write,Edit,Grep,Glob,Bash";
}

function codexSandbox(mode: AccessMode): string {
  return mode === "read-only" ? "read-only" : "workspace-write";
}

function grokSandbox(mode: AccessMode): string {
  return mode === "read-only" ? "read-only" : "workspace";
}

function grokTools(mode: AccessMode): string {
  const readonly = ["read_file", "grep", "list_dir", "run_terminal_cmd"];
  return [...readonly, ...(mode === "isolated-write" ? ["search_replace"] : [])].join(",");
}

function permissionMode(mode: AccessMode): string {
  return mode === "read-only" ? "plan" : "acceptEdits";
}

function effortOverride(effort: Effort): string {
  return `model_reasoning_effort=${JSON.stringify(effort)}`;
}

export function opencodeAgentName(mode: AccessMode): string {
  return `pstack-${mode}`;
}

// opencode has no sandbox flag. Access is bounded by an agent whose
// permissions are injected through OPENCODE_CONFIG_CONTENT, the highest
// standard config layer, so a project opencode.json cannot loosen it. Bash
// cannot be confined to read-only there, so the read-only lane denies it.
export function opencodeConfig(mode: AccessMode): string {
  const write = mode === "isolated-write" ? "allow" : "deny";
  return JSON.stringify({
    agent: {
      [opencodeAgentName(mode)]: {
        mode: "primary",
        description: `pstack ${mode} lane`,
        permission: {
          edit: write,
          bash: write,
          task: "deny",
          webfetch: "deny",
          websearch: "deny",
          skill: "deny",
          todowrite: "deny",
          external_directory: "deny",
          question: "deny",
          doom_loop: "deny",
        },
      },
    },
  });
}

export function invocationCommand(options: RunnerOptions): CommandSpec {
  switch (options.provider) {
    case "claude":
      return {
        command: "claude",
        args: [
          "-p",
          "--model",
          options.model,
          "--effort",
          options.effort,
          "--permission-mode",
          permissionMode(options.mode),
          "--setting-sources",
          "project",
          "--strict-mcp-config",
          "--tools",
          claudeTools(options.mode),
          "--no-session-persistence",
          "--disable-slash-commands",
          "--disallowed-tools",
          claudeDeniedTools(options.mode),
          "--output-format",
          "json",
        ],
        stdin: "prompt",
      };
    case "codex":
      return {
        command: "codex",
        args: [
          "exec",
          "--model",
          options.model,
          "--config",
          effortOverride(options.effort),
          "--sandbox",
          codexSandbox(options.mode),
          "--cd",
          options.cwd,
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
        ],
        stdin: "prompt",
      };
    case "grok":
      return {
        command: "grok",
        args: [
          "--prompt-file",
          options.promptPath,
          "--model",
          options.model,
          "--reasoning-effort",
          options.effort,
          "--permission-mode",
          permissionMode(options.mode),
          "--sandbox",
          grokSandbox(options.mode),
          "--tools",
          grokTools(options.mode),
          "--disallowed-tools",
          "Agent,search_tool,use_tool",
          "--output-format",
          "streaming-messages-json",
          "--cwd",
          options.cwd,
          "--no-subagents",
          "--disable-web-search",
          "--verbatim",
        ],
        stdin: "none",
      };
    case "opencode":
      return {
        command: "opencode",
        args: [
          "run",
          "--pure",
          "--format",
          "json",
          "--model",
          options.model,
          "--variant",
          options.effort,
          "--agent",
          opencodeAgentName(options.mode),
          "--dir",
          options.cwd,
        ],
        stdin: "prompt",
        env: { OPENCODE_CONFIG_CONTENT: opencodeConfig(options.mode) },
      };
  }
}

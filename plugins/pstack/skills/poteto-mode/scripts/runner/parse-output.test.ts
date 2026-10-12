import { describe, expect, it } from "bun:test";
import {
  opencodeModelListing,
  parseOpencodeExport,
  parseProviderOutput,
  reportedModelMatches,
} from "./parse-output.ts";

const OPENCODE_STREAM = [
  JSON.stringify({
    type: "step_start",
    sessionID: "ses_1",
    part: { type: "step-start", messageID: "msg_1" },
  }),
  JSON.stringify({
    type: "text",
    sessionID: "ses_1",
    part: { type: "text", messageID: "msg_1", text: "Looking at the file." },
  }),
  JSON.stringify({
    type: "step_finish",
    sessionID: "ses_1",
    part: {
      type: "step-finish",
      reason: "tool-calls",
      tokens: { total: 100, input: 90, output: 5, reasoning: 5, cache: { read: 10, write: 0 } },
      cost: 0.01,
    },
  }),
  JSON.stringify({
    type: "text",
    sessionID: "ses_1",
    part: { type: "text", messageID: "msg_1", text: "OPENCODE_OK" },
  }),
  JSON.stringify({
    type: "step_finish",
    sessionID: "ses_1",
    part: {
      type: "step-finish",
      reason: "stop",
      tokens: { total: 50, input: 40, output: 8, reasoning: 2, cache: { read: 0, write: 0 } },
      cost: 0.005,
    },
  }),
].join("\n");

const OPENCODE_LISTING = [
  "opencode-go/kimi-k3",
  JSON.stringify({ id: "kimi-k3", providerID: "opencode-go", variants: { max: { reasoningEffort: "max" } } }, null, 2),
  "opencode-go/kimi-k2.6",
  JSON.stringify({ id: "kimi-k2.6", providerID: "opencode-go" }, null, 2),
].join("\n");

describe("parseProviderOutput", () => {
  it("extracts Claude text, model, usage, cost, and session", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        session_id: "claude-session",
        usage: { input_tokens: 10, output_tokens: 3 },
        total_cost_usd: 0.05,
        modelUsage: { "claude-fable-9-9": { inputTokens: 10 } },
      }),
      "",
      "fable"
    );
    expect(parsed).toMatchObject({
      text: "CLAUDE_OK",
      reportedModel: "claude-fable-9-9",
      sessionId: "claude-session",
      usage: { inputTokens: 10, outputTokens: 3 },
      costUsd: 0.05,
    });
  });

  it("extracts the last Claude result event and its terminal metadata", () => {
    const parsed = parseProviderOutput("claude", JSON.stringify([
      { type: "system", model: "claude-opus-9" },
      { type: "result", result: "EARLIER_RESULT" },
      null,
      { type: "assistant", message: { content: [{ type: "text", text: "progress" }] } },
      {
        type: "result", is_error: false, result: "CLAUDE_ARRAY_OK",
        session_id: "claude-array-session",
        usage: { input_tokens: 14, output_tokens: 4, cache_read_input_tokens: 2 },
        total_cost_usd: 0.03,
        modelUsage: { "claude-haiku-4-5-20251001": {}, "claude-fable-9-9": {} },
      },
      { type: "system", result: "NOT_A_TERMINAL_RESULT" },
    ]), "", "fable");
    expect(parsed).toMatchObject({
      text: "CLAUDE_ARRAY_OK", reportedModel: "claude-fable-9-9",
      sessionId: "claude-array-session",
      usage: { inputTokens: 14, outputTokens: 4, cachedInputTokens: 2 },
      costUsd: 0.03,
    });
  });

  it("rejects Claude terminal errors before accepting partial or missing text", () => {
    for (const result of ["partial text", undefined]) {
      const terminal = { type: "result", is_error: true, result };
      for (const raw of [terminal, [{ type: "result", result: "earlier success" }, terminal]]) {
        expect(() => parseProviderOutput("claude", JSON.stringify(raw), "", "fable"))
          .toThrow("claude reported an error result");
      }
    }
  });

  it("rejects Claude arrays without a terminal result event", () => {
    for (const raw of [[], [null, "text"], [{ type: "assistant", result: "progress" }]]) {
      expect(() => parseProviderOutput("claude", JSON.stringify(raw), "", "fable"))
        .toThrow("claude result did not contain a terminal event");
    }
  });

  it("rejects Claude terminal results without final text", () => {
    for (const result of [undefined, "", 42]) {
      const terminal = { type: "result", is_error: false, result };
      for (const raw of [terminal, [terminal]]) {
        expect(() => parseProviderOutput("claude", JSON.stringify(raw), "", "fable"))
          .toThrow("claude result did not contain final text");
      }
    }
  });

  it("extracts Codex JSONL without inventing a provider-reported model", () => {
    const parsed = parseProviderOutput(
      "codex",
      [
        JSON.stringify({ type: "thread.started", thread_id: "codex-session" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "CODEX_OK" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 20,
            cached_input_tokens: 4,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        }),
      ].join("\n"),
      "model: gpt-5.6-sol\nreasoning effort: max\n",
      "gpt-5.6-sol"
    );
    expect(parsed).toMatchObject({
      text: "CODEX_OK",
      reportedModel: null,
      sessionId: "codex-session",
      usage: {
        inputTokens: 20,
        cachedInputTokens: 4,
        outputTokens: 5,
        reasoningTokens: 2,
      },
    });
  });

  it("accepts Grok's reported build suffix", () => {
    const parsed = parseProviderOutput(
      "grok",
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "progress" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "GROK_OK",
          session_id: "grok-session",
          usage: {
            input_tokens: 30,
            cache_read_input_tokens: 6,
            output_tokens: 7,
            reasoning_tokens: 3,
            total_tokens: 43,
          },
          total_cost_usd: 0.02,
          modelUsage: { "grok-4.6-build": {} },
        }),
      ].join("\n"),
      "",
      "grok-4.6"
    );
    expect(parsed.text).toBe("GROK_OK");
    expect(parsed.reportedModel).toBe("grok-4.6-build");
    expect(reportedModelMatches("grok", "grok-4.6", parsed.reportedModel)).toBe(
      true
    );
  });

  it("extracts opencode's last text part, summed usage, and session without a model", () => {
    const parsed = parseProviderOutput("opencode", OPENCODE_STREAM, "", "opencode-go/kimi-k3");
    expect(parsed).toEqual({
      text: "OPENCODE_OK",
      reportedModel: null,
      sessionId: "ses_1",
      usage: {
        inputTokens: 130,
        cachedInputTokens: 10,
        cacheCreationInputTokens: 0,
        outputTokens: 13,
        reasoningTokens: 7,
        totalTokens: 150,
      },
      costUsd: 0.015,
    });
  });

  it("fails an opencode lane whose agent fell back or whose stream errored", () => {
    expect(() =>
      parseProviderOutput(
        "opencode",
        OPENCODE_STREAM,
        '! agent "pstack-read-only" not found. Falling back to default agent\n',
        "opencode-go/kimi-k3"
      )
    ).toThrow("fell back to its default agent");
    expect(() =>
      parseProviderOutput(
        "opencode",
        JSON.stringify({
          type: "error",
          sessionID: "ses_2",
          error: { name: "UnknownError", data: { message: "Unexpected server error." } },
        }),
        "",
        "opencode-go/kimi-k3"
      )
    ).toThrow("Unexpected server error.");
    expect(() =>
      parseProviderOutput("opencode", "", "", "opencode-go/kimi-k3")
    ).toThrow("final text part");
  });

  it("reads the served model and variant from an opencode export", () => {
    const exported = parseOpencodeExport(
      JSON.stringify({
        info: {
          id: "ses_1",
          model: { id: "kimi-k3", providerID: "opencode-go", variant: "max" },
        },
        messages: [],
      })
    );
    expect(exported).toEqual({ reportedModel: "opencode-go/kimi-k3", variant: "max" });
    expect(reportedModelMatches("opencode", "opencode-go/kimi-k3", "opencode-go/kimi-k3")).toBe(true);
    expect(reportedModelMatches("opencode", "opencode-go/kimi-k3", "opencode-go/kimi-k3-x")).toBe(false);
    expect(() => parseOpencodeExport(JSON.stringify({ info: {} }))).toThrow(
      "did not record the served model"
    );
  });

  it("checks an opencode listing for the model and its registered variant", () => {
    expect(opencodeModelListing(OPENCODE_LISTING, "opencode-go/kimi-k3", "max")).toEqual({
      kind: "listed",
    });
    expect(opencodeModelListing(OPENCODE_LISTING, "opencode-go/kimi-k3", "low")).toEqual({
      kind: "missing-variant",
      variants: ["max"],
    });
    expect(opencodeModelListing(OPENCODE_LISTING, "opencode-go/kimi-k2.6", "max")).toEqual({
      kind: "missing-variant",
      variants: [],
    });
    expect(opencodeModelListing(OPENCODE_LISTING, "opencode-go/absent", "max")).toEqual({
      kind: "missing-model",
    });
  });

  it("selects the requested Claude model when usage includes a side model", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        modelUsage: {
          "claude-haiku-4-5-20251001": {},
          "claude-fable-9-9": {},
        },
      }),
      "",
      "fable"
    );
    expect(parsed.reportedModel).toBe("claude-fable-9-9");
  });

  it("matches only concrete Claude revisions from the requested rolling family", () => {
    expect(reportedModelMatches("claude", "fable", "claude-fable-9-9")).toBe(true);
    expect(reportedModelMatches("claude", "opus", "claude-opus-9")).toBe(true);
    expect(reportedModelMatches("claude", "fable", "claude-opus-9")).toBe(false);
    expect(reportedModelMatches("claude", "fable", "claude-fable-beta")).toBe(false);
    expect(reportedModelMatches("claude", "fable", "fable")).toBe(false);
    expect(reportedModelMatches("claude", "fable", "fable-preview")).toBe(false);
    expect(reportedModelMatches("grok", "fable", "claude-fable-9-9")).toBe(false);
  });

  for (const [stopReason, expectedStatus] of [
    ["cancelled", "cancelled"], ["canceled", "cancelled"], ["end_turn", "child-failed"],
  ]) {
    it(`issue78 retains terminal metadata for ${stopReason}`, () => {
      let failure: unknown;
      try {
        parseProviderOutput("grok", JSON.stringify({
          type: "result", subtype: "error_during_execution", is_error: true,
          stop_reason: stopReason, errors: ["Exact provider reason"],
          session_id: "terminal-session", modelUsage: { "grok-4.6-build": {} },
          usage: { input_tokens: 30, output_tokens: 4 }, total_cost_usd: 0.02,
        }), "", "grok-4.6");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        message: "Exact provider reason", status: expectedStatus,
        metadata: {
          reportedModel: "grok-4.6-build", sessionId: "terminal-session",
          usage: { inputTokens: 30, outputTokens: 4 }, costUsd: 0.02,
        },
      });
    });
  }

  it("issue78 rejects incomplete terminal status", () => {
    for (const terminal of [
      { type: "result", result: "text" },
      { type: "result", subtype: "success", result: "text" },
      { type: "result", subtype: "", is_error: true },
      { type: "result", subtype: "api_error", is_error: "true" },
    ]) {
      expect(() => parseProviderOutput("grok", JSON.stringify(terminal), "", "grok-4.6"))
        .toThrow("valid terminal status");
    }
    expect(() => parseProviderOutput("grok", "not-json", "", "grok-4.6"))
      .toThrow("non-JSON event");
    expect(() => parseProviderOutput("grok", '{"type":"assistant"}', "", "grok-4.6"))
      .toThrow("terminal event");
  });

  it("rejects malformed or textless responses", () => {
    expect(() =>
      parseProviderOutput("claude", "not-json", "", "fable")
    ).toThrow("valid JSON");
    expect(() =>
      parseProviderOutput(
        "codex",
        JSON.stringify({ type: "turn.completed" }),
        "",
        "gpt-5.6-sol"
      )
    ).toThrow("final agent message");
  });
});

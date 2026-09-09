import type {
  NormalizedUsage,
  ParsedOutput,
  Provider,
} from "./types.ts";
import {
  concreteModelMatchesRollingAlias,
  isRollingClaudeAlias,
} from "./model-aliases.ts";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizedUsage(value: unknown): NormalizedUsage | null {
  const usage = object(value);
  if (usage === null) return null;
  const result: NormalizedUsage = {
    inputTokens: finiteNumber(usage.input_tokens),
    cachedInputTokens: finiteNumber(
      usage.cached_input_tokens ?? usage.cache_read_input_tokens
    ),
    cacheCreationInputTokens: finiteNumber(
      usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens
    ),
    outputTokens: finiteNumber(usage.output_tokens),
    reasoningTokens: finiteNumber(
      usage.reasoning_tokens ?? usage.reasoning_output_tokens
    ),
    totalTokens: finiteNumber(usage.total_tokens),
  };
  return Object.values(result).some((entry) => entry !== undefined)
    ? result
    : null;
}

function modelFromUsage(
  value: unknown,
  provider: Provider,
  requestedModel: string
): string | null {
  const usage = object(value);
  if (usage === null) return null;
  const models = Object.keys(usage);
  return models.find((model) =>
    reportedModelMatches(provider, requestedModel, model)
  )
    ?? models[0]
    ?? null;
}

// A terminal event the parser refuses but that still carries the model's
// final text. The runner writes that text out, so a classification failure
// never destroys the lane's work.
export class MalformedOutputError extends Error {
  constructor(message: string, readonly text: string | null) {
    super(message);
  }
}

function parseClaude(stdout: string, requestedModel: string): ParsedOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("claude did not emit valid JSON");
  }
  const value = object(raw);
  if (value === null) throw new Error("claude emitted a non-object result");

  const text = nullableString(value.result);
  if (text === null) throw new Error("claude result did not contain final text");
  if (value.is_error === true) {
    throw new MalformedOutputError("claude reported an error result", text);
  }

  return {
    text,
    reportedModel: modelFromUsage(value.modelUsage, "claude", requestedModel),
    sessionId: nullableString(value.session_id ?? value.sessionId),
    usage: normalizedUsage(value.usage),
    costUsd: finiteNumber(value.total_cost_usd) ?? null,
  };
}

function parseGrok(stdout: string, requestedModel: string): ParsedOutput {
  let result: JsonObject | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("grok emitted a non-JSON event");
    }
    const event = object(raw);
    if (event?.type === "result") result = event;
  }

  if (result === null) throw new Error("grok result did not contain a terminal event");
  if (result.is_error === true || result.subtype !== "success") {
    throw new MalformedOutputError(
      `grok reported an error result (subtype ${JSON.stringify(result.subtype ?? null)}, is_error ${JSON.stringify(result.is_error ?? null)})`,
      nullableString(result.result)
    );
  }
  const text = nullableString(result.result);
  if (text === null) throw new Error("grok result did not contain final text");

  return {
    text,
    reportedModel: modelFromUsage(result.modelUsage, "grok", requestedModel),
    sessionId: nullableString(result.session_id),
    usage: normalizedUsage(result.usage),
    costUsd: finiteNumber(result.total_cost_usd) ?? null,
  };
}

function parseCodex(stdout: string): ParsedOutput {
  let text: string | null = null;
  let usage: NormalizedUsage | null = null;
  let sessionId: string | null = null;

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("codex emitted a non-JSON event");
    }
    const event = object(raw);
    if (event === null) continue;
    if (event.type === "thread.started") {
      sessionId = nullableString(event.thread_id) ?? sessionId;
    }
    if (event.type === "item.completed") {
      const item = object(event.item);
      if (item?.type === "agent_message") {
        text = nullableString(item.text) ?? text;
      }
    }
    if (event.type === "turn.completed") {
      usage = normalizedUsage(event.usage) ?? usage;
    }
    if (event.type === "turn.failed") {
      const error = object(event.error);
      throw new Error(nullableString(error?.message) ?? "codex reported a failed turn");
    }
  }

  if (text === null) throw new Error("codex result did not contain a final agent message");
  return {
    text,
    reportedModel: null,
    sessionId,
    usage,
    costUsd: null,
  };
}

function addUsage(
  total: NormalizedUsage | null,
  next: NormalizedUsage | null
): NormalizedUsage | null {
  if (total === null) return next;
  if (next === null) return total;
  const sum = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: sum(total.inputTokens, next.inputTokens),
    cachedInputTokens: sum(total.cachedInputTokens, next.cachedInputTokens),
    cacheCreationInputTokens: sum(
      total.cacheCreationInputTokens,
      next.cacheCreationInputTokens
    ),
    outputTokens: sum(total.outputTokens, next.outputTokens),
    reasoningTokens: sum(total.reasoningTokens, next.reasoningTokens),
    totalTokens: sum(total.totalTokens, next.totalTokens),
  };
}

function opencodeStepUsage(value: unknown): NormalizedUsage | null {
  const tokens = object(value);
  if (tokens === null) return null;
  const cache = object(tokens.cache);
  return normalizedUsage({
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    reasoning_tokens: tokens.reasoning,
    total_tokens: tokens.total,
    cache_read_input_tokens: cache?.read,
    cache_write_input_tokens: cache?.write,
  });
}

// The stream carries text parts, per-step token counts, and the session id,
// but never the served model. `parseOpencodeExport` supplies that afterwards.
// The final answer is the last text part; earlier parts are tool narration.
function parseOpencode(stdout: string, stderr: string): ParsedOutput {
  if (/not found\. Falling back to default agent/.test(stderr)) {
    throw new Error("opencode fell back to its default agent; the lane's access mode was not applied");
  }
  let text: string | null = null;
  let sessionId: string | null = null;
  let usage: NormalizedUsage | null = null;
  let costUsd: number | null = null;

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("opencode emitted a non-JSON event");
    }
    const event = object(raw);
    if (event === null) continue;
    sessionId = nullableString(event.sessionID) ?? sessionId;
    const part = object(event.part);
    if (event.type === "error") {
      const error = object(event.error);
      const data = object(error?.data);
      throw new Error(
        nullableString(data?.message) ?? nullableString(error?.name) ?? "opencode reported an error event"
      );
    }
    if (event.type === "text" && part !== null) {
      text = nullableString(part.text) ?? text;
    }
    if (event.type === "step_finish" && part !== null) {
      usage = addUsage(usage, opencodeStepUsage(part.tokens));
      const cost = finiteNumber(part.cost);
      if (cost !== undefined) costUsd = (costUsd ?? 0) + cost;
    }
  }

  if (text === null) throw new Error("opencode result did not contain a final text part");
  return { text, reportedModel: null, sessionId, usage, costUsd };
}

export interface OpencodeExport {
  readonly reportedModel: string;
  readonly variant: string | null;
}

export function parseOpencodeExport(stdout: string): OpencodeExport {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("opencode export did not emit valid JSON");
  }
  const info = object(object(raw)?.info);
  const model = object(info?.model);
  const providerId = nullableString(model?.providerID);
  const modelId = nullableString(model?.id);
  if (providerId === null || modelId === null) {
    throw new Error("opencode export did not record the served model");
  }
  return {
    reportedModel: `${providerId}/${modelId}`,
    variant: nullableString(model?.variant),
  };
}

export type OpencodeListing =
  | { readonly kind: "listed" }
  | { readonly kind: "missing-model" }
  | { readonly kind: "missing-variant"; readonly variants: readonly string[] };

// `opencode models <provider> --verbose` prints each model id on its own
// line followed by its JSON record. An effort that is not a registered
// variant is dropped silently at run time, so it is refused here instead.
export function opencodeModelListing(
  stdout: string,
  model: string,
  effort: string
): OpencodeListing {
  const lines = stdout.split(/\r?\n/);
  const header = lines.findIndex((line) => line.trim() === model);
  if (header < 0) return { kind: "missing-model" };
  // The record is pretty-printed; only its own closing brace sits in column 0.
  const block: string[] = [];
  for (const line of lines.slice(header + 1)) {
    block.push(line);
    if (line === "}") break;
  }
  let record: unknown;
  try {
    record = JSON.parse(block.join("\n"));
  } catch {
    return { kind: "missing-variant", variants: [] };
  }
  const variants = Object.keys(object(object(record)?.variants) ?? {});
  return variants.includes(effort)
    ? { kind: "listed" }
    : { kind: "missing-variant", variants };
}

export function parseProviderOutput(
  provider: Provider,
  stdout: string,
  stderr: string,
  requestedModel: string
): ParsedOutput {
  switch (provider) {
    case "claude":
      return parseClaude(stdout, requestedModel);
    case "codex":
      return parseCodex(stdout);
    case "grok":
      return parseGrok(stdout, requestedModel);
    case "opencode":
      return parseOpencode(stdout, stderr);
  }
}

export function reportedModelMatches(
  provider: Provider,
  requested: string,
  reported: string | null
): boolean {
  if (reported === null) return false;
  if (provider === "claude" && isRollingClaudeAlias(requested)) {
    return concreteModelMatchesRollingAlias(requested, reported);
  }
  if (provider === "opencode") return reported === requested;
  if (reported === requested || reported.startsWith(`${requested}-`)) {
    return true;
  }
  return false;
}

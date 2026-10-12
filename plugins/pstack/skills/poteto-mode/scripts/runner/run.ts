import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  invocationCommand,
  preflightCommand,
  verificationCommand,
  type CommandSpec,
} from "./commands.ts";
import { versionedClaudeAlias } from "./model-aliases.ts";
import {
  MalformedOutputError,
  opencodeModelListing,
  parseOpencodeExport,
  parseProviderOutput,
  ProviderResultError,
  reportedModelMatches,
} from "./parse-output.ts";
import type {
  AccessMode,
  ParsedOutput,
  Provider,
  ReceiptStatus,
  RunnerOptions,
  RunnerReceipt,
} from "./types.ts";
import { UsageError } from "./types.ts";

const ERROR_EVIDENCE_LIMIT = 4_000;
const GROK_PREFLIGHT_RETRY_DELAY_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelledBy: CancellationSignal | null;
}

type CancellationSignal = "SIGINT" | "SIGTERM";

interface RunCancellation {
  readonly promise: Promise<CancellationSignal>;
  readonly signal: CancellationSignal | null;
  dispose(): void;
}

type RetryWaitResult = "ready" | "cancelled" | "timed-out";

export interface RunResult {
  readonly exitCode: number;
  readonly receipt: RunnerReceipt;
}

function evidence(value: string): string {
  return value.trim().slice(0, ERROR_EVIDENCE_LIMIT);
}

// A provider's terminal event ends its stream, so malformed output keeps the tail.
function trailingEvidence(value: string): string {
  return value.trim().slice(-ERROR_EVIDENCE_LIMIT);
}

function keepStream(path: string, content: string): string | undefined {
  if (content.length === 0) return undefined;
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

function removeIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function reserve(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
}

interface ModelStreams {
  readonly stdout: number;
  readonly stderr: number;
}

function modelStreamPaths(receiptPath: string): { stdoutPath: string; stderrPath: string } {
  return { stdoutPath: `${receiptPath}.stdout`, stderrPath: `${receiptPath}.stderr` };
}

function reserveOutputs(options: RunnerOptions): ModelStreams {
  const { stdoutPath, stderrPath } = modelStreamPaths(options.receiptPath);
  const paths = [options.outputPath, options.receiptPath, stdoutPath, stderrPath];
  const resolved = paths.map((path) => resolve(path));
  if (new Set(resolved).size !== paths.length || resolved.includes(resolve(options.promptPath))) {
    throw new UsageError("prompt, output, receipt, and stream paths must be distinct");
  }
  const created: string[] = [];
  let stdout: number | null = null;
  try {
    for (const path of paths.slice(0, 2)) {
      reserve(path);
      created.push(path);
    }
    stdout = openSync(stdoutPath, "wx", 0o600);
    created.push(stdoutPath);
    const stderr = openSync(stderrPath, "wx", 0o600);
    return { stdout, stderr };
  } catch (error) {
    if (stdout !== null) closeSync(stdout);
    for (const path of created) removeIfExists(path);
    throw error;
  }
}

function writeReceipt(path: string, receipt: RunnerReceipt): void {
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function installRunCancellation(): RunCancellation {
  let signal: CancellationSignal | null = null;
  let resolveCancellation!: (value: CancellationSignal) => void;
  const promise = new Promise<CancellationSignal>((resolve) => {
    resolveCancellation = resolve;
  });

  const receive = (next: CancellationSignal): void => {
    if (signal === null) {
      signal = next;
      resolveCancellation(next);
    }
  };
  const onInterrupt = (): void => receive("SIGINT");
  const onTerminate = (): void => receive("SIGTERM");
  globalThis.process.on("SIGINT", onInterrupt);
  globalThis.process.on("SIGTERM", onTerminate);

  return {
    promise,
    get signal() {
      return signal;
    },
    dispose() {
      globalThis.process.off("SIGINT", onInterrupt);
      globalThis.process.off("SIGTERM", onTerminate);
    },
  };
}

const CODEX_IDENTITY = [
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_CI",
  "CODEX_SHELL",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
] as const;

const CLAUDE_IDENTITY = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
] as const;

const GROK_ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
  "COLORTERM",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

const GROK_ENVIRONMENT_PREFIXES = ["LC_", "XDG_", "GROK_", "XAI_"] as const;

// A Grok lane's shell can read every variable it inherits in both access modes, so it gets
// only what grok needs to start, authenticate and reach the network.
// A Claude writer's git must find its repository from the cwd, as discovery's git did, so
// an inherited GIT_DIR or GIT_COMMON_DIR cannot route it to an undenied git directory.
export function childEnvironment(
  provider: Provider,
  mode: AccessMode,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (provider === "grok") {
    return Object.fromEntries(Object.entries(source).filter(([key]) =>
      GROK_ENVIRONMENT.has(key) || GROK_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))
    ));
  }
  const result = { ...source };
  for (const key of provider === "claude" ? CODEX_IDENTITY : CLAUDE_IDENTITY) delete result[key];
  if (provider === "claude" && mode === "isolated-write") {
    for (const key of Object.keys(result)) if (key.startsWith("GIT_")) delete result[key];
  }
  return result;
}

async function terminate(
  child: Bun.Subprocess,
  signal: CancellationSignal = "SIGTERM"
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  child.kill(signal);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let exited: boolean;
  try {
    exited = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
  } finally {
    if (graceTimer !== null) clearTimeout(graceTimer);
  }
  if (!exited) {
    child.kill("SIGKILL");
    await child.exited;
  }
  return true;
}

interface StreamCapture {
  readonly result: Promise<string>;
  cancel(): Promise<void>;
}

function captureStream(stream: ReadableStream<Uint8Array>, descriptor?: number): StreamCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let cancellationRequested = false;

  const result = (async (): Promise<string> => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (descriptor !== undefined) {
          let offset = 0;
          while (offset < next.value.byteLength) {
            offset += writeSync(descriptor, next.value, offset, next.value.byteLength - offset);
          }
        }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      text += decoder.decode();
      if (!cancellationRequested) throw error;
      return text;
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    result,
    async cancel() {
      cancellationRequested = true;
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed and its reader released.
      }
    },
  };
}

type ProcessEvent =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "cancelled"; readonly signal: CancellationSignal }
  | { readonly kind: "timed-out" };

async function runProcess(
  executable: string,
  spec: CommandSpec,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  deadlineAt: number | null,
  cancellation: RunCancellation,
  streamFiles?: ModelStreams
): Promise<ProcessResult> {
  const child = Bun.spawn([executable, ...spec.args], {
    cwd,
    env: { ...env, ...spec.env },
    stdin: spec.stdin === "prompt" ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const stdoutCapture = captureStream(child.stdout, streamFiles?.stdout);
  const stderrCapture = captureStream(child.stderr, streamFiles?.stderr);
  const streams = Promise.all([stdoutCapture.result, stderrCapture.result]);
  const exited = child.exited.then((exitCode): ProcessEvent => ({
    kind: "exited",
    exitCode,
  }));
  const cancelled = cancellation.promise.then((signal): ProcessEvent => ({
    kind: "cancelled",
    signal,
  }));
  const deadline: Promise<ProcessEvent> | null = deadlineAt === null
    ? null
    : new Promise((resolve) => {
      const arm = (): void => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          resolve({ kind: "timed-out" });
          return;
        }
        deadlineTimer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
      };
      arm();
    });
  try {
    if (spec.stdin === "prompt") {
      const stdin = child.stdin;
      if (stdin === undefined) throw new Error("child stdin pipe was not created");
      stdin.write(prompt);
      stdin.end();
    }

    const completions = [exited, cancelled, streams.then(() => exited)];
    if (deadline !== null) completions.push(deadline);
    const first = await Promise.race(completions);

    let outcome = first;
    let captured: readonly [string, string] | null = null;
    let signalSent: CancellationSignal | null = null;

    if (first.kind === "exited") {
      const drains: Array<Promise<
        | { readonly kind: "drained"; readonly captured: readonly [string, string] }
        | ProcessEvent
      >> = [
        streams.then((value) => ({ kind: "drained" as const, captured: value })),
        cancelled,
      ];
      if (deadline !== null) drains.push(deadline);
      const drain = await Promise.race(drains);
      if (drain.kind === "drained") {
        captured = drain.captured;
        if (deadlineAt !== null && Date.now() >= deadlineAt) {
          outcome = { kind: "timed-out" };
        }
      } else {
        outcome = drain;
      }
    }

    const cancelledBy = cancellation.signal;
    const timedOut = cancelledBy === null && outcome.kind === "timed-out";
    if (cancelledBy !== null) {
      if (await terminate(child, cancelledBy)) signalSent = cancelledBy;
    } else if (timedOut) {
      if (await terminate(child)) signalSent = "SIGTERM";
    }
    if (captured === null) {
      await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
      captured = await streams;
    }

    return {
      exitCode: await child.exited,
      signal: signalSent,
      stdout: captured[0],
      stderr: captured[1],
      timedOut,
      cancelledBy,
    };
  } catch (error) {
    await terminate(child, cancellation.signal ?? "SIGTERM");
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
    await Promise.allSettled([stdoutCapture.result, stderrCapture.result]);
    throw error;
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

async function waitForGrokPreflightRetry(
  deadlineAt: number | null,
  cancellation: RunCancellation
): Promise<RetryWaitResult> {
  if (cancellation.signal !== null) return "cancelled";

  const now = Date.now();
  if (deadlineAt !== null && now >= deadlineAt) return "timed-out";

  const retryAt = now + GROK_PREFLIGHT_RETRY_DELAY_MS;
  const wakeAt = deadlineAt === null ? retryAt : Math.min(retryAt, deadlineAt);
  const timerResult: RetryWaitResult = wakeAt < retryAt ? "timed-out" : "ready";
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      cancellation.promise.then((): RetryWaitResult => "cancelled"),
      new Promise<RetryWaitResult>((resolve) => {
        timer = setTimeout(() => resolve(timerResult), wakeAt - now);
      }),
    ]);
    if (cancellation.signal !== null) return "cancelled";
    if (deadlineAt !== null && Date.now() >= deadlineAt) return "timed-out";
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

type SharedGitDiscovery =
  | { readonly kind: "found"; readonly sharedGitDir: string | null }
  | {
    readonly kind: "refused";
    readonly status: ReceiptStatus;
    readonly message: string;
    readonly evidence: string;
    readonly exitCode: number | null;
    readonly signal: string | null;
  };

// Older git has no --path-format, so a relative answer is resolved against the cwd.
const GIT_COMMON_DIR: CommandSpec = {
  command: "git",
  args: ["rev-parse", "--git-common-dir"],
  stdin: "none",
};

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

// A linked worktree keeps its refs, objects and index in a git directory outside the cwd. Git
// itself finds that directory, from the cwd and with the writer's environment, so the deny matches
// what the writer's own git will use. Returns null for a non-repository or a directory the cwd
// contains, and refuses whatever cannot be denied literally: denyWrite entries are globs that
// cannot be escaped, and Claude Code 2.1.288 on Linux drops entries containing * ? [ ].
export async function discoverSharedGitDir(
  cwd: string,
  env: NodeJS.ProcessEnv,
  deadlineAt: number | null,
  cancellation: RunCancellation
): Promise<SharedGitDiscovery> {
  const refuse = (
    status: ReceiptStatus,
    message: string,
    result: ProcessResult | null = null
  ): SharedGitDiscovery => ({
    kind: "refused",
    status,
    message,
    evidence: result === null ? "" : evidence(`${result.stdout}\n${result.stderr}`),
    exitCode: result?.exitCode ?? null,
    signal: result?.signal ?? null,
  });
  const git = Bun.which(GIT_COMMON_DIR.command, { PATH: env.PATH, cwd });
  if (git === null) {
    return refuse(
      "unavailable-cli",
      "git executable not found, so the shared git directory cannot be found"
    );
  }
  // The C locale keeps git's "not a git repository" message in the English the check reads.
  const result = await runProcess(
    git,
    GIT_COMMON_DIR,
    cwd,
    { ...env, LC_ALL: "C" },
    "",
    deadlineAt,
    cancellation
  );
  if (result.cancelledBy !== null) {
    return refuse(
      "cancelled",
      `launcher received ${result.cancelledBy} during shared git directory discovery`,
      result
    );
  }
  if (result.timedOut) {
    return refuse("timed-out", "shared git directory discovery timed out", result);
  }
  // Only git's "searched and found nothing" answer means no repository. A .git that names a
  // missing or malformed git directory fails with other wording and is refused.
  const notARepository =
    /^fatal: not a git repository \(or any (of the parent directories|parent up to mount point)/m;
  if (result.exitCode === 128 && notARepository.test(result.stderr)) {
    return { kind: "found", sharedGitDir: null };
  }
  const reported = result.stdout.replace(/\n$/, "");
  if (result.exitCode !== 0 || reported.length === 0) {
    return refuse(
      "child-failed",
      `git rev-parse --git-common-dir exited with status ${result.exitCode}`,
      result
    );
  }
  let root: string;
  let shared: string;
  try {
    root = realpathSync(cwd);
    shared = realpathSync(resolve(root, reported));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refuse("child-failed", `cannot resolve the shared git directory: ${message}`, result);
  }
  if (within(root, shared)) return { kind: "found", sharedGitDir: null };
  if (within(shared, root)) {
    return refuse(
      "child-failed",
      `cwd ${JSON.stringify(root)} is inside its shared git directory ${JSON.stringify(shared)}, ` +
        "so the Claude writer sandbox cannot deny that directory without denying the cwd",
      result
    );
  }
  if (/[*?[\]{}\u0000-\u001f\u007f]/.test(shared)) {
    return refuse(
      "child-failed",
      `shared git directory ${JSON.stringify(shared)} contains a glob or control character, ` +
        "so the Claude writer sandbox cannot deny it literally",
      result
    );
  }
  return { kind: "found", sharedGitDir: shared };
}

// grok names its configured default above the list even when the account cannot use it,
// so only the lines under the header count.
function grokModelAvailable(value: string, model: string): boolean {
  const lines = value.split("\n");
  const header = lines.findIndex((line) => /^\s*Available models:/.test(line));
  if (header < 0) return false;
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const listed = new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}($|[^A-Za-z0-9_.-])`);
  return lines.slice(header + 1).some((line) => listed.test(line));
}

function preflightPassed(options: RunnerOptions, result: ProcessResult): boolean {
  if (result.exitCode !== 0 || result.timedOut) return false;
  const combined = `${result.stdout}\n${result.stderr}`;
  switch (options.provider) {
    case "claude": {
      try {
        const value: unknown = JSON.parse(result.stdout);
        return (
          value !== null &&
          typeof value === "object" &&
          (value as { loggedIn?: unknown }).loggedIn === true
        );
      } catch {
        return false;
      }
    }
    case "codex":
      return /logged in/i.test(combined);
    case "grok":
      return unavailableStatus(combined) === "child-failed"
        && /\blogged in\b|\bYou are using XAI_API_KEY\.|\bYou are authenticated via deployment key\./i
          .test(combined)
        && grokModelAvailable(combined, options.model);
    case "opencode":
      return opencodeModelListing(result.stdout, options.model, options.effort).kind === "listed";
  }
}

function successfulPreflightEvidence(options: RunnerOptions): string {
  switch (options.provider) {
    case "grok":
      return `authenticated; model ${options.model} available`;
    case "opencode":
      return `model ${options.model} lists variant ${options.effort}`;
    default:
      return "authenticated";
  }
}

// The verbose listing is thousands of lines; the receipt keeps the one fact
// that failed instead of a truncated dump.
function failedPreflightEvidence(options: RunnerOptions, result: ProcessResult): string {
  const raw = evidence(`${result.stdout}\n${result.stderr}`);
  if (options.provider !== "opencode" || result.exitCode !== 0) return raw;
  const listing = opencodeModelListing(result.stdout, options.model, options.effort);
  switch (listing.kind) {
    case "listed":
      return raw;
    case "missing-model":
      return `model ${options.model} is not listed by opencode; check credentials and the model id`;
    case "missing-variant":
      return listing.variants.length === 0
        ? `model ${options.model} registers no variants, so effort ${options.effort} cannot be applied`
        : `effort ${options.effort} is not a registered variant of ${options.model}; registered: ${listing.variants.join(", ")}`;
  }
}

// Only preflight output is read for authentication; a failed model call's output can quote
// the child's own work.
function unavailableStatus(value: string): ReceiptStatus {
  if (/not logged in|not authenticated|unauthenticated|authentication|sign in|login required/i.test(value)) {
    return "unauthenticated";
  }
  return modelFailureStatus(value);
}

function modelFailureStatus(value: string): "unavailable-model" | "child-failed" {
  return /model.{0,40}(not found|unknown|unavailable|unsupported|not supported|invalid)|invalid.{0,20}model/i.test(value)
    ? "unavailable-model"
    : "child-failed";
}

function preflightFailureStatus(
  provider: Provider,
  model: string,
  value: string
): ReceiptStatus {
  const status = unavailableStatus(value);
  if (status !== "child-failed") return status;
  if (provider === "opencode") return "unavailable-model";
  return provider === "grok" && !grokModelAvailable(value, model)
    ? "unavailable-model"
    : "unauthenticated";
}

class VerificationInterrupted extends Error {
  constructor(readonly status: "cancelled" | "timed-out", message: string) {
    super(message);
  }
}

function retriedPreflightEvidence(
  first: string,
  second: string,
  secondPassed: boolean
): string {
  const firstLabel = "attempt 1 failed:\n";
  const secondLabel = `\n\nattempt 2 ${secondPassed ? "passed" : "failed"}:\n`;
  const payloadLimit = ERROR_EVIDENCE_LIMIT - firstLabel.length - secondLabel.length;
  const firstLimit = Math.floor(payloadLimit / 2);
  const secondLimit = payloadLimit - firstLimit;
  return `${firstLabel}${first.slice(0, firstLimit)}${secondLabel}${second.slice(0, secondLimit)}`;
}

function statusExitCode(status: ReceiptStatus): number {
  switch (status) {
    case "complete":
      return 0;
    case "cancelled":
      return 130;
    case "malformed-output":
      return 65;
    case "unavailable-cli":
    case "unavailable-model":
      return 69;
    case "child-failed":
      return 70;
    case "unauthenticated":
      return 77;
    case "timed-out":
      return 124;
  }
}

function modelProof(
  provider: Provider,
  requested: string,
  reported: string | null
): {
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
} {
  if (reportedModelMatches(provider, requested, reported)) {
    return {
      reportedModel: reported,
      modelVerified: true,
      modelEvidence: "provider-report",
    };
  }
  if (provider === "codex" && reported === null) {
    return {
      reportedModel: null,
      modelVerified: false,
      modelEvidence: "pinned-argv",
    };
  }
  return {
    reportedModel: reported,
    modelVerified: false,
    modelEvidence: null,
  };
}

function completeReceipt(
  options: RunnerOptions,
  partial: Omit<RunnerReceipt, "schemaVersion" | "parent" | "provider" | "model" | "effort" | "mode" | "cwd" | "promptPath" | "outputPath" | "stdoutPath" | "stderrPath">
): RunnerReceipt {
  return {
    schemaVersion: 1,
    parent: options.parent,
    provider: options.provider,
    model: options.model,
    effort: options.effort,
    mode: options.mode,
    cwd: options.cwd,
    promptPath: options.promptPath,
    outputPath: options.outputPath,
    ...modelStreamPaths(options.receiptPath),
    ...partial,
  };
}

export function validateOptions(options: RunnerOptions): void {
  if (options.parent === options.provider) {
    throw new UsageError(
      `provider ${options.provider} is native to parent ${options.parent}; use the parent subagent primitive`
    );
  }
  if (options.model.trim().length === 0) throw new UsageError("model must not be empty");
  if (options.provider === "opencode" && !/^[^/\s]+\/[^/\s]+$/.test(options.model)) {
    throw new UsageError(
      `opencode model ${options.model} must be written as <provider>/<model>, e.g. opencode-go/kimi-k3`
    );
  }
  const staleAlias = options.provider === "claude"
    ? versionedClaudeAlias(options.model)
    : null;
  if (staleAlias !== null) {
    throw new UsageError(
      `Claude model ${options.model} is a version pin; normalize it to ${staleAlias} before invoking the runner`
    );
  }
  if (
    options.timeoutMs !== null &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new UsageError("timeout must be greater than zero");
  }
  if (!existsSync(options.promptPath) || !statSync(options.promptPath).isFile()) {
    throw new UsageError(`prompt is not a file: ${options.promptPath}`);
  }
  if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
    throw new UsageError(`cwd is not a directory: ${options.cwd}`);
  }
  if (
    options.promptPath === options.outputPath ||
    options.promptPath === options.receiptPath
  ) {
    throw new UsageError("prompt, output, and receipt paths must be distinct");
  }
}

interface LaneProgress {
  executable: string | null;
  preflight: RunnerReceipt["preflight"];
  argv: readonly string[];
}

async function executeLane(
  options: RunnerOptions,
  cancellation: RunCancellation,
  started: number,
  deadlineAt: number | null,
  invocation: CommandSpec,
  preflight: CommandSpec,
  progress: LaneProgress,
  streamFiles: ModelStreams
): Promise<RunResult> {
  const startedAt = new Date(started).toISOString();
  const prompt = readFileSync(options.promptPath, "utf8");
  const parentNetworkDisabled = options.parent === "codex"
    && process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
  const env = childEnvironment(options.provider, options.mode);
  const executable = Bun.which(invocation.command, {
    PATH: env.PATH,
    cwd: options.cwd,
  });
  progress.executable = executable;
  progress.argv = [executable ?? invocation.command, ...invocation.args];

  let preflightState = progress.preflight;
  let receipt: RunnerReceipt;

  const finishWithoutChild = (
    status: "cancelled" | "timed-out",
    phase: string
  ): RunResult => {
    const completed = Date.now();
    const receivedSignal = status === "cancelled" ? cancellation.signal : null;
    const terminalPreflight = preflightState.status === "not-run"
      ? { ...preflightState, status }
      : preflightState;
    receipt = completeReceipt(options, {
      status,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable,
      preflight: terminalPreflight,
      argv: [executable ?? invocation.command, ...invocation.args],
      exitCode: null,
      signal: null,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: receivedSignal === null
          ? `explicit deadline elapsed ${phase}`
          : `launcher received ${receivedSignal} ${phase}`,
        evidence: "",
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  };

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before authentication preflight");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before authentication preflight");
  }

  if (executable === null) {
    const completed = Date.now();
    receipt = completeReceipt(options, {
      status: "unavailable-cli",
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable: null,
      preflight: preflightState,
      argv: [invocation.command, ...invocation.args],
      exitCode: null,
      signal: null,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: `${invocation.command} executable not found`,
        evidence: "",
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(receipt.status), receipt };
  }

  if (options.provider === "claude" && options.mode === "isolated-write") {
    const discovery = await discoverSharedGitDir(options.cwd, env, deadlineAt, cancellation);
    if (discovery.kind === "refused") {
      const completed = Date.now();
      receipt = completeReceipt(options, {
        status: discovery.status,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        elapsedMs: completed - started,
        executable,
        preflight: discovery.status === "cancelled" || discovery.status === "timed-out"
          ? { ...preflightState, status: discovery.status }
          : preflightState,
        argv: [executable, ...invocation.args],
        exitCode: discovery.exitCode,
        signal: discovery.signal,
        reportedModel: null,
        modelVerified: false,
        modelEvidence: null,
        sessionId: null,
        usage: null,
        costUsd: null,
        error: { message: discovery.message, evidence: discovery.evidence },
      });
      removeIfExists(options.outputPath);
      writeReceipt(options.receiptPath, receipt);
      return { exitCode: statusExitCode(discovery.status), receipt };
    }
    invocation = invocationCommand(options, discovery.sharedGitDir);
    progress.argv = [executable, ...invocation.args];
  }

  const preflightExecutable = executable;
  let preflightResult = await runProcess(
    preflightExecutable,
    preflight,
    options.cwd,
    env,
    "",
    deadlineAt,
    cancellation
  );
  let rawPreflightEvidence = failedPreflightEvidence(options, preflightResult);
  let passed = preflightPassed(options, preflightResult);
  let preflightEvidence = passed
    ? successfulPreflightEvidence(options)
    : rawPreflightEvidence;

  if (
    options.provider === "grok" &&
    !passed &&
    preflightResult.cancelledBy === null &&
    !preflightResult.timedOut &&
    preflightFailureStatus(options.provider, options.model, rawPreflightEvidence) ===
      "unauthenticated"
  ) {
    preflightState = {
      argv: [preflightExecutable, ...preflight.args],
      status: "failed",
      evidence: rawPreflightEvidence,
    };
    progress.preflight = preflightState;

    const retryWait = await waitForGrokPreflightRetry(deadlineAt, cancellation);
    if (retryWait !== "ready") {
      preflightState = {
        ...preflightState,
        status: retryWait === "cancelled" ? "cancelled" : "timed-out",
      };
      progress.preflight = preflightState;
      return finishWithoutChild(
        retryWait === "cancelled" ? "cancelled" : "timed-out",
        "during authentication preflight retry delay"
      );
    }

    const firstPreflightEvidence = rawPreflightEvidence;
    preflightResult = await runProcess(
      preflightExecutable,
      preflight,
      options.cwd,
      env,
      "",
      deadlineAt,
      cancellation
    );
    rawPreflightEvidence = failedPreflightEvidence(options, preflightResult);
    passed = preflightPassed(options, preflightResult);
    preflightEvidence = retriedPreflightEvidence(
      firstPreflightEvidence,
      passed ? successfulPreflightEvidence(options) : rawPreflightEvidence,
      passed
    );
  }

  preflightState = {
    argv: [preflightExecutable, ...preflight.args],
    status: preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : passed
          ? "passed"
          : "failed",
    evidence: preflightEvidence,
  };
  progress.preflight = preflightState;

  if (preflightState.status !== "passed") {
    const completed = Date.now();
    const preflightFailure = preflightFailureStatus(
      options.provider,
      options.model,
      rawPreflightEvidence
    );
    const status: ReceiptStatus = preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : preflightFailure;
    receipt = completeReceipt(options, {
      status,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable,
      preflight: preflightState,
      argv: [executable, ...invocation.args],
      exitCode: preflightResult.exitCode,
      signal: preflightResult.signal,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: preflightResult.cancelledBy !== null
          ? `launcher received ${preflightResult.cancelledBy} during preflight`
          : preflightResult.timedOut
            ? "authentication preflight timed out"
            : "authentication or model preflight failed",
        evidence: preflightEvidence,
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  }

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before model execution");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before model execution");
  }

  const result = await runProcess(
    executable,
    invocation,
    options.cwd,
    env,
    prompt,
    deadlineAt,
    cancellation,
    streamFiles
  );
  const completed = Date.now();
  const base = {
    startedAt,
    completedAt: new Date(completed).toISOString(),
    elapsedMs: completed - started,
    executable,
    preflight: preflightState,
    argv: [executable, ...invocation.args],
    exitCode: result.exitCode,
    signal: result.signal,
  } as const;

  let parsed: ParsedOutput | null = null;
  let parseError: unknown = null;
  if (result.cancelledBy === null && !result.timedOut
      && (result.exitCode === 0 || (options.provider === "grok" && result.stdout.trim().length > 0))) {
    try {
      parsed = parseProviderOutput(options.provider, result.stdout, result.stderr, options.model);
    } catch (error) {
      parseError = error;
    }
  }
  const providerFailure = parseError instanceof ProviderResultError ? parseError : null;
  const metadata = providerFailure?.metadata ?? (result.exitCode === 0 ? parsed : null);
  if (result.cancelledBy !== null || result.timedOut || providerFailure !== null
      || result.exitCode !== 0) {
    const rawFailureEvidence = `${result.stderr}\n${result.stdout}`;
    const status: ReceiptStatus = result.cancelledBy !== null
      ? "cancelled"
      : result.timedOut
        ? "timed-out"
        : providerFailure?.status ?? modelFailureStatus(rawFailureEvidence);
    const sandboxHint = status === "child-failed" && providerFailure === null && parentNetworkDisabled
      ? "likely cause: Codex parent sandbox has network disabled; see provider-dispatch.md#host-and-parent-prerequisites"
      : null;
    const failureEvidence = evidence(providerFailure !== null
      ? `${providerFailure.message}\n${rawFailureEvidence}`
      : sandboxHint !== null
        ? `${sandboxHint}\n${rawFailureEvidence}`
        : rawFailureEvidence);
    receipt = completeReceipt(options, {
      ...base,
      status,
      ...(metadata === null
        ? { reportedModel: null, modelVerified: false, modelEvidence: null }
        : modelProof(options.provider, options.model, metadata.reportedModel)),
      sessionId: metadata?.sessionId ?? null,
      usage: metadata?.usage ?? null,
      costUsd: metadata?.costUsd ?? null,
      error: {
        message: result.cancelledBy !== null
          ? result.signal === result.cancelledBy
            ? `launcher received ${result.cancelledBy}; signal was sent to child`
            : `launcher received ${result.cancelledBy} after child exited`
          : result.timedOut
            ? `launcher exceeded the explicit ${options.timeoutMs}ms deadline`
            : providerFailure?.message ?? `child exited with status ${result.exitCode}${sandboxHint === null ? "" : `; ${sandboxHint}`}`,
        evidence: failureEvidence,
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  }

  try {
    if (parseError !== null) throw parseError;
    if (parsed === null) throw new Error("provider result was not parsed");
    parsed = await verifiedOutput(options, parsed, executable, env, deadlineAt, cancellation);
    const proof = modelProof(
      options.provider,
      options.model,
      parsed.reportedModel
    );
    if (!proof.modelVerified && proof.modelEvidence !== "pinned-argv") {
      throw new Error(
        `requested model ${options.model} was not reported by ${options.provider}`
      );
    }
    writeFileSync(options.outputPath, parsed.text, { encoding: "utf8", mode: 0o600 });
    receipt = completeReceipt(options, {
      ...base,
      status: "complete",
      ...proof,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
      costUsd: parsed.costUsd,
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = error instanceof MalformedOutputError ? error.text : null;
    if (text === null) {
      removeIfExists(options.outputPath);
    } else {
      writeFileSync(options.outputPath, text, { encoding: "utf8", mode: 0o600 });
    }
    receipt = completeReceipt(options, {
      ...base,
      status: error instanceof VerificationInterrupted ? error.status : "malformed-output",
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message,
        evidence: trailingEvidence(`${result.stderr}\n${result.stdout}`),
        stdoutPath: keepStream(`${options.receiptPath}.stdout`, result.stdout),
        stderrPath: keepStream(`${options.receiptPath}.stderr`, result.stderr),
      },
    });
  }

  writeReceipt(options.receiptPath, receipt);
  return { exitCode: statusExitCode(receipt.status), receipt };
}

// opencode's stream never names the served model. `opencode export` reads the
// session back from the local store and records provider, model, and variant.
async function verifiedOutput(
  options: RunnerOptions,
  parsed: ParsedOutput,
  executable: string,
  env: NodeJS.ProcessEnv,
  deadlineAt: number | null,
  cancellation: RunCancellation
): Promise<ParsedOutput> {
  if (parsed.sessionId === null) {
    if (verificationCommand(options.provider, "") === null) return parsed;
    throw new Error(`${options.provider} did not report a session id to verify the served model`);
  }
  const verification = verificationCommand(options.provider, parsed.sessionId);
  if (verification === null) return parsed;
  const result = await runProcess(
    executable,
    verification,
    options.cwd,
    env,
    "",
    deadlineAt,
    cancellation
  );
  if (result.cancelledBy !== null) {
    throw new VerificationInterrupted(
      "cancelled",
      `launcher received ${result.cancelledBy} during model verification`
    );
  }
  if (result.timedOut) {
    throw new VerificationInterrupted(
      "timed-out",
      `launcher exceeded the explicit ${options.timeoutMs}ms deadline during model verification`
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `model verification exited with status ${result.exitCode}: ${evidence(result.stderr)}`
    );
  }
  const exported = parseOpencodeExport(result.stdout);
  if (exported.variant !== options.effort) {
    throw new Error(
      `requested effort ${options.effort} was served as variant ${exported.variant ?? "none"}`
    );
  }
  return { ...parsed, reportedModel: exported.reportedModel };
}

export async function runLane(
  options: RunnerOptions,
  started: number = Date.now()
): Promise<RunResult> {
  validateOptions(options);
  const deadlineAt = options.timeoutMs === null ? null : started + options.timeoutMs;
  const invocation = invocationCommand(options);
  const preflight = preflightCommand(options.provider, options.model);
  const progress: LaneProgress = {
    executable: null,
    preflight: {
      argv: [preflight.command, ...preflight.args],
      status: "not-run",
      evidence: "",
    },
    argv: [invocation.command, ...invocation.args],
  };
  const cancellation = installRunCancellation();
  let streamFiles: ModelStreams | null = null;
  try {
    streamFiles = reserveOutputs(options);
    try {
      return await executeLane(
        options,
        cancellation,
        started,
        deadlineAt,
        invocation,
        preflight,
        progress,
        streamFiles
      );
    } catch (error) {
      const completed = Date.now();
      const signal = cancellation.signal;
      const status: ReceiptStatus = signal !== null
        ? "cancelled"
        : deadlineAt !== null && completed >= deadlineAt
          ? "timed-out"
          : "child-failed";
      const message = error instanceof Error ? error.message : String(error);
      const terminalPreflight = progress.preflight.status === "not-run" && status !== "child-failed"
        ? { ...progress.preflight, status }
        : progress.preflight;
      const receipt = completeReceipt(options, {
        status,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date(completed).toISOString(),
        elapsedMs: completed - started,
        executable: progress.executable,
        preflight: terminalPreflight,
        argv: progress.argv,
        exitCode: null,
        signal: null,
        reportedModel: null,
        modelVerified: false,
        modelEvidence: null,
        sessionId: null,
        usage: null,
        costUsd: null,
        error: {
          message: status === "cancelled"
            ? `launcher received ${signal} after reserving output paths`
            : status === "timed-out"
              ? "explicit deadline elapsed after reserving output paths"
              : "launcher failed after reserving output paths",
          evidence: evidence(message),
        },
      });
      removeIfExists(options.outputPath);
      writeReceipt(options.receiptPath, receipt);
      return { exitCode: statusExitCode(status), receipt };
    }
  } finally {
    cancellation.dispose();
    if (streamFiles !== null) {
      closeSync(streamFiles.stdout);
      closeSync(streamFiles.stderr);
    }
  }
}

export function resolvedOptions(options: RunnerOptions): RunnerOptions {
  return {
    ...options,
    promptPath: resolve(options.promptPath),
    cwd: resolve(options.cwd),
    outputPath: resolve(options.outputPath),
    receiptPath: resolve(options.receiptPath),
  };
}

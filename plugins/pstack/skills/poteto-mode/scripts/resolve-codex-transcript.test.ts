import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const RESOLVER = join(import.meta.dir, "resolve-codex-transcript.ts");
const LAUNCHER = join(import.meta.dir, "resolve-codex-transcript");
const CHAT = "00000000-1111-2222-3333-444444444444";
const OTHER = "00000000-1111-2222-3333-555555555555";
const OPENING = "Reflect on this synthetic request.";

type Json = Record<string, unknown>;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const metadata = (chat = CHAT): Json => ({ type: "session_meta", payload: { id: chat } });
const user = (text = OPENING): Json => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});

let root: string;
let home: string;
let rollout: string;

function writeRecords(records: Json[], path = rollout): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record) + "\n").join(""));
}

function index(name = "state_5.sqlite", rows: [string, string][] = [[CHAT, rollout]]): void {
  const database = new Database(join(home, name));
  database.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  for (const row of rows) database.run("INSERT INTO threads VALUES (?, ?)", row);
  database.close();
}

function setRolloutPath(path: string): void {
  const database = new Database(join(home, "state_5.sqlite"));
  database.run("UPDATE threads SET rollout_path = ?", [path]);
  database.close();
}

function run(args: string[] = [CHAT], env: Record<string, string | undefined> = { CODEX_HOME: home }) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) environment[key] = value;
  }
  const result = Bun.spawnSync(["bun", RESOLVER, ...args], { env: environment });
  const stdout = result.stdout.toString();
  expect(result.stderr.toString()).toBe("");
  expect(stdout.length).toBeLessThan(5000);
  return { code: result.exitCode, result: JSON.parse(stdout) as Json };
}

function expectUnresolved(reason: string, args?: string[]): void {
  const { code, result } = run(args);
  expect(result).toEqual({ status: "unresolved", reason, fallback: "session_digest" });
  expect(code).toBe(1);
}

function snapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(home, { recursive: true }) as string[]) {
    const path = join(home, name);
    try {
      files[relative(home, path)] = readFileSync(path).toString("base64");
    } catch {
      // Directories have no bytes to compare.
    }
  }
  return files;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pstack reflect ")));
  home = join(root, "codex # redirected home");
  rollout = join(home, "sessions/2026/10/05/known.jsonl");
  mkdirSync(home);
  writeRecords([metadata(), user()]);
  index();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolve-codex-transcript", () => {
  it("finds the opening message after metadata in a redirected home without writing", () => {
    writeRecords([
      metadata(),
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { type: "message", role: "developer", content: [] } },
      user(),
    ]);
    const before = snapshot();
    const { code, result } = run();
    expect(code).toBe(0);
    expect(result).toEqual({
      status: "resolved",
      chat_id: CHAT,
      path: rollout,
      opening_user_message: {
        line: 4,
        record_type: "response_item",
        characters: OPENING.length,
        sha256: sha256(OPENING),
      },
    });
    expect(JSON.stringify(result)).not.toContain(OPENING);
    expect(snapshot()).toEqual(before);
  });

  it("skips injected AGENTS.md and environment context, including the real header", () => {
    const agents = user("# AGENTS.md instructions for /work/repo\n\n<INSTRUCTIONS>\nPrivate\n</INSTRUCTIONS>");
    const legacy = user("# AGENTS.md instructions\n<INSTRUCTIONS>Private</INSTRUCTIONS>");
    (legacy.payload as { content: Json[] }).content.push({
      type: "input_text",
      text: "<environment_context>private</environment_context>",
    });
    writeRecords([metadata(), agents, legacy, user()]);
    const { code, result } = run();
    expect(code).toBe(0);
    expect((result.opening_user_message as Json).line).toBe(4);
  });

  it("does not treat a user message that only mentions AGENTS.md as injected context", () => {
    writeRecords([metadata(), user("# AGENTS.md instructions are wrong here")]);
    const { result } = run();
    expect((result.opening_user_message as Json).sha256).toBe(
      sha256("# AGENTS.md instructions are wrong here")
    );
  });

  it("uses $HOME/.codex when CODEX_HOME is unset or empty", () => {
    symlinkSync(home, join(root, ".codex"));
    for (const value of [undefined, ""]) {
      const { code, result } = run([CHAT], { HOME: root, CODEX_HOME: value });
      expect(code).toBe(0);
      expect(result.path).toBe(rollout);
    }
  });

  it("looks up only the exact known chat ID", () => {
    unlinkSync(join(home, "state_5.sqlite"));
    index("state_5.sqlite", [
      [OTHER, join(root, "unrelated-private.jsonl")],
      [CHAT + "suffix", join(root, "another-private.jsonl")],
      [CHAT, rollout],
    ]);
    const { code, result } = run();
    expect(code).toBe(0);
    expect(result.chat_id).toBe(CHAT);
    expectUnresolved("chat_missing", ["00000000-1111-2222-3333-666666666666"]);
  });

  it("ignores unrelated databases and tables", () => {
    const other = new Database(join(home, "logs_2.sqlite"));
    other.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    other.close();
    const unrelated = new Database(join(home, "state_4.sqlite"));
    unrelated.run("CREATE TABLE unrelated (private_value TEXT)");
    unrelated.run("INSERT INTO unrelated VALUES ('unrelated private sentinel')");
    unrelated.close();
    const { code, result } = run();
    expect(code).toBe(0);
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });

  it("rejects a missing index", () => {
    unlinkSync(join(home, "state_5.sqlite"));
    expectUnresolved("index_missing");
  });

  it("rejects an index without the threads schema", () => {
    unlinkSync(join(home, "state_5.sqlite"));
    const database = new Database(join(home, "state_5.sqlite"));
    database.run("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
    database.close();
    expectUnresolved("index_missing");
  });

  it("rejects a threads table whose id is not its key", () => {
    unlinkSync(join(home, "state_5.sqlite"));
    const database = new Database(join(home, "state_5.sqlite"));
    database.run("CREATE TABLE threads (id TEXT, rollout_path TEXT)");
    database.close();
    expectUnresolved("index_missing");
  });

  it("rejects ambiguous indexes", () => {
    index("state_6.sqlite");
    expectUnresolved("index_ambiguous");
  });

  it("rejects too many index files", () => {
    for (let number = 0; number < 8; number++) {
      writeFileSync(join(home, `state_x${number}.sqlite`), "");
    }
    expectUnresolved("index_count_budget");
  });

  it("rejects an unreadable index without exposing parse errors", () => {
    writeFileSync(join(home, "state_0.sqlite"), "unrelated private sentinel");
    expectUnresolved("index_unreadable");
  });

  it("rejects an index symlink that escapes the home", () => {
    const outside = join(root, "outside.sqlite");
    renameSync(join(home, "state_5.sqlite"), outside);
    symlinkSync(outside, join(home, "state_5.sqlite"));
    expectUnresolved("index_path_scope");
  });

  it("rejects malformed records without printing their bytes", () => {
    writeFileSync(rollout, JSON.stringify(metadata()) + '\n{"private sentinel":\n');
    expectUnresolved("rollout_malformed");
    for (const tail of [Buffer.from("[]\n"), Buffer.from([0xff, 0x0a])]) {
      writeFileSync(rollout, Buffer.concat([Buffer.from(JSON.stringify(metadata()) + "\n"), tail]));
      expectUnresolved("rollout_malformed");
    }
    writeFileSync(
      rollout,
      JSON.stringify(metadata()) +
        '\n{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"\\ud800"}]}}\n'
    );
    expectUnresolved("rollout_malformed");
  });

  it("rejects a rollout owned by another chat", () => {
    writeRecords([metadata(OTHER), user()]);
    expectUnresolved("rollout_owner_mismatch");
  });

  it("requires ownership before user content", () => {
    writeRecords([user()]);
    expectUnresolved("rollout_owner_unverified");
  });

  it("rejects rollout paths outside the home's sessions directory", () => {
    const outside = join(root, "private.jsonl");
    writeRecords([metadata(), user("unrelated private sentinel")], outside);
    setRolloutPath(outside);
    expectUnresolved("rollout_path_scope");
    const inHome = join(home, "archived_sessions/known.jsonl");
    writeRecords([metadata(), user()], inHome);
    setRolloutPath(inHome);
    expectUnresolved("rollout_path_scope");
    setRolloutPath("sessions/2026/10/05/known.jsonl");
    expectUnresolved("rollout_path_scope");
    setRolloutPath("/" + "x".repeat(4096));
    expectUnresolved("rollout_path_invalid");
  });

  it("rejects a rollout symlink that escapes the sessions directory", () => {
    const outside = join(root, "private.jsonl");
    renameSync(rollout, outside);
    symlinkSync(outside, rollout);
    expectUnresolved("rollout_path_scope");
  });

  it("bounds a rollout symlink loop", () => {
    unlinkSync(rollout);
    symlinkSync(rollout, rollout);
    expectUnresolved("rollout_unavailable");
  });

  it("accepts event user messages and joins text parts", () => {
    writeRecords([metadata(), { type: "event_msg", payload: { type: "user_message", message: OPENING } }]);
    expect((run().result.opening_user_message as Json).record_type).toBe("event_msg");
    const split = user("Reflect on ");
    (split.payload as { content: Json[] }).content.push({ type: "input_text", text: "this synthetic request." });
    writeRecords([metadata(), split]);
    expect((run().result.opening_user_message as Json).sha256).toBe(sha256(OPENING));
  });

  it("reports missing and unsupported opening messages", () => {
    writeRecords([metadata()]);
    expectUnresolved("opening_message_missing");
    writeRecords([metadata(), user("")]);
    expectUnresolved("opening_message_unsupported");
  });

  it("rejects an invalid chat ID and extra arguments", () => {
    expectUnresolved("chat_id_invalid", ["private title"]);
    expectUnresolved("usage", [CHAT, "--max-lines"]);
  });

  it("stops at 500 records", () => {
    const filler = { type: "event_msg", payload: { type: "token_count" } };
    writeRecords([metadata(), ...Array<Json>(498).fill(filler), user()]);
    expect((run().result.opening_user_message as Json).line).toBe(500);
    writeRecords([metadata(), ...Array<Json>(499).fill(filler), user()]);
    expectUnresolved("rollout_record_budget");
  });

  it("stops at a record over 256 KiB", () => {
    writeRecords([metadata(), { type: "event_msg", payload: { pad: "x".repeat(256 * 1024) } }, user()]);
    expectUnresolved("rollout_line_budget");
  });

  it("launches without the project's Bun config or .env", () => {
    const project = join(root, "project");
    const decoy = join(root, "decoy-home");
    const marker = join(root, "preload.ran");
    mkdirSync(project);
    mkdirSync(decoy);
    writeFileSync(join(project, "bunfig.toml"), 'preload = ["./project-preload.ts"]\n');
    writeFileSync(
      join(project, "project-preload.ts"),
      `await Bun.write(${JSON.stringify(marker)}, "ran");\nconsole.log("preload stdout");\n`
    );
    writeFileSync(join(project, ".env"), `CODEX_HOME=${decoy}\n`);
    symlinkSync(home, join(root, ".codex"));
    const env = { PATH: process.env.PATH!, HOME: root };
    const direct = Bun.spawnSync(["bun", RESOLVER, CHAT], { cwd: project, env });
    expect(existsSync(marker)).toBe(true);
    expect(direct.stdout.toString()).toContain("preload stdout");
    expect(direct.stdout.toString()).toContain('"reason":"index_missing"');
    rmSync(marker);
    const launched = Bun.spawnSync([LAUNCHER, CHAT], { cwd: project, env });
    expect(launched.stderr.toString()).toBe("");
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(launched.stdout.toString())).toMatchObject({ status: "resolved", path: rollout });
    expect(launched.exitCode).toBe(0);
  });

  it("stops at 2 MiB in total", () => {
    const record = { type: "event_msg", payload: { pad: "x".repeat(250 * 1024) } };
    writeRecords([metadata(), ...Array<Json>(9).fill(record), user()]);
    expectUnresolved("rollout_byte_budget");
  });
});

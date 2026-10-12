#!/usr/bin/env bun
// Resolve one known Codex chat ID to its rollout file and opening user message
// metadata. Prints bounded JSON and never prints transcript text.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";

const MAX_INDEXES = 8;
const MAX_PATH = 4096;
const MAX_RECORDS = 500;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const CHAT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const INDEX_NAME = /^state_[^/]*\.sqlite$/;

class Unresolved extends Error {}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codexHome(): string {
  try {
    return realpathSync(process.env.CODEX_HOME || join(homedir(), ".codex"));
  } catch {
    throw new Unresolved("config_home_unavailable");
  }
}

function indexFiles(home: string): string[] {
  let names: string[];
  try {
    names = readdirSync(home).filter((name) => INDEX_NAME.test(name)).sort();
  } catch {
    throw new Unresolved("index_directory_unavailable");
  }
  if (names.length > MAX_INDEXES) throw new Unresolved("index_count_budget");
  return names.map((name) => {
    try {
      const path = realpathSync(join(home, name));
      if (dirname(path) !== home || !statSync(path).isFile()) {
        throw new Unresolved("index_path_scope");
      }
      return path;
    } catch (error) {
      if (error instanceof Unresolved) throw error;
      throw new Unresolved("index_unreadable");
    }
  });
}

// The index is the `threads` table keyed by `id` alone, with a `rollout_path` column.
function threadIndex(database: Database): boolean {
  const columns = database.query("PRAGMA table_info(threads)").all() as {
    name: string;
    pk: number;
  }[];
  const id = columns.find((column) => column.name === "id");
  return (
    id?.pk === 1 &&
    columns.every((column) => column.pk === 0 || column === id) &&
    columns.some((column) => column.name === "rollout_path")
  );
}

function indexedRollout(home: string, chatId: string): string {
  const databases: Database[] = [];
  try {
    const indexes: Database[] = [];
    for (const path of indexFiles(home)) {
      const database = new Database(path, { readonly: true });
      databases.push(database);
      if (threadIndex(database)) indexes.push(database);
    }
    if (indexes.length === 0) throw new Unresolved("index_missing");
    if (indexes.length > 1) throw new Unresolved("index_ambiguous");
    const row = indexes[0]!
      .query("SELECT rollout_path FROM threads WHERE id = ?1")
      .get(chatId) as { rollout_path: unknown } | null;
    if (!row) throw new Unresolved("chat_missing");
    const rollout = row.rollout_path;
    if (typeof rollout !== "string" || !rollout || rollout.length > MAX_PATH) {
      throw new Unresolved("rollout_path_invalid");
    }
    return rollout;
  } catch (error) {
    if (error instanceof Unresolved) throw error;
    throw new Unresolved("index_unreadable");
  } finally {
    for (const database of databases) database.close();
  }
}

function scopedRollout(home: string, indexed: string): string {
  if (!isAbsolute(indexed)) throw new Unresolved("rollout_path_scope");
  let path: string;
  let sessions: string;
  try {
    path = realpathSync(indexed);
    sessions = realpathSync(join(home, "sessions"));
  } catch {
    throw new Unresolved("rollout_unavailable");
  }
  if (!path.startsWith(sessions + sep)) throw new Unresolved("rollout_path_scope");
  try {
    if (!path.endsWith(".jsonl") || path.length > MAX_PATH || !statSync(path).isFile()) {
      throw new Unresolved("rollout_path_invalid");
    }
  } catch (error) {
    if (error instanceof Unresolved) throw error;
    throw new Unresolved("rollout_unavailable");
  }
  return path;
}

// Returns the user text and its parts, or null when the record is not user input.
function userText(record: JsonObject): { text: string; parts: string[] } | null {
  const payload = record.payload;
  if (!isObject(payload)) return null;
  if (record.type === "event_msg" && payload.type === "user_message") {
    const text = payload.message;
    if (typeof text !== "string" || !text.trim()) {
      throw new Unresolved("opening_message_unsupported");
    }
    return { text, parts: [text] };
  }
  if (record.type !== "response_item" || payload.role !== "user") return null;
  if (payload.type !== "message" || !Array.isArray(payload.content)) {
    throw new Unresolved("opening_message_unsupported");
  }
  const parts: string[] = [];
  for (const part of payload.content) {
    if (!isObject(part)) throw new Unresolved("opening_message_unsupported");
    if (part.type === "input_text" || part.type === "text") {
      if (typeof part.text !== "string") throw new Unresolved("opening_message_unsupported");
      parts.push(part.text);
    }
  }
  const text = parts.join("");
  if (!text.trim()) throw new Unresolved("opening_message_unsupported");
  return { text, parts };
}

// Codex injects AGENTS.md as `# AGENTS.md instructions for <dir>` and the environment as a
// tagged block, both in user-role records ahead of the actual request.
function injectedContext(parts: string[]): boolean {
  return parts.every(
    (part) =>
      (/^# AGENTS\.md instructions(?: for [^\n]*)?\n/.test(part) &&
        part.includes("<INSTRUCTIONS>")) ||
      part.startsWith("<environment_context>")
  );
}

// Reads one byte past the total limit so an oversized file is detected, not truncated.
function readPrefix(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length);
  } catch {
    throw new Unresolved("rollout_unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function parseRecord(raw: Buffer): JsonObject | null {
  let record: unknown;
  try {
    const text = decoder.decode(raw);
    if (!text.trim()) return null;
    record = JSON.parse(text);
  } catch {
    throw new Unresolved("rollout_malformed");
  }
  if (!isObject(record)) throw new Unresolved("rollout_malformed");
  return record;
}

function openingMessage(path: string, chatId: string) {
  const buffer = readPrefix(path);
  let owned = false;
  let consumed = 0;
  for (let line = 1; line <= MAX_RECORDS; line++) {
    const allowance = Math.min(MAX_RECORD_BYTES, MAX_BYTES - consumed);
    if (allowance <= 0) throw new Unresolved("rollout_byte_budget");
    if (consumed === buffer.length) throw new Unresolved("opening_message_missing");
    const newline = buffer.indexOf(0x0a, consumed);
    const end = newline === -1 ? buffer.length : newline + 1;
    if (end - consumed > allowance) {
      throw new Unresolved(
        allowance === MAX_RECORD_BYTES ? "rollout_line_budget" : "rollout_byte_budget"
      );
    }
    const record = parseRecord(buffer.subarray(consumed, end));
    consumed = end;
    if (!record) continue;
    if (record.type === "session_meta") {
      if (!isObject(record.payload) || record.payload.id !== chatId) {
        throw new Unresolved("rollout_owner_mismatch");
      }
      owned = true;
    }
    const candidate = userText(record);
    if (!candidate) continue;
    if (!owned) throw new Unresolved("rollout_owner_unverified");
    if (injectedContext(candidate.parts)) continue;
    if (!candidate.text.isWellFormed()) throw new Unresolved("rollout_malformed");
    return {
      line,
      record_type: record.type,
      characters: [...candidate.text].length,
      sha256: createHash("sha256").update(candidate.text, "utf8").digest("hex"),
    };
  }
  throw new Unresolved("rollout_record_budget");
}

function resolve(chatId: string) {
  if (!CHAT_ID.test(chatId)) throw new Unresolved("chat_id_invalid");
  const home = codexHome();
  const path = scopedRollout(home, indexedRollout(home, chatId));
  return {
    status: "resolved",
    chat_id: chatId,
    path,
    opening_user_message: openingMessage(path, chatId),
  };
}

const args = process.argv.slice(2);
try {
  if (args.length !== 1) throw new Unresolved("usage");
  console.log(JSON.stringify(resolve(args[0]!)));
} catch (error) {
  const reason = error instanceof Unresolved ? error.message : "internal_error";
  console.log(JSON.stringify({ status: "unresolved", reason, fallback: "session_digest" }));
  process.exitCode = 1;
}

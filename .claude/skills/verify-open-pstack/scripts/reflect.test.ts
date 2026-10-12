import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recipe, type Case, type Fixture } from '../features/recipes.ts';
import { command } from './io.ts';
import { parseSession } from './harness.ts';
import type { Harness, SessionRecord } from './types.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const chat = '00000000-1111-2222-3333-444444444444';

async function fixture(harness: Harness): Promise<Fixture> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pstack-reflect-recipe-'))); roots.push(dir);
  const workspace = resolve(import.meta.dir, '../../../..');
  return { harness, dir, workspace, location: join(workspace, 'plugins/pstack'), configHome: dir, run: command };
}

const home = (f: Fixture) => join(f.dir, 'transcript-home');
const claudeTranscript = (f: Fixture) => join(home(f), 'projects/fixture/known.jsonl');
const launcher = (f: Fixture) => join(f.location, 'skills/poteto-mode/scripts/resolve-codex-transcript');
const lookup = (f: Fixture) => `CODEX_HOME=${home(f)} ${launcher(f)} ${chat}`;
const tool = (name: string, input: Record<string, any>, result: string | undefined, failed = false): SessionRecord['tools'][number] =>
  ({ name, id: 'item_1', input, result, parent: null, failed });

/** Runs the installed launcher as a session would, returning the stdout the harness captures. */
async function launch(f: Fixture): Promise<string> {
  const child = Bun.spawn([launcher(f), chat], { env: { ...process.env, CODEX_HOME: home(f) }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0); expect(stderr).toBe('');
  return stdout;
}

/** Does what a passing session does: Codex runs the launcher, Claude reads the transcript and writes its report. */
async function simulatedRecord(f: Fixture, available: boolean): Promise<SessionRecord> {
  let tools: SessionRecord['tools'];
  if (f.harness === 'codex') {
    tools = [tool('command', { command: `/bin/zsh -lc '${lookup(f)}'` }, await launch(f))];
  } else {
    const opening = 'Reflect on the corrections in this disposable session.';
    await writeFile(join(f.dir, 'result.json'), JSON.stringify(available ? {
      status: 'resolved', path: claudeTranscript(f), opening_user_message: { line: 2, characters: opening.length, sha256: new Bun.CryptoHasher('sha256').update(opening).digest('hex') },
    } : { status: 'unresolved', reason: 'opening_message_mismatch', fallback: 'session_digest' }));
    tools = [tool('Bash', { command: `cat -n ${claudeTranscript(f)}` }, await readFile(claudeTranscript(f), 'utf8'))];
  }
  if (!available) await writeFile(join(f.dir, 'digest.md'), 'The requested opening is missing from this synthetic fixture.');
  return { harness: f.harness, exitCode: 0, started: Date.now() - 1000, skills: ['pstack:reflect'], commands: [], tools };
}

async function prepared(harness: Harness, index = 0): Promise<{ f: Fixture; c: Case; record: SessionRecord }> {
  const f = await fixture(harness), c = recipe('skill-invocation:reflect', harness)[index]!;
  await c.prepare!(f);
  return { f, c, record: await simulatedRecord(f, index === 0) };
}

test.each(['claude', 'codex'] as const)('%s Reflect recipes verify the opening and the digest fallback rather than a generic result', async harness => {
  const cases = recipe('skill-invocation:reflect', harness);
  expect(cases.map(c => c.id)).toEqual(['locate-transcript', 'digest-fallback']);
  for (const index of [0, 1]) {
    const { f, c, record } = await prepared(harness, index), available = index === 0;
    expect((await c.assert(record, f)).assertions).toContain(available ? 'opening-verified' : 'digest-fallback');
    expect(c.prompt(f)).toContain(harness === 'claude' ? '/pstack:reflect' : '$pstack:reflect');
    await expect(c.assert({ ...record, skills: [] }, f)).rejects.toThrow('skill-not-loaded');
    await expect(c.assert({ ...record, tools: [] }, f)).rejects.toThrow(harness === 'codex' ? 'reflect-resolver-not-run' : 'reflect-transcript-not-read');
    if (available) {
      await writeFile(join(f.dir, 'digest.md'), 'An unneeded digest.');
      await expect(c.assert(record, f)).rejects.toThrow('reflect-unneeded-fallback');
    } else {
      for (const [content, reason] of [[' \n\t ', 'reflect-digest-empty'], ['', 'fixture-file-missing'], ['word '.repeat(2001), 'reflect-digest-budget']]) {
        await writeFile(join(f.dir, 'digest.md'), content!);
        await expect(c.assert(record, f)).rejects.toThrow(reason!);
      }
    }
  }
});

test('both Codex cases prepare in one fixture, each from a fresh index', async () => {
  const f = await fixture('codex'), [located, fallback] = recipe('skill-invocation:reflect', 'codex');
  await located!.prepare!(f);
  await fallback!.prepare!(f);
  await fallback!.assert(await simulatedRecord(f, false), f);
});

test.each(['claude', 'codex'] as const)('%s prompts name neither the resolver nor the per-run nonce', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), prompt = c.prompt(f);
    const nonce = harness === 'codex'
      ? (await readdir(join(home(f), 'sessions/2026/10/11')))[0]!.replace(/^rollout-|\.jsonl$/g, '')
      : JSON.parse((await readFile(claudeTranscript(f), 'utf8')).split('\n')[1]!).uuid;
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    for (const leak of [nonce, 'resolve-codex-transcript', 'poteto-mode/scripts', 'known.jsonl', 'state_5.sqlite']) expect(prompt).not.toContain(leak);
  }
});

test('Codex accepts the launcher or the script, installed or by realpath, however the command is spelled', async () => {
  const { f, c, record } = await prepared('codex'), output = record.tools[0]!.result!;
  const script = `${launcher(f)}.ts`;
  for (const commandText of [lookup(f), `bun ${script} ${chat}`, `cd /tmp && CODEX_HOME="${home(f)}" "${await realpath(launcher(f))}" ${chat} # lookup`,
    `/bin/bash -lc 'bun --no-env-file ${await realpath(script)} ${chat} 2>&1'`]) {
    await c.assert({ ...record, tools: [tool('command', { command: commandText }, output)] }, f);
  }
});

test('Codex rejects output from another fixture, another run, or a command that does not name the resolver', async () => {
  const { f, c, record } = await prepared('codex'), [good] = record.tools;
  const other = await prepared('codex');
  const stale = JSON.parse(good!.result!);
  await c.prepare!(f);
  for (const changed of [
    good!, tool('command', good!.input, other.record.tools[0]!.result),
    tool('command', { command: `echo '${JSON.stringify(stale)}'` }, good!.result), tool('command', { command: `cat ${f.dir}/report.json` }, good!.result),
    tool('command', good!.input, good!.result, true), tool('command', good!.input, 'not json'),
  ]) {
    await expect(c.assert({ ...record, tools: [changed] }, f)).rejects.toThrow('reflect-resolver-not-run');
  }
  // The rerun's own output still passes, so only the stale nonce path failed above.
  const fresh = await launch(f);
  await c.assert({ ...record, tools: [tool('command', good!.input, fresh)] }, f);
  await c.assert({ ...record, tools: [tool('command', good!.input, JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(fresh)).reverse())))] }, f);
});

test('Claude requires a completed parent tool result holding the opening user record in both cases', async () => {
  for (const index of [0, 1]) {
    const { f, c, record } = await prepared('claude', index), [read] = record.tools;
    const [metadata, user] = (await readFile(claudeTranscript(f), 'utf8')).trimEnd().split('\n');
    await c.assert({ ...record, tools: [tool('Read', { file_path: claudeTranscript(f) }, `1\t${metadata}\n2\t${user}`)] }, f);
    for (const changed of [
      tool('Read', { file_path: claudeTranscript(f), limit: 1 }, `1\t${metadata}`), tool('Bash', { command: 'echo opener' }, 'Reflect on the corrections in this disposable session.'),
      { ...read!, failed: true }, { ...read!, result: undefined }, { ...read!, parent: 'child-agent' },
    ]) {
      await expect(c.assert({ ...record, tools: [changed] }, f)).rejects.toThrow('reflect-transcript-not-read');
    }
    await c.prepare!(f);
    await expect(c.assert(record, f)).rejects.toThrow('reflect-transcript-not-read');
  }
});

test('Claude accepts a completed Bash read in the native stream and rejects a failed or pending one', async () => {
  const { f, c, record } = await prepared('claude'), content = await readFile(claudeTranscript(f), 'utf8');
  const events = (completed: boolean, failed: boolean) => [
    { type: 'user', isReplay: true, message: { content: '<command-name>/pstack:reflect</command-name>' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: `cat -n ${claudeTranscript(f)}` } }] } },
    ...completed ? [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash', is_error: failed, content }] } }] : [],
    { type: 'result', subtype: 'success', result: 'I read it and it passed.' },
  ].map(event => JSON.stringify(event)).join('\n');
  for (const [completed, failed] of [[false, false], [true, true]]) {
    await expect(c.assert(parseSession('claude', events(completed!, failed!), 0, record.started), f)).rejects.toThrow('reflect-transcript-not-read');
  }
  await c.assert(parseSession('claude', events(true, false), 0, record.started), f);
});

test('Codex requires a completed resolver command in the native stream and rejects failed, pending or claimed execution', async () => {
  const { f, c, record } = await prepared('codex'), { command: exact } = record.tools[0]!.input, output = record.tools[0]!.result!;
  const rollout = JSON.stringify({ type: 'response_item', payload: { content: [{ text: '<skill>\n<name>pstack:reflect</name>\n<path>/run/.codex/plugins/cache/open-pstack/pstack/test/skills/reflect/SKILL.md</path>' }] } });
  const item = (exit_code: number | null) => ({ id: 'item_1', type: 'command_execution', command: exact, aggregated_output: output, exit_code });
  for (const event of [
    { type: 'item.completed', item: item(1) }, { type: 'item.completed', item: item(null) }, { type: 'item.started', item: item(0) },
    { type: 'item.completed', item: { type: 'agent_message', text: `I ran ${exact} and it printed ${output}` } },
  ]) {
    await expect(c.assert(parseSession('codex', JSON.stringify(event), 0, record.started, rollout), f)).rejects.toThrow('reflect-resolver-not-run');
  }
  await c.assert(parseSession('codex', JSON.stringify({ type: 'item.completed', item: item(0) }), 0, record.started, rollout), f);
});

import { expect, test } from 'bun:test';
import { parse } from './cli.ts';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from './doctor.ts';
import type { Command } from './io.ts';
import type { GitHub } from './types.ts';
import { REPO } from './types.ts';
import { verify } from './verify.ts';
import { validateRegistry } from './core.ts';
import registry from '../features/registry.json';

test('publisher revision is recorded independently of candidate proof', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pstack-publisher-revision-')));
  const candidate = 'a'.repeat(40), base = 'b'.repeat(40), publisherRevision = 'c'.repeat(40);
  const github: GitHub = {
    async pull() { return { number: 111, head: { sha: candidate }, base: { sha: base }, state: 'open', headRepo: REPO }; },
    async files() { return [{ filename: 'README.md' }]; },
    async comment() { return `https://github.com/${REPO}/pull/111#issuecomment-1`; },
    async status() {},
  };
  try {
    const receipt = await verify({ pr: 111, selfTest: false, features: [], root, publisherRevision, registry: validateRegistry(registry), github,
      driver: { async preflight() { throw new Error('Docs must not check harness logins'); }, async prepare() { throw new Error('Docs must not prepare harnesses'); }, async exercise() { throw new Error('Docs must not exercise harnesses'); } }, persist: async () => {} });
    expect(receipt.sha).toBe(candidate);
    expect(receipt.publisherRevision).toBe(publisherRevision);
    expect(receipt.publisherRevision).not.toBe(receipt.sha);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('candidate mode is an explicit doctor-only flag', () => {
  expect(parse(['doctor', '--candidate', '--output', '/fresh/probe'])).toEqual({ mode: 'doctor', output: '/fresh/probe', pr: 0, selfTest: false, candidate: true });
  expect(() => parse(['doctor', '--candidate', '--candidate', '--output', '/fresh/probe'])).toThrow('Duplicate option');
  expect(() => parse(['run', '--candidate', '--pr', '111', '--output', '/fresh/run'])).toThrow('Unknown option');
});
test('candidate doctor probes only help and versions with private roots already present', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pstack-doctor-'))), calls: string[][] = [];
  const run: Command = async (args, options = {}) => {
    calls.push(args);
    const env = options.env!;
    expect(env.HOME === process.env.HOME).toBe(true);
    expect(env.USER === process.env.USER).toBe(true);
    expect(env.LOGNAME === process.env.LOGNAME).toBe(true);
    expect(env.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR).toBe(true);
    for (const key of ['TMPDIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'GH_CONFIG_DIR']) {
      expect(env[key]!.startsWith(root + '/probe-home')).toBe(true);
      const info = await stat(env[key]!);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    }
    return args.includes('--version') ? 'version' : '--plugin-dir --settings --setting-sources --json local path';
  };
  try {
    await doctor(root, run, 'darwin', true);
    const report = JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8'));
    expect(report.candidate).toBe(true); expect(report.result).toBe('pass');
    expect(calls.every(args => args.includes('--version') || args.includes('--help'))).toBe(true);
    expect(calls.some(args => args[0] === 'gh' || args.includes('auth') || args.includes('login'))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('run and parent doctor need no credential flags', () => {
  expect(parse(['doctor', '--output', '/fresh/probe'])).toEqual({ mode: 'doctor', output: '/fresh/probe', pr: 0, selfTest: false, candidate: false });
  expect(parse(['run', '--pr', '123', '--self-test', '--output', '/fresh/run'])).toEqual({ mode: 'run', output: '/fresh/run', pr: 123, selfTest: true, routes: [], features: [] });
  for (const args of [[], ['wat'], ['run', '--pr', '0', '--output', '/tmp/a'], ['run', '--pr', '1.5', '--output', '/tmp/a'], ['run', '--pr', '9007199254740992', '--output', '/tmp/a'], ['doctor', '--pr', '1', '--output', '/tmp/a'], ['doctor', '--output', '/tmp/a', '--output', '/tmp/b'], ['run', '--pr', '1'], ['doctor', '--output', '--self-test'], ['doctor', '--output', '/tmp/a', '--publish']]) expect(() => parse(args)).toThrow();
});
test('credential-directory and account options are removed', () => {
  for (const option of ['--claude-config', '--codex-home', '--claude-account', '--codex-account']) {
    for (const args of [['run', '--pr', '111'], ['doctor'], ['doctor', '--candidate']]) {
      expect(() => parse([...args, '--output', '/fresh/run', option, '/operator/config'])).toThrow(`Unknown option: ${option}`);
    }
  }
});
test('runner routes are explicit, repeatable, and distinct', () => {
  expect(parse(['run', '--pr', '1', '--runner-route', 'codex:gpt-6.1-sol@max', '--runner-route', 'codex:gpt-6.1-sol@ultra', '--output', '/fresh/run']))
    .toMatchObject({ routes: ['codex:gpt-6.1-sol@max', 'codex:gpt-6.1-sol@ultra'] });
  for (const args of [['--runner-route', 'gpt-6.1-sol'], ['--runner-route', 'codex:a@max', '--runner-route', 'codex:a@max']]) {
    expect(() => parse(['run', '--pr', '1', '--output', '/fresh/run', ...args])).toThrow();
  }
});

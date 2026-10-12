import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, isolatedEnv, retainedFile, save, session, sha256, treeHash } from './io.ts';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pstack-io-')));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('private values and retained file boundaries', () => {
  test('saves canonical private JSON unchanged with private permissions', async () => {
    const root = await fixture(), path = join(root, 'receipt.json');
    const evidence = { workspace: '/tmp/sk-review/live', nested: ['Bearer private",}', 'github_pat_sensitive'],
      checks: { explanation: 'sk-private' }, count: 2 };
    await save(path, evidence);
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(evidence, null, 2) + '\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('keeps private command errors unchanged', async () => {
    let failure: unknown;
    try { await command(['/bin/sh', '-c', "printf '%s' 'private sk-review diagnostic' >&2; exit 7"]); }
    catch (error) { failure = error; }
    expect(String(failure)).toBe('Error: /bin/sh failed: private sk-review diagnostic');
  });

  test('session recorder streams private output to files and keeps it on failure', async () => {
    const root = await fixture(), stdout = join(root, 'session.jsonl'), stderr = join(root, 'session.stderr');
    const code = await session(['/bin/sh', '-c', 'cat; printf partial; printf diagnostic >&2; exit 3'],
      { cwd: root, env: { PATH: process.env.PATH ?? '' }, input: 'prompt\n', stdout, stderr });
    expect(code).toBe(3);
    expect(await readFile(stdout, 'utf8')).toBe('prompt\npartial');
    expect(await readFile(stderr, 'utf8')).toBe('diagnostic');
    for (const path of [stdout, stderr]) expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(session(['/bin/true'], { cwd: root, env: {}, input: '', stdout, stderr })).rejects.toThrow('EEXIST');
  });

  test('uses real account metadata, run-owned config paths, and normal PATH', () => {
    const previous = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    process.env.HOME = '/Users/operator'; process.env.USER = 'operator-user'; process.env.LOGNAME = 'operator-login';
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
    try {
      expect(() => isolatedEnv('relative/home')).toThrow('absolute run-owned');
      const env = isolatedEnv('/run/home', 'claude');
      expect(env).toMatchObject({ HOME: '/Users/operator', USER: 'operator-user', LOGNAME: 'operator-login',
        PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/run/home/tmp', XDG_CONFIG_HOME: '/run/home/.config',
        XDG_CACHE_HOME: '/run/home/.cache', GH_CONFIG_DIR: '/run/home/.config/gh',
        CODEX_HOME: '/run/home/.codex' });
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(isolatedEnv('/run/home').CLAUDE_CONFIG_DIR).toBeUndefined();
      process.env.CLAUDE_CONFIG_DIR = '/Users/operator/custom-claude';
      for (const harness of ['claude', 'codex'] as const) {
        const inherited = isolatedEnv('/run/home', harness);
        expect(inherited.CLAUDE_CONFIG_DIR).toBe('/Users/operator/custom-claude');
        expect(inherited.CODEX_HOME).toBe('/run/home/.codex');
        for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(inherited[key]).toBeUndefined();
      }
      expect(env.PATH).not.toContain('/run/home/bin');
      process.env.HOME = 'relative/home';
      expect(() => isolatedEnv('/run/home')).toThrow('Real HOME must be absolute');
      process.env.HOME = '/Users/operator'; delete process.env.USER;
      expect(() => isolatedEnv('/run/home', 'codex')).toThrow('Real USER and LOGNAME are required');
    } finally {
      for (const name of ['HOME', 'USER', 'LOGNAME', 'PATH', 'CLAUDE_CONFIG_DIR'] as const) {
        if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
      }
    }
  });

  test('retains binary artifacts unchanged without inspecting copied secrets', async () => {
    const root = await fixture(), path = join(root, 'artifact.bin'), token = 'known-copied-binary-opaque-credential';
    const bytes = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from(token), Buffer.from([0, 254])]);
    await writeFile(path, bytes);
    expect(await retainedFile(root, path)).toEqual({ path: 'artifact.bin', sha256: sha256(bytes) });
    expect(Buffer.from(await readFile(path))).toEqual(bytes);
  });

  test('permits evidence below an ancestor named state and canonicalizes output aliases', async () => {
    const root = await fixture(), output = join(root, 'state', 'run'), alias = join(root, 'alias');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'transcript.txt'), 'native surface evidence');
    await symlink(output, alias);
    expect(await retainedFile(output, 'transcript.txt')).toEqual(await retainedFile(alias, 'transcript.txt'));
    expect((await retainedFile(alias, 'transcript.txt')).path).toBe('transcript.txt');
  });

  test('rejects this run state and aliases into it, but not another directory named state', async () => {
    const root = await fixture();
    await mkdir(join(root, 'state'));
    await mkdir(join(root, 'artifacts', 'state'), { recursive: true });
    await writeFile(join(root, 'state', 'secret.txt'), 'isolated authentication');
    await writeFile(join(root, 'artifacts', 'state', 'result.txt'), 'retained result');
    await symlink(join(root, 'state', 'secret.txt'), join(root, 'transcript.txt'));
    await expect(retainedFile(root, 'state')).rejects.toThrow('outside isolated state');
    await expect(retainedFile(root, 'state/secret.txt')).rejects.toThrow('outside isolated state');
    await expect(retainedFile(root, 'transcript.txt')).rejects.toThrow('outside isolated state');
    expect((await retainedFile(root, 'artifacts/state/result.txt')).path).toBe('artifacts/state/result.txt');
  });
});

describe('candidate tree digests', () => {
  test('dependency bootstrap is excluded only at explicitly supplied generated directories', async () => {
    const root = await fixture(), scripts = join(root, 'skills', 'poteto-mode', 'scripts');
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, 'bootstrap.ts'), 'export const candidate = 1;');
    const exclusions = ['skills/poteto-mode/scripts/node_modules'];
    const pinned = await treeHash(root, exclusions);
    const dependencies = join(scripts, 'node_modules');
    await mkdir(dependencies);
    await writeFile(join(dependencies, 'generated.js'), 'generated dependency');
    await symlink(join(dependencies, 'generated.js'), join(dependencies, 'package'));
    expect(await treeHash(root, exclusions)).toBe(pinned);
    await expect(treeHash(root)).rejects.toThrow('symlink refused');
    await writeFile(join(scripts, 'bootstrap.ts'), 'export const candidate = 2;');
    expect(await treeHash(root, exclusions)).not.toBe(pinned);
    await expect(treeHash(root, ['skills/poteto-mode/scripts'])).rejects.toThrow('Only explicit generated');
    await expect(treeHash(root, ['**/node_modules'])).rejects.toThrow('Only explicit generated');
  });

  test('source executable permissions affect the hash and non-excluded symlinks are rejected', async () => {
    const root = await fixture(), source = join(root, 'verify.sh');
    await writeFile(source, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const pinned = await treeHash(root);
    await chmod(source, 0o755);
    expect(await treeHash(root)).not.toBe(pinned);
    await symlink(source, join(root, 'alias.sh'));
    await expect(treeHash(root)).rejects.toThrow('symlink refused');
    const alias = join(await fixture(), 'tree');
    await symlink(root, alias);
    await expect(treeHash(alias)).rejects.toThrow('real directory');
  });
});

describe('coordinated process interruption', () => {
  test.each(['SIGINT', 'SIGTERM'] as const)('%s kills real process groups and permits only explicit cleanup commands', async signal => {
    const root = await fixture(), home = join(root, 'candidate'), credential = join(home, '.claude/.credentials.json');
    const vault = join(root, 'vault.json'), report = join(root, 'report.json'), heartbeat = join(root, 'heartbeat'), ready = join(root, 'ready.json');
    await mkdir(join(home, '.claude'), { recursive: true, mode: 0o700 });
    await writeFile(credential, 'disposable token', { mode: 0o600 });
    await writeFile(vault, 'original vault sentinel', { mode: 0o600 });
    const grandchild = join(root, 'grandchild.ts'), dummy = join(root, 'dummy.ts'), worker = join(root, 'worker.ts');
    await writeFile(grandchild, `let counter = 0; await Bun.write(${JSON.stringify(heartbeat)}, String(counter));\nsetInterval(() => Bun.write(${JSON.stringify(heartbeat)}, String(++counter)), 10);\n`);
    await writeFile(dummy, `const child = Bun.spawn([process.execPath, ${JSON.stringify(grandchild)}], { stdout: 'ignore', stderr: 'ignore' });\nwhile (!(await Bun.file(${JSON.stringify(heartbeat)}).exists())) await Bun.sleep(5);\nawait Bun.write(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, grandchild: child.pid }));\nsetInterval(() => {}, 1000);\n`);
    await writeFile(worker, `import { command, interruption, interruptCommands, save } from ${JSON.stringify(join(import.meta.dir, 'io.ts'))};
process.on('SIGINT', () => { void interruptCommands('SIGINT'); });
process.on('SIGTERM', () => { void interruptCommands('SIGTERM'); });
let failure = '', rejected = false;
try { await command([process.execPath, ${JSON.stringify(dummy)}]); }
catch (error) {
  failure = String(error);
  try { await command(['/bin/true']); } catch { rejected = true; }
} finally {
  await command(['/bin/rm', '-f', '--', ${JSON.stringify(credential)}], { allowInterrupted: true });
  await save(${JSON.stringify(report)}, { failure, rejected, aborted: interruption.signal.aborted });
  process.exitCode = 1;
}
`);
    const child = Bun.spawn([process.execPath, worker], { stdout: 'pipe', stderr: 'pipe' });
    const stderr = new Response(child.stderr).text(), stdout = new Response(child.stdout).text();
    try {
      for (let attempt = 0; attempt < 500 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(5);
      expect(await Bun.file(ready).exists()).toBe(true);
      child.kill(signal);
      expect(await child.exited).toBe(1);
      expect(await stderr).toBe(''); expect(await stdout).toBe('');
      expect(JSON.parse(await readFile(report, 'utf8'))).toEqual({ failure: `Error: Interrupted by ${signal}`, rejected: true, aborted: true });
      await expect(stat(credential)).rejects.toThrow('ENOENT');
      expect(await readFile(vault, 'utf8')).toBe('original vault sentinel');
      const stopped = await readFile(heartbeat, 'utf8');
      await Bun.sleep(100);
      expect(await readFile(heartbeat, 'utf8')).toBe(stopped);
    } finally {
      child.kill('SIGKILL');
      if (await Bun.file(ready).exists()) {
        const { pid } = JSON.parse(await readFile(ready, 'utf8'));
        try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await child.exited;
    }
  }, 10000);
});

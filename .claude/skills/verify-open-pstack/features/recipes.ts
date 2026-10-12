// Headless recipes for every selectable feature. The trusted parent runs each case as one fresh
// native session and evaluates `assert` against the parsed record and the fixture it created.
import { Database } from 'bun:sqlite';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sha256, type Command } from '../scripts/io.ts';
import type { Harness, SessionRecord } from '../scripts/types.ts';

export interface Fixture {
  harness: Harness;
  /** Fresh disposable directory shared by the feature's cases; the session cwd unless a case says otherwise. */
  dir: string;
  workspace: string;
  /** Candidate plugin root as the harness loads it. */
  location: string;
  /** Directory setup-pstack writes for this harness. */
  configHome: string;
  /** Runs fixture preparation with the candidate environment. */
  run: Command;
}
export interface Evidence { assertions: string[]; files: string[] }
export interface Case {
  id: string;
  cwd?: 'workspace';
  /** Codex parents that launch external provider CLIs need network and their CLI state outside the fixture. */
  codexSandbox?: 'danger-full-access';
  /** Claude refuses Write into its own config folder in dontAsk mode even with --add-dir; setup must write there. */
  claudePermission?: 'bypassPermissions';
  prepare?(fixture: Fixture): Promise<void>;
  prompt(fixture: Fixture): string;
  assert(record: SessionRecord, fixture: Fixture): Promise<Evidence>;
}

/** Claude tools pre-authorized for every case; anything else is denied without a prompt and fails the case. */
export const CLAUDE_TOOLS = 'Skill,Read,Glob,Grep,Write,Edit,Bash,Agent,Task,TodoWrite';
export const DEFAULT_ROUTES: Record<Harness, string> = { claude: 'codex:gpt-6.1-sol@max', codex: 'claude:opus@max' };
export const ROUTE = /^(claude|codex|grok):([A-Za-z0-9._-]+)@([a-z]+)$/;
const SETUP_DESCRIPTOR = 'claude:opus@high';

const rules = (dir: string): string => `Work only inside ${dir}. Do not push, post, open, merge, or modify pull requests, issues, or remote branches, and do not write outside ${dir}. Do not edit any skill, plugin, or configuration file outside ${dir}. Do not ask questions: where the skill would ask, choose its documented default and continue. This is a headless session that ends at your first final reply and stops any background work still running, so run every command and subagent in the foreground, even where the skill says to use the background, and finish all work before you reply.`;

export function invoke(harness: Harness, skill: string, text: string): string {
  if (harness === 'codex') return `$pstack:${skill} ${text}`;
  return skill.startsWith('principle-') ? `Load the skill pstack:${skill} with your Skill tool and follow it. ${text}` : `/pstack:${skill} ${text}`;
}

function loaded(record: SessionRecord, skill: string): string {
  if (!record.skills.includes(skill)) throw new Error(`skill-not-loaded:${skill}`);
  return 'skill-loaded';
}

async function written(record: SessionRecord, path: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || !info.size || info.mtimeMs < record.started) throw new Error(`fixture-file-missing:${basename(path)}`);
  return `file:${basename(path)}`;
}

async function git(fixture: Fixture, ...args: string[]): Promise<string> {
  return fixture.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: fixture.dir });
}

async function files(dir: string, contents: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(contents)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
}

const TASK = {
  'README.md': '# Fixture\n\nA tiny module used to exercise one pstack skill.\n',
  'TASK.md': 'sum(2, 3) returns -1 instead of 5. Find the cause and propose the smallest fix.\n',
  'sum.mjs': 'export function sum(a, b) {\n  return a - b;\n}\n',
  'sum.test.mjs': "import { sum } from './sum.mjs';\nif (sum(2, 3) !== 5) throw new Error('sum(2, 3) should be 5');\n",
  'ci.sh': '#!/bin/sh\nbun sum.test.mjs\n',
};

async function taskRepository(fixture: Fixture): Promise<void> {
  await files(fixture.dir, TASK);
  await git(fixture, 'init', '-q', '-b', 'main');
  await git(fixture, 'add', '.');
  await git(fixture, 'commit', '-qm', 'Add sum module');
}

function skillCase(skill: string, request: string, check?: (record: SessionRecord, fixture: Fixture) => Promise<Evidence>, prepare: (fixture: Fixture) => Promise<void> = taskRepository): Case {
  return {
    id: 'invoke',
    prepare,
    prompt: f => `${invoke(f.harness, skill, `${request.replaceAll('$DIR', f.dir)} Write the skill's result to ${join(f.dir, 'result.md')}.`)} ${rules(f.dir)}`,
    async assert(record, f) {
      const assertions = [loaded(record, `pstack:${skill}`), await written(record, join(f.dir, 'result.md'))], paths = [join(f.dir, 'result.md')];
      if (check) { const extra = await check(record, f); assertions.push(...extra.assertions); paths.push(...extra.files); }
      return { assertions, files: paths };
    },
  };
}

async function ciFixed(_record: SessionRecord, f: Fixture): Promise<Evidence> {
  if (!/return\s+a\s*\+\s*b/.test(await readFile(join(f.dir, 'sum.mjs'), 'utf8'))) throw new Error('ci-not-fixed:sum.mjs');
  return { assertions: ['fixed:sum.mjs'], files: [join(f.dir, 'sum.mjs')] };
}

const overrides: Record<string, Case> = {
  'fix-ci': skillCase('fix-ci', 'There is no pull request or remote. The failing CI check is the local command `sh ci.sh` in $DIR. Fix it locally and do not push.', ciFixed),
  babysit: skillCase('babysit', 'The pull request is the local `main` branch of the repository at $DIR; there is no remote. Its one failing check is the local command `sh ci.sh`. Do exactly one babysit pass: fix the failing check locally, push nothing, change nothing remote, then stop instead of watching.', ciFixed),
  'make-pr-easy-to-review': skillCase('make-pr-easy-to-review', 'The pull request is the local branch `feature` against `main` in $DIR; there is no remote. Do not rewrite history or push; write reviewer guidance only.', async (_record, f) => {
    if ((await git(f, 'rev-parse', 'feature')).trim() !== (await readFile(`${f.dir}.head`, 'utf8')).trim()) throw new Error('history-rewritten:feature');
    return { assertions: ['history-unchanged'], files: [] };
  }, async f => {
    await taskRepository(f);
    await git(f, 'checkout', '-qb', 'feature');
    await writeFile(join(f.dir, 'sum.mjs'), 'export function sum(a, b) {\n  return a + b;\n}\n'); await git(f, 'commit', '-qam', 'wip');
    await writeFile(join(f.dir, 'README.md'), '# Fixture\n\nA tiny sum module.\n'); await git(f, 'commit', '-qam', 'fix typo');
    await writeFile(`${f.dir}.head`, await git(f, 'rev-parse', 'feature'));
  }),
  'automate-me': {
    id: 'invoke',
    prompt: f => `${invoke(f.harness, 'automate-me', `My handle is fixture. There is no history to mine for this workspace, so skip mining. My answers to your questions: concise replies, and verify with tests before claiming done. Write the drafted skill to ${join(f.dir, '.claude/skills/fixture-mode/SKILL.md')}.`)} ${rules(f.dir)}`,
    async assert(record, f) {
      const path = join(f.dir, '.claude/skills/fixture-mode/SKILL.md'), assertions = [loaded(record, 'pstack:automate-me'), await written(record, path)];
      if (!/name:\s*fixture-mode/.test(await readFile(path, 'utf8'))) throw new Error('mode-skill-unnamed');
      return { assertions: [...assertions, 'mode-skill'], files: [path] };
    },
  },
};

const REFLECT_CHAT = '00000000-1111-2222-3333-444444444444';
const REFLECT_OPENING = 'Reflect on the corrections in this disposable session.';
const REFLECT_UNRELATED = 'An unrelated synthetic opening.';
const RESOLVER = 'skills/poteto-mode/scripts/resolve-codex-transcript';

function parseJson(text: string | undefined): unknown {
  try { return JSON.parse(text ?? ''); } catch { return undefined; }
}

function reflect(harness: Harness): Case[] {
  return [true, false].map(available => {
    const home = (f: Fixture) => join(f.dir, 'transcript-home');
    // A per-run nonce keeps a transcript path or record the prompt never names: Codex in the
    // rollout's file name, Claude on the opening user record.
    let nonce = '';
    const transcript = (f: Fixture) => join(home(f), harness === 'codex' ? `sessions/2026/10/11/rollout-${nonce}.jsonl` : 'projects/fixture/known.jsonl');
    const index = (f: Fixture) => join(home(f), 'state_5.sqlite');
    const report = (f: Fixture) => join(f.dir, 'result.json');
    const digest = (f: Fixture) => join(f.dir, 'digest.md');
    const text = available ? REFLECT_OPENING : REFLECT_UNRELATED;
    return {
      id: available ? 'locate-transcript' : 'digest-fallback',
      async prepare(f) {
        nonce = crypto.randomUUID();
        const records = harness === 'codex' ? [
          { type: 'session_meta', payload: { id: REFLECT_CHAT } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${f.dir}\n\n<INSTRUCTIONS>\nFixture only.\n</INSTRUCTIONS>` }] } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
        ] : [{ type: 'system', subtype: 'fixture_metadata' }, { type: 'user', uuid: nonce, message: { role: 'user', content: [{ type: 'text', text }] } }];
        await files(f.dir, { [transcript(f).slice(f.dir.length + 1)]: records.map(record => JSON.stringify(record)).join('\n') + '\n' });
        if (harness === 'codex') {
          await rm(index(f), { force: true });
          const database = new Database(index(f));
          database.run('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
          database.run('INSERT INTO threads VALUES (?, ?)', [REFLECT_CHAT, transcript(f)]);
          database.close();
        }
      },
      prompt(f) {
        const request = `Exercise only step 1 with this disposable synthetic fixture. Do not fan out reviewers, apply edits, or inspect real chats. The conversation's opening prompt to verify is ${JSON.stringify(REFLECT_OPENING)}. `;
        const where = harness === 'codex'
          ? `The fixture's known parent chat ID is ${REFLECT_CHAT}. Run the transcript lookup with CODEX_HOME set to ${home(f)} for that command only. `
          : `For this fixture, the system-named per-project transcript directory is ${join(home(f), 'projects/fixture')}. Write only JSON to ${report(f)}: when a transcript verifies, its status "resolved", path, and opening_user_message with line, characters, and sha256; otherwise status "unresolved", reason "opening_message_mismatch", and fallback "session_digest". Do not include message text in ${report(f)}. `;
        return `${invoke(harness, 'reflect', `${request}${where}If the transcript cannot be verified, write the session digest, at most 2,000 words and covering only this fixture request, to ${digest(f)}.`)} ${rules(f.dir)}`;
      },
      async assert(record, f) {
        const assertions = [loaded(record, 'pstack:reflect')];
        const paths: string[] = [];
        if (harness === 'codex') {
          // Both cases resolve the chat; only the opener it reports differs. The output is the harness's capture.
          const expected = { status: 'resolved', chat_id: REFLECT_CHAT, path: transcript(f),
            opening_user_message: { line: 3, record_type: 'response_item', characters: text.length, sha256: sha256(text) } };
          const installed = [RESOLVER, `${RESOLVER}.ts`].map(path => join(f.location, path));
          const names = [...installed, ...await Promise.all(installed.map(path => realpath(path)))];
          const output = record.tools.find(tool => tool.name === 'command' && !tool.failed && names.some(name => tool.input.command.includes(name)) &&
            Bun.deepEquals(parseJson(tool.result), expected))?.result;
          if (output === undefined) throw new Error('reflect-resolver-not-run');
          const retained = join(f.dir, 'resolver-output.json');
          await writeFile(retained, output);
          paths.push(retained); assertions.push('resolver-ran');
        } else {
          if (!record.tools.some(tool => tool.parent === null && !tool.failed && tool.result?.includes(nonce))) throw new Error('reflect-transcript-not-read');
          assertions.push(await written(record, report(f)));
          if ((await lstat(report(f))).size > 5000) throw new Error('reflect-result-budget');
          const result = JSON.parse(await readFile(report(f), 'utf8')), opening = result.opening_user_message;
          if (available ? result.status !== 'resolved' || result.path !== transcript(f) || opening?.line !== 2 ||
              opening?.characters !== REFLECT_OPENING.length || opening?.sha256 !== sha256(REFLECT_OPENING)
            : result.status !== 'unresolved' || result.reason !== 'opening_message_mismatch' || result.fallback !== 'session_digest' ||
              result.path !== undefined) throw new Error(available ? 'reflect-opening-mismatch' : 'reflect-fallback-mismatch');
          paths.push(report(f));
        }
        if (available) {
          if (await lstat(digest(f)).catch(() => undefined)) throw new Error('reflect-unneeded-fallback');
          assertions.push('opening-verified');
        } else {
          assertions.push(await written(record, digest(f)));
          const words = (await readFile(digest(f), 'utf8')).trim();
          if (!words) throw new Error('reflect-digest-empty');
          if (words.split(/\s+/).length > 2000) throw new Error('reflect-digest-budget');
          paths.push(digest(f)); assertions.push('digest-fallback');
        }
        return { assertions, files: paths };
      },
    };
  });
}

export async function verifyProjectDoctor(texts: string[], workspace: string): Promise<void> {
  const expected = await realpath(join(workspace, '.claude/skills/verify-open-pstack'));
  for (const text of texts) {
    try {
      const d = JSON.parse(text);
      if (d.result === 'pass' && d.candidate === true && typeof d.skill === 'string' && await realpath(d.skill) === expected) return;
    } catch { /* Other retained files need not be doctor reports. */ }
  }
  throw new Error('Self-test requires the pinned project skill\'s passing child doctor.json');
}

const projectSkill: Case = {
  id: 'doctor',
  cwd: 'workspace',
  prompt: f => `${f.harness === 'claude' ? '/verify-open-pstack' : '$verify-open-pstack'} Run exactly this command and nothing else: ${join(f.workspace, '.claude/skills/verify-open-pstack/scripts/verify.sh')} doctor --candidate --output ${join(f.dir, 'doctor')}. Do not run verify.sh run, log in, or publish anything.`,
  async assert(record, f) {
    const skill = await realpath(join(f.workspace, '.claude/skills/verify-open-pstack/SKILL.md'));
    const found = f.harness === 'claude' ? record.skills.includes('verify-open-pstack')
      : (await Promise.all(record.skills.map(path => realpath(path).catch(() => '')))).includes(skill);
    if (!found) throw new Error('skill-not-loaded:verify-open-pstack');
    if (!record.commands.some(c => c.includes('verify.sh') && c.includes('doctor --candidate'))) throw new Error('doctor-not-run');
    const report = join(f.dir, 'doctor/doctor.json');
    await verifyProjectDoctor([await readFile(report, 'utf8')], f.workspace);
    return { assertions: ['skill-loaded', 'doctor-ran', 'doctor-canonical-pass'], files: [report] };
  },
};

function runner(harness: Harness, routes: string[]): Case[] {
  const chosen = routes.filter(route => !route.startsWith(`${harness}:`));
  return (chosen.length ? chosen : [DEFAULT_ROUTES[harness]]).map((route, index) => {
    const [, provider, model, effort] = ROUTE.exec(route)!, lane = (f: Fixture, name: string) => join(f.dir, `lane-${index + 1}.${name}`);
    return {
      id: `route-${index + 1}`,
      codexSandbox: 'danger-full-access',
      prepare: async f => { await writeFile(lane(f, 'prompt.md'), 'Reply with the single word PONG.\n'); },
      prompt: f => `${invoke(f.harness, 'poteto-mode', `Dispatch exactly one external lane and nothing else. Run the installed launcher ${join(f.location, 'skills/poteto-mode/scripts/runner/pstack-runner')} with these arguments and wait for it to exit: --parent ${harness} --provider ${provider} --model ${model} --effort ${effort} --mode read-only --prompt ${lane(f, 'prompt.md')} --cwd ${f.dir} --output ${lane(f, 'output.md')} --receipt ${lane(f, 'receipt.json')}`)}. ${rules(f.dir)}`,
      async assert(record, f) {
        // Sessions often call the launcher through a shell variable; the receipt below is written only by the runner.
        if (!record.commands.some(c => c.includes('pstack-runner'))) throw new Error('runner-not-run');
        const receipt = JSON.parse(await readFile(lane(f, 'receipt.json'), 'utf8'));
        if (receipt.status !== 'complete') throw new Error(`receipt-status:${receipt.status}`);
        if (receipt.parent !== harness || receipt.provider !== provider || receipt.model !== model || receipt.effort !== effort || receipt.mode !== 'read-only') throw new Error('receipt-route-mismatch');
        if (receipt.outputPath !== lane(f, 'output.md') || !(Date.parse(receipt.startedAt) >= record.started)) throw new Error('receipt-not-this-session');
        return { assertions: ['runner-ran', 'receipt-complete', `route:${route}`, await written(record, lane(f, 'output.md'))], files: [lane(f, 'receipt.json'), lane(f, 'output.md')] };
      },
    };
  });
}

const setup: Case[] = [{
  id: 'configure',
  codexSandbox: 'danger-full-access',
  claudePermission: 'bypassPermissions',
  prompt: f => `${invoke(f.harness, 'setup-pstack', `Use these answers and ask nothing else. Role assignments: change every role assigned to a model-matrix family to the Opus family, and keep inherit-parent and auto roles unchanged. Opus requested effort: high. I confirm every write. Write the setup report to ${join(f.dir, 'result.md')}.`)} Do not push, post, or contact GitHub.`,
  async assert(record, f) {
    const sheet = join(f.configHome, 'pstack-models.md'), assertions = [loaded(record, 'pstack:setup-pstack'), await written(record, sheet)];
    const descriptors = (await readFile(sheet, 'utf8')).match(/\b(?:claude|codex|grok):[A-Za-z0-9._-]+@[a-z]+/g) ?? [];
    if (!descriptors.length || descriptors.some(d => d !== SETUP_DESCRIPTOR)) throw new Error('sheet-descriptors-mismatch');
    return { assertions: [...assertions, `sheet:${SETUP_DESCRIPTOR}`], files: [sheet] };
  },
}, {
  id: 'consume',
  prompt: f => `${invoke(f.harness, 'poteto-mode', `Do no engineering work. Read the configured pstack model sheet and write to ${join(f.dir, 'route.txt')} one line naming the descriptor configured for the "judgment and prose" role and the route this parent uses for it.`)} ${rules(f.dir)}`,
  async assert(record, f) {
    const path = join(f.dir, 'route.txt'), assertions = [loaded(record, 'pstack:poteto-mode'), await written(record, path)];
    if (!(await readFile(path, 'utf8')).includes(SETUP_DESCRIPTOR)) throw new Error('consumer-route-mismatch');
    return { assertions: [...assertions, 'consumer-route'], files: [path] };
  },
}];

const shippedTools: Case = {
  id: 'log',
  prompt: f => `${invoke(f.harness, 'show-me-your-work', `Log exactly one decision to ${join(f.dir, 'decisions.tsv')} by running the installed helper ${join(f.location, 'skills/show-me-your-work/scripts/log.sh')} with phase "fixture", decision "=SUM(1,2)", why "check escaping", evidence "TASK.md", and result "logged". Do not write the file any other way.`)} ${rules(f.dir)}`,
  async assert(record, f) {
    const path = join(f.dir, 'decisions.tsv'), assertions = [loaded(record, 'pstack:show-me-your-work'), await written(record, path)];
    if (!record.commands.some(c => c.includes('log.sh'))) throw new Error('tool-not-run:log.sh');
    const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(row => row.split('\t'));
    if (rows.length !== 2 || rows[0]!.join(',') !== 'ts,phase,decision,why,evidence,result' || rows[1]![1] !== 'fixture' || rows[1]![2] !== "'=SUM(1,2)") throw new Error('tsv-row-mismatch');
    return { assertions: [...assertions, 'tool-ran:log.sh', 'tsv-row-escaped'], files: [path] };
  },
};

const PRELOAD_TASK = 'Without invoking Skill or reading any file, reply with the first Core principle named in the preloaded poteto-mode skill.';
const agentPreload: Case = {
  id: 'dispatch',
  prompt: f => `Use the Agent tool exactly once with subagent_type pstack:poteto-agent, and give it exactly this task: "${PRELOAD_TASK}" Then reply with the subagent's reply verbatim. ${rules(f.dir)}`,
  async assert(record, f) {
    const agent = record.tools.find(t => t.name === 'Agent' && t.input.subagent_type === 'pstack:poteto-agent' && !t.failed);
    if (!agent) throw new Error('agent-not-dispatched:pstack:poteto-agent');
    // The child answers from the preloaded skill alone: any tool call could load it another way.
    if (record.tools.some(t => t.parent === agent.id)) throw new Error('child-used-tools');
    // Read the child's own reply, not anything the parent wrote.
    if (!agent.result?.includes('Laziness Protocol')) throw new Error('principle-missing:Laziness Protocol');
    // The verifier, not the model, records the child's reply as the retained artifact.
    const reply = join(f.dir, 'child-reply.txt');
    await writeFile(reply, agent.result);
    return { assertions: ['agent-dispatched', 'child-no-tools', 'principle-named'], files: [reply] };
  },
};

/** Resolve a feature's cases, or fail with a named reason before any session starts. */
export function recipe(feature: string, harness: Harness, routes: string[] = []): Case[] {
  if (feature === 'assets:codex') throw new Error('unsupported-native-consumer:assets:codex');
  if (feature === 'project-skill') return [projectSkill];
  if (feature === 'runner') return runner(harness, routes);
  if (feature === 'setup' || feature === 'skill-invocation:setup-pstack') return setup;
  if (feature === 'shipped-tools') return [shippedTools];
  if (feature === 'agent-preload:poteto-agent' && harness === 'claude') return [agentPreload];
  if (feature === 'skill-invocation:reflect') return reflect(harness);
  const skill = /^skill-invocation:([a-z][a-z0-9-]+)$/.exec(feature)?.[1];
  if (!skill) throw new Error(`missing-recipe:${harness}/${feature}`);
  return [overrides[skill] ?? skillCase(skill, 'Apply it to the task in $DIR/TASK.md.')];
}

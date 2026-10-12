import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import registryData from '../features/registry.json';
import { classify, completeEvidence, matches, newReceipt, requiredFeatures, requiredHarnesses, validateRegistry } from './core.ts';
import { type Receipt } from './types.ts';
import codexManifest from '../../../../plugins/pstack/.codex-plugin/plugin.json';
import claudeManifest from '../../../../plugins/pstack/.claude-plugin/plugin.json';

export const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40);
export const registry = validateRegistry(registryData);
export function receipt(selfTest = false): Receipt {
  const r = newReceipt(90, SHA, BASE, selfTest, '/tmp/evidence');
  r.selection = classify([{ filename: 'README.md' }], registry);
  return r;
}
export function evidence(r: Receipt): void {
  for (const harness of requiredHarnesses(r)) {
    r.installations.push({ harness, sha: r.sha, cliVersion: 'test', pluginVersion: '1.5.0',
      location: '/tmp/candidate/plugin', home: `/tmp/${harness}`, treeHash: 'c'.repeat(64) });
    for (const feature of requiredFeatures(r, harness)) {
      r.observations.push({ harness, feature, surface: 'native skill', action: 'invoke', observed: 'fixture changed',
        transcript: '/tmp/log', transcriptHash: 'c'.repeat(64), reviewer: 'recipe', assertions: ['invoke:skill-loaded'],
        artifacts: [{ path: '/tmp/artifact', sha256: 'd'.repeat(64) }] });
    }
  }
}

describe('registry and ownership', () => {
  test('all tracked plugin files are covered, including consumed markdown', () => {
    const root = resolve(import.meta.dir, '../../../..');
    const paths = execFileSync('git', ['ls-files', '-z', 'plugins/pstack', '.claude-plugin', '.agents/plugins'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    expect(paths.length).toBeGreaterThan(100);
    for (const filename of paths) expect(() => classify([{ filename }], registry)).not.toThrow();
  });
  test('validates external registry shape', () => {
    for (const value of [null, {}, { ...registry, skills: ['../bad'] }, { ...registry, tools: ['x', 'x'] }, { ...registry, shared: [3] }, { ...registry, assets: undefined }, { ...registry, assets: ['../asset'] }, { ...registry, assets: ['x', 'x'] }]) {
      expect(() => validateRegistry(value)).toThrow();
    }
  });
  test('terminal prefix cannot match sibling directory', () => {
    expect(matches('skills/x/file', 'skills/x/**')).toBe(true);
    expect(matches('skills/xyz/file', 'skills/x/**')).toBe(false);
  });
  test('repository-root attribution files are not runtime', () => {
    for (const filename of ['NOTICE.md', 'README-UPSTREAM.md', 'REVIEW.md', 'LICENSE-cursor-team-kit', 'LICENSE-superpowers']) {
      expect(classify([{ filename }], registry).noRuntime).toBe(true);
    }
  });
  test('markdown instructions are runtime', () => {
    for (const filename of ['plugins/pstack/skills/architect/SKILL.md', 'plugins/pstack/skills/architect/references/guide.md']) {
      const s = classify([{ filename }], registry);
      expect(s.features).toContain('skill-invocation:architect');
      expect(s.noRuntime).toBe(false);
    }
  });
  test('shared references select every dependent skill and executable surface', () => {
    const s = classify([{ filename: 'plugins/pstack/skills/poteto-mode/references/codex-tools.md' }], registry);
    expect(s.skills).toEqual([...registry.skills].sort());
    for (const feature of ['setup', 'runner', 'shipped-tools']) expect(s.features).toContain(feature);
  });
  test('installed logo changes require only their actual Codex manifest consumer', () => {
    expect(codexManifest.interface.logo).toBe('./assets/logo.png');
    expect(JSON.stringify(claudeManifest)).not.toContain('assets/logo.png');
    const r = receipt();
    r.selection = classify([{ filename: 'plugins/pstack/assets/logo.png' }], registry);
    expect(r.selection.noRuntime).toBe(false);
    expect(r.selection.skills).toEqual([]);
    expect(r.selection.features).toEqual(['assets:codex']);
    r.selection.features = ['codex:assets:codex'];
    expect(requiredHarnesses(r)).toEqual(['codex']);
    expect(requiredFeatures(r, 'claude')).toEqual([]);
    expect(requiredFeatures(r, 'codex')).toEqual(['assets:codex']);
    expect(() => completeEvidence(r)).toThrow('Missing installation: codex');
    evidence(r);
    expect(r.installations.map(i => i.harness)).toEqual(['codex']);
    expect(() => completeEvidence(r)).not.toThrow();
    r.observations.push({ ...r.observations[0]!, harness: 'claude' });
    expect(() => completeEvidence(r)).toThrow('Extra installation or evidence');
  });
  test('unknown assets fail closed rather than inheriting logo consumers', () => {
    for (const filename of ['plugins/pstack/assets/new.png', 'plugins/pstack/assets/nested/logo.png']) {
      expect(() => classify([{ filename }], registry)).toThrow('Unmapped asset consumer');
      expect(() => classify([{ filename: 'README.md', previous_filename: filename }], registry)).toThrow('Unmapped asset consumer');
    }
  });
  test('manifest changes classify as shared runtime', () => {
    for (const filename of ['plugins/pstack/.claude-plugin/plugin.json', 'plugins/pstack/.codex-plugin/plugin.json']) {
      expect(classify([{ filename }], registry).features).toContain('setup');
    }
  });
  test('asset self-test requires both harnesses without fictitious Claude asset proof', () => {
    const r = receipt(true);
    r.selection = classify([{ filename: 'plugins/pstack/assets/logo.png' }], registry);
    r.selection.features = ['codex:assets:codex'];
    expect(requiredHarnesses(r)).toEqual(['claude', 'codex']);
    expect(requiredFeatures(r, 'claude')).toEqual(['project-skill']);
    expect(requiredFeatures(r, 'codex')).toEqual(['assets:codex', 'project-skill']);
    evidence(r);
    expect(r.observations).toHaveLength(3);
    expect(() => completeEvidence(r)).not.toThrow();
    r.observations = r.observations.filter(o => o.harness !== 'claude');
    expect(() => completeEvidence(r)).toThrow('Missing/duplicate evidence: claude/project-skill');
  });
  test('bootstrap changes require its shipped tool consumers, not the unrelated runner', () => {
    const s = classify([{ filename: 'plugins/pstack/skills/poteto-mode/scripts/bootstrap.ts' }], registry);
    expect(s.noRuntime).toBe(false);
    expect(s.features).toEqual(['shipped-tools']);
    expect(s.features).not.toContain('runner');
  });
  test('the transcript resolver belongs to Reflect rather than unrelated shipped tools', () => {
    const path = 'plugins/pstack/skills/poteto-mode/scripts/resolve-codex-transcript.ts';
    for (const file of [{ filename: path }, { filename: path.replace('.ts', '') }, { filename: 'docs/removed-resolver.md', previous_filename: path }]) {
      const s = classify([file], registry);
      expect(s.skills).toEqual(['reflect']);
      expect(s.features).toEqual(['skill-invocation:reflect']);
    }
    expect(() => classify([{ filename: path.replace('.ts', '.py') }], registry)).toThrow('Unmapped path');
    expect(classify([{ filename: path.replace('.ts', '.test.ts') }], registry).noRuntime).toBe(true);
  });
  test('rename and deletion preserve old runtime ownership', () => {
    const s = classify([{ filename: 'docs/old.md', previous_filename: 'plugins/pstack/skills/architect/SKILL.md' }], registry);
    expect(s.features).toContain('skill-invocation:architect');
    expect(classify([{ filename: 'plugins/pstack/skills/architect/SKILL.md' }], registry).noRuntime).toBe(false);
  });
  test('unmapped paths and new executable leaves fail closed', () => {
    for (const filename of ['plugins/pstack/new.ts', 'plugins/pstack/skills/architect/scripts/new.ts', '/absolute', '../escape', 'plugins/pstack/skills/new/SKILL.md']) {
      expect(() => classify([{ filename }], registry)).toThrow();
    }
  });
  test('project-local verification changes cannot bypass their native self-test', () => {
    const r = receipt(true);
    r.selection = classify([{ filename: '.claude/skills/verify-open-pstack/scripts/verify.ts' }], registry);
    expect(r.selection.noRuntime).toBe(false);
    expect(r.selection.features).toEqual(['project-skill']);
    evidence(r);
    expect(() => completeEvidence(r)).not.toThrow();
  });
  test('ordinary repository documentation selects no harnesses', () => {
    const s = classify([{ filename: 'README.md' }, { filename: 'docs/guide.md' }], registry);
    expect(s.noRuntime).toBe(true);
    expect(s.features).toEqual([]);
  });
  test('consumed instructions and known verifier enforcement require native project proof', () => {
    for (const filename of ['AGENTS.md', 'CLAUDE.md', 'tests/skill-collision-repro.sh']) {
      const s = classify([{ filename }], registry);
      expect(s.noRuntime).toBe(false);
      expect(s.features).toEqual(['project-skill']);
      expect(classify([{ filename: 'docs/moved.md', previous_filename: filename }], registry).noRuntime).toBe(false);
    }
  });
  test('Mergify enforcement is not plugin runtime, including renamed paths', () => {
    for (const file of [{ filename: '.mergify.yml' }, { filename: 'docs/moved.md', previous_filename: '.mergify.yml' }]) {
      const r = receipt();
      r.selection = classify([file], registry);
      expect(r.selection.noRuntime).toBe(true);
      expect(requiredHarnesses(r)).toEqual([]);
      expect(() => completeEvidence(r)).not.toThrow();
    }
  });
  test('unregistered CI, tests, and scripts fail closed instead of bypassing runtime proof', () => {
    for (const filename of ['.github/workflows/ci.yml', '.github/pull_request_template.md', 'tests/new-gate.sh', 'scripts/disable-proof.ts']) {
      expect(() => classify([{ filename }], registry)).toThrow();
      expect(() => classify([{ filename: 'README.md', previous_filename: filename }], registry)).toThrow();
    }
  });
});

describe('receipt and evidence boundaries', () => {
  test('validates exact immutable SHAs, PR, and optional publisher revision', () => {
    for (const pr of [0, -1, 1.1, NaN]) expect(() => newReceipt(pr, SHA, BASE, false, '/tmp')).toThrow();
    for (const sha of ['main', 'a'.repeat(39), 'A'.repeat(40)]) expect(() => newReceipt(90, sha, BASE, false, '/tmp')).toThrow();
    expect(newReceipt(90, SHA, BASE, false, '/tmp', 'c'.repeat(40)).publisherRevision).toBe('c'.repeat(40));
    for (const revision of ['', 'main', 'c'.repeat(39), 'c'.repeat(64), 'C'.repeat(40)]) expect(() => newReceipt(90, SHA, BASE, false, '/tmp', revision)).toThrow('publisher revision');
  });
  test('ordinary no-runtime has no install requirement', () => expect(() => completeEvidence(receipt())).not.toThrow());
  test('self-test is separate and required in both harnesses', () => {
    const r = receipt(true);
    expect(() => completeEvidence(r)).toThrow('Missing installation');
    evidence(r);
    expect(() => completeEvidence(r)).not.toThrow();
    r.observations.pop();
    expect(() => completeEvidence(r)).toThrow('Missing/duplicate');
  });
  test('each selected skill must have its own observation', () => {
    const r = receipt();
    r.selection = classify(registry.skills.slice(0, 2).map(s => ({ filename: `plugins/pstack/skills/${s}/SKILL.md` })), registry);
    r.selection.features = registry.skills.slice(0, 2).map(s => `claude:skill-invocation:${s}`);
    evidence(r);
    expect(() => completeEvidence(r)).not.toThrow();
    r.observations.pop();
    expect(() => completeEvidence(r)).toThrow();
  });
  test('wrong SHA, duplicate and incomplete evidence cannot pass', () => {
    for (const damage of [
      (r: Receipt) => { r.installations[0]!.sha = BASE; },
      (r: Receipt) => { r.observations.push(r.observations[0]!); },
      (r: Receipt) => { r.observations[0]!.transcriptHash = ''; },
      (r: Receipt) => { r.observations[0]!.observed = ''; },
      (r: Receipt) => { r.observations[0]!.assertions = []; },
      (r: Receipt) => { r.observations[0]!.artifacts = []; },
      (r: Receipt) => { r.failure = 'provider unavailable'; },
    ]) {
      const r = receipt(true); evidence(r); damage(r);
      expect(() => completeEvidence(r)).toThrow();
    }
  });
});

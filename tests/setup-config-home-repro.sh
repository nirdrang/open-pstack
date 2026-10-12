#!/usr/bin/env bash
set -euo pipefail

# Prepare and inspect a real-harness run; static checks test the verifier only.
repo="$(cd "$(dirname "$0")/.." && pwd)"
usage() {
  cat <<'EOF'
Usage:
  bash tests/setup-config-home-repro.sh claude|codex redirected [--claude-config DIR] [--codex-home DIR]
  bash tests/setup-config-home-repro.sh claude imported-sheet [--claude-config DIR] [--codex-home DIR]
  bash tests/setup-config-home-repro.sh --verify RUN_DIR
  bash tests/setup-config-home-repro.sh --static

The imported-sheet case seeds the legacy import and snapshots the existing
~/.claude/pstack-models.md read-only; keep its assignments unchanged during setup.
Static mode tests artifact comparisons without invoking a harness or claiming
live acceptance.

Preparation keeps HOME and USER unchanged, snapshots daily sheet/integration
files, and creates private redirected config directories (including spaces and #).
Only .credentials.json / auth.json are copied from explicitly supplied login
sources. Without a file-backed source, log in in the redirected directory.
No daily configuration or credentials are modified by this fixture.

Run the printed commands in an operator terminal. Install the exact candidate,
invoke /setup-pstack through the real parent, complete probes and confirmation,
and refuse permission to write outside the redirected directories. Retain the
native transcripts and provider receipts. Then run --verify, rerun setup without
changes, and run --verify again to assert byte-identical output. Start a fresh
parent session and demonstrate the sheet is loaded. Verification below checks
artifacts, not live invocation or loaded-sheet proof; those require transcripts.

Do not run old instructions that explicitly target daily paths without a native
sandbox denying those writes. Unset/empty defaults are tested statically only.
Run directories contain credentials and private snapshots: do not commit or
upload them. Retain only redacted transcripts/results, then delete the run dir.
EOF
}

if [ "${1:-}" = "--help" ]; then usage; exit 0; fi
if [ "${1:-}" = "--static" ]; then
  node - "$repo" <<'JS'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const repo = process.argv[2];
const run = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-import-static-'));
try {
  const home = path.join(run, 'claude # config');
  fs.mkdirSync(home);
  const sentinel = '# Fixture instructions\nPreserve this unrelated text exactly.\n';
  const rows = 'how explorer: claude:opus@max\narena runners: codex:gpt-5.6-sol@max, claude:opus@max\n';
  fs.writeFileSync(path.join(run, 'sentinel'), sentinel);
  fs.writeFileSync(path.join(run, 'imported-sheet'), rows);
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({harness: 'claude', home: process.env.HOME, user: process.env.USER || '', sha: cp.execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), targets: []}));
  const sheet = path.join(home, 'pstack-models.md');
  const integration = path.join(home, 'CLAUDE.md');
  const verify = () => cp.spawnSync('bash', [path.join(repo, 'tests/setup-config-home-repro.sh'), '--verify', run], {encoding: 'utf8'});
  fs.writeFileSync(sheet, rows);
  fs.writeFileSync(integration, sentinel + '@~/.claude/pstack-models.md\n');
  let result = verify();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /single relative sheet import/);
  fs.writeFileSync(integration, sentinel + '@./pstack-models.md\n');
  for (const changed of [rows.replace('claude:opus@max', 'auto'), rows.replace('@max', '@high')]) {
    fs.writeFileSync(sheet, changed);
    result = verify();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /imported sheet assignments were not preserved/);
  }
  fs.writeFileSync(sheet, rows);
  for (let i = 0; i < 2; i++) {
    result = verify();
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  console.log('ok: static imported-sheet fixture rejects stale assignments and legacy redirected imports; preserved assignments and unchanged rerun pass');
  console.log('No live harness was invoked; HOME and USER and daily configuration were unchanged.');
} finally { fs.rmSync(run, {recursive: true, force: true}); }
JS
  exit 0
fi
if [ "${1:-}" = "--verify" ]; then
  [ "$#" = 2 ] || { usage >&2; exit 2; }
  command -v node >/dev/null || { echo 'FAIL: node is required for artifact comparisons' >&2; exit 1; }
  node - "$2" "$repo" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const run = fs.realpathSync(process.argv[2]);
const repo = process.argv[3];
const meta = JSON.parse(fs.readFileSync(path.join(run, 'run.json'), 'utf8'));
function fail(message) { console.error(`FAIL: ${message}`); process.exit(1); }
if (meta.home !== process.env.HOME || meta.user !== (process.env.USER || '')) fail('HOME or USER changed');
const sha = cp.execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
if (sha !== meta.sha || cp.execFileSync('git', ['-C', repo, 'status', '--porcelain'], {encoding: 'utf8'}).trim()) fail('candidate changed since preparation');
for (const [i, target] of meta.targets.entries()) {
  const before = path.join(run, 'daily', String(i));
  if (fs.existsSync(before) !== fs.existsSync(target) || (fs.existsSync(before) && !fs.readFileSync(before).equals(fs.readFileSync(target)))) fail(`daily config target changed: ${target}`);
}
const home = path.join(run, `${meta.harness} # config`);
const sheet = path.join(home, 'pstack-models.md');
const integration = path.join(home, meta.harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
if (!fs.existsSync(sheet) || !fs.statSync(sheet).size) fail('redirected model sheet missing or empty');
const bytes = fs.readFileSync(sheet);
const imported = path.join(run, 'imported-sheet');
if (fs.existsSync(imported)) {
  const assignments = text => text.split('\n').filter(line => /^[^:#]+:\s*(?:claude:|codex:|grok:|inherit-parent\s*$|auto\s*$)/.test(line)).map(line => line.trim()).sort();
  const before = assignments(fs.readFileSync(imported, 'utf8'));
  if (!before.length || JSON.stringify(before) !== JSON.stringify(assignments(bytes.toString('utf8')))) fail('imported sheet assignments were not preserved');
}
const text = fs.readFileSync(integration, 'utf8');
const sentinel = fs.readFileSync(path.join(run, 'sentinel'), 'utf8');
if (!text.startsWith(sentinel)) fail('unrelated integration bytes changed');
if (meta.harness === 'claude') {
  const includes = text.split('\n').filter(line => line.startsWith('@') && line.includes('pstack-models.md'));
  if (includes.length !== 1 || includes[0] !== '@./pstack-models.md') fail('Claude include is not the single relative sheet import');
} else {
  const begin = '<!-- pstack:models:begin -->';
  const end = '<!-- pstack:models:end -->';
  if (text.split(begin).length !== 2 || text.split(end).length !== 2 || text.indexOf(end) <= text.indexOf(begin)) fail('Codex block markers missing, duplicated, or reversed');
  const block = text.slice(text.indexOf(begin) + begin.length + 1, text.indexOf(end));
  if (!Buffer.from(block).equals(bytes)) fail('Codex block differs from model sheet bytes');
}
for (const [name, current] of [['sheet', sheet], ['integration', integration]]) {
  const previous = path.join(run, `verified-${name}`);
  if (fs.existsSync(previous) && !fs.readFileSync(previous).equals(fs.readFileSync(current))) fail(`unchanged rerun changed ${name}`);
  fs.copyFileSync(current, previous);
}
console.log(`ok: ${meta.harness} redirected artifacts, unrelated bytes, daily targets and rerun snapshots; candidate=${sha}`);
console.log('Live invocation, probes, receipts, and fresh-session loading still require operator transcript evidence.');
JS
  exit 0
fi

harness="${1:-}"
case "$harness" in claude|codex) ;; *) usage >&2; exit 2 ;; esac
mode="${2:-}"
case "$harness:$mode" in claude:redirected|codex:redirected|claude:imported-sheet) ;; *) echo 'FAIL: only redirected live writes are permitted; test defaults statically' >&2; exit 2 ;; esac
if [ "$mode" = imported-sheet ]; then
  [ -s "$HOME/.claude/pstack-models.md" ] || { echo 'FAIL: imported-sheet case requires an existing ~/.claude/pstack-models.md' >&2; exit 1; }
fi
shift 2
claude_source=""
codex_source=""
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || { usage >&2; exit 2; }
  case "$1" in
    --claude-config) claude_source="$2" ;;
    --codex-home) codex_source="$2" ;;
    *) usage >&2; exit 2 ;;
  esac
  shift 2
done
command -v node >/dev/null || { echo 'FAIL: node is required' >&2; exit 1; }
[ -z "$(git -C "$repo" status --porcelain)" ] || { echo 'FAIL: commit the exact candidate before preparing a live run' >&2; exit 1; }
for source in "$claude_source" "$codex_source"; do
  [ -z "$source" ] || [ -d "$source" ] || { echo "FAIL: login source directory does not exist: $source" >&2; exit 1; }
done
[ -z "$claude_source" ] || [ -f "$claude_source/.credentials.json" ] || { echo 'FAIL: Claude source has no file-backed .credentials.json; use redirected login instead' >&2; exit 1; }
[ -z "$codex_source" ] || [ -f "$codex_source/auth.json" ] || { echo 'FAIL: Codex source has no file-backed auth.json; use redirected login instead' >&2; exit 1; }
umask 077
run="$(mktemp -d "${TMPDIR:-/tmp}/pstack-config-home.XXXXXX")"
run="$(cd "$run" && pwd -P)"
mkdir "$run/claude # config" "$run/codex # config" "$run/daily" "$run/workspace"
[ -z "$claude_source" ] || cp "$claude_source/.credentials.json" "$run/claude # config/.credentials.json"
[ -z "$codex_source" ] || cp "$codex_source/auth.json" "$run/codex # config/auth.json"
printf '%s\n' '# Fixture instructions' 'Preserve this unrelated text exactly.' > "$run/sentinel"
cp "$run/sentinel" "$run/claude # config/CLAUDE.md"
if [ "$mode" = imported-sheet ]; then
  cp "$HOME/.claude/pstack-models.md" "$run/imported-sheet"
  printf '@~/.claude/pstack-models.md\n' >> "$run/claude # config/CLAUDE.md"
fi
cp "$run/sentinel" "$run/codex # config/AGENTS.md"
printf '[features]\nmulti_agent = true\n' > "$run/codex # config/config.toml"
node - "$run" "$repo" "$harness" "$claude_source" "$codex_source" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const [run, repo, harness, claudeSource, codexSource] = process.argv.slice(2);
const dirs = [...new Set([path.join(process.env.HOME, '.claude'), path.join(process.env.HOME, '.codex'), process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME, claudeSource, codexSource].filter(Boolean))];
const targets = dirs.flatMap(dir => ['pstack-models.md', 'CLAUDE.md', 'AGENTS.md'].map(file => path.resolve(dir, file)));
for (const [i, target] of targets.entries()) if (fs.existsSync(target)) fs.copyFileSync(target, path.join(run, 'daily', String(i)));
fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({harness, home: process.env.HOME, user: process.env.USER || '', sha: cp.execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), targets}, null, 2));
JS
printf 'Prepared private run: %s\n' "$run"
printf 'Keep HOME and USER unchanged. In an operator terminal:\ncd %q\n' "$run/workspace"
printf 'export CLAUDE_CONFIG_DIR=%q CODEX_HOME=%q\n' "$run/claude # config" "$run/codex # config"
if [ "$harness" = claude ]; then
  printf 'claude --plugin-dir %q\n' "$repo/plugins/pstack"
else
  printf 'codex plugin marketplace add ericlitman/open-pstack --ref %q\n' "$(git -C "$repo" rev-parse HEAD)"
  printf 'codex plugin add pstack@open-pstack\ncodex\n'
fi
printf 'Invoke /setup-pstack; permit writes only under the redirected config dirs.\n'
printf 'Retain native transcripts/receipts; then verify, rerun setup unchanged, verify again, and prove fresh-session loading.\n'
printf 'bash %q --verify %q\n' "$repo/tests/setup-config-home-repro.sh" "$run"

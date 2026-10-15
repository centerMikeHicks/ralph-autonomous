import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmDir, initRepo, git, runScript } from './helpers/kit.mjs';
import { compareTable, summarise, isRed, runCheck, linkDirs, unlinkDirs } from '../scripts/base-health.mjs';

const CHECK_JS = [
  "const fs = require('node:fs');",
  "const lines = fs.readFileSync('state.txt', 'utf8').split(/\\r?\\n/).filter(Boolean);",
  'for (const l of lines) console.log(l);',
  "process.exit(lines.some((l) => /error/.test(l)) ? 1 : 0);",
].join('\n');

/** main has `baseState`; branch `work` is checked out with `headState` in the working tree. */
function repo(baseState, headState, config = {}) {
  const dir = tmpDir('kit-bh-');
  initRepo(dir, {
    'check.js': CHECK_JS,
    'state.txt': baseState,
    'ralph.config.json': JSON.stringify({
      gates: { baseHealth: { checks: [{ name: 'errs', command: ['node', 'check.js'] }, ...(config.extra ?? [])] } },
    }),
  });
  git(dir, ['checkout', '-q', '-b', 'work']);
  fs.writeFileSync(path.join(dir, 'state.txt'), headState);
  return dir;
}

const bh = (dir, args) => runScript('base-health.mjs', args, { cwd: dir });

test('measuring the base records findings and reports RED / GREEN', () => {
  const red = repo('ok\nerror one\nerror two\n', 'ok\n');
  const green = repo('ok\n', 'ok\n');
  try {
    const r = bh(red, ['--base', 'main']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /is RED: errs 2/);
    const rec = JSON.parse(fs.readFileSync(path.join(red, '.ralph', 'base-health.json'), 'utf8'));
    assert.equal(rec.checks.errs.findings, 2);
    assert.equal(rec.checks.errs.exit, 1);
    assert.match(bh(green, ['--base', 'main']).out, /is GREEN: errs 0/);
    assert.ok(!fs.existsSync(path.join(red, '.claude-temp', 'base-health', rec.base.slice(0, 7))), 'the temporary worktree is removed');
    assert.equal(git(red, ['worktree', 'list']).split('\n').length, 1);
  } finally { rmDir(red); rmDir(green); }
});

test('--compare exits 1 when the head has more findings than the base', () => {
  const dir = repo('ok\nerror one\n', 'ok\nerror one\nerror two\nerror three\n');
  try {
    const r = bh(dir, ['--base', 'main', '--compare']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /REGRESSION/);
    assert.match(r.out, /\+2/);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, '.ralph', 'base-health.json'), 'utf8'));
    assert.equal(rec.compare.regressed, 1);
  } finally { rmDir(dir); }
});

test('--compare exits 0 when the head is the same or better, even on a red base', () => {
  const same = repo('error one\n', 'error one\n');
  const better = repo('error one\nerror two\n', 'error one\n');
  try {
    const a = bh(same, ['--base', 'main', '--compare']);
    assert.equal(a.status, 0, a.out);
    assert.match(a.out, /no regression/);
    const b = bh(better, ['--base', 'main', '--compare']);
    assert.equal(b.status, 0, b.out);
    assert.match(b.out, /improved/);
  } finally { rmDir(same); rmDir(better); }
});

test('a recorded base is reused until --fresh', () => {
  const dir = repo('ok\n', 'ok\n');
  try {
    bh(dir, ['--base', 'main']);
    assert.match(bh(dir, ['--base', 'main']).out, /already measured/);
    assert.doesNotMatch(bh(dir, ['--base', 'main', '--fresh']).out, /already measured/);
  } finally { rmDir(dir); }
});

test('--summary prints the recorded verdict, and says so when nothing is recorded', () => {
  const dir = repo('error x\n', 'error x\n');
  try {
    assert.match(bh(dir, ['--summary']).out, /no .*base-health\.json/);
    bh(dir, ['--base', 'main']);
    const s = bh(dir, ['--summary', '--plan', path.join(dir, 'plan.md')]);
    assert.match(s.out, /RED/);
    assert.match(s.out, /WARNING: the base is red/);
    fs.writeFileSync(path.join(dir, 'plan.md'), 'The base is red: yes\n');
    assert.doesNotMatch(bh(dir, ['--summary', '--plan', path.join(dir, 'plan.md')]).out, /WARNING/);
  } finally { rmDir(dir); }
});

test('a shell-string check and a custom failPattern are counted', () => {
  const dir = repo('ok\n', 'ok\n', { extra: [{ name: 'pattern', command: 'node -e "console.log(\'WARN a\'); console.log(\'WARN b\')"', failPattern: '^WARN' }] });
  try {
    const r = bh(dir, ['--base', 'main', '--json']);
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(r.stdout).checks.pattern.findings, 2);
  } finally { rmDir(dir); }
});

test('no checks configured is a reported no-op; a missing base ref is a usage error', () => {
  const dir = tmpDir('kit-bh-');
  try {
    initRepo(dir, { 'ralph.config.json': '{}' });
    const r = bh(dir, []);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /nothing to measure/);
    fs.writeFileSync(path.join(dir, 'ralph.config.json'), JSON.stringify({ gates: { baseHealth: { checks: [{ name: 'a', command: 'node -v' }] } } }));
    assert.equal(bh(dir, ['--base', 'no-such-ref']).status, 2);
  } finally { rmDir(dir); }
});

test('pure helpers: compareTable, summarise, isRed, runCheck', () => {
  const t = compareTable({ a: { findings: 1 }, b: { findings: 2 }, c: { findings: null } }, { a: { findings: 3 }, b: { findings: 1 }, c: { findings: 0 } });
  assert.equal(t.regressed, 1);
  assert.deepEqual(t.rows.map((r) => r.verdict), ['REGRESSION', 'improved', 'n/a']);
  assert.equal(isRed({ a: { findings: 0 }, b: { findings: null } }), false);
  assert.match(summarise({ base: 'abcdef123', at: 'now', checks: { a: { findings: null, reason: 'timed out' } } }).join('\n'), /not measured/);
  const dir = tmpDir('kit-bh-');
  try {
    assert.equal(runCheck({ name: 'ok', command: ['node', '-e', 'console.log("fine")'] }, dir).findings, 0);
    assert.equal(runCheck({ name: 'bad', command: ['node', '-e', 'process.exit(3)'] }, dir).findings, 1);
    assert.equal(runCheck({ name: 'none', command: ['no-such-binary-xyz'] }, dir).findings, null);
  } finally { rmDir(dir); }
});

test('linkDirs links existing directories and unlinkDirs proves they are gone without touching the target', () => {
  const root = tmpDir('kit-link-a-');
  const wt = tmpDir('kit-link-b-');
  try {
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'i.js'), 'x');
    const linked = linkDirs(root, wt, ['node_modules', 'absent']);
    assert.equal(linked.length, 1);
    assert.ok(fs.existsSync(path.join(wt, 'node_modules', 'pkg', 'i.js')));
    assert.equal(unlinkDirs(linked).ok, true);
    assert.ok(!fs.existsSync(path.join(wt, 'node_modules')));
    assert.ok(fs.existsSync(path.join(root, 'node_modules', 'pkg', 'i.js')), 'the target survives');
  } finally { rmDir(root); rmDir(wt); }
});

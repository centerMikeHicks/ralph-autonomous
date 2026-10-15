import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ejectDecision, filterPorcelain, progressFingerprint } from '../ralph/lib/progress.mjs';

const base = { fingerprintBefore: 'a', fingerprintAfter: 'a', headBefore: 'h1', headAfter: 'h1' };

test('blocked outcome stops immediately, even with work done', () => {
  const d = ejectDecision({ ...base, outcome: 'blocked', fingerprintAfter: 'b' });
  assert.equal(d.stop, 'blocked');
});

test('two consecutive unchanged iterations stop as stalled; one does not', () => {
  const first = ejectDecision({ ...base, outcome: 'progressed' });
  assert.deepEqual(first, { stop: '', stalled: 1 });
  const second = ejectDecision({ ...base, outcome: 'progressed', stalled: first.stalled });
  assert.deepEqual(second, { stop: 'stalled', stalled: 2 });
});

test('a changed fingerprint or a moved HEAD resets the stall counter', () => {
  assert.deepEqual(ejectDecision({ ...base, outcome: 'progressed', stalled: 1, fingerprintAfter: 'b' }), { stop: '', stalled: 0 });
  assert.deepEqual(ejectDecision({ ...base, outcome: 'committed', stalled: 1, headAfter: 'h2' }), { stop: '', stalled: 0 });
});

test('two empty HEAD values (no repository) count as not moved', () => {
  assert.equal(ejectDecision({ ...base, outcome: 'x', headBefore: '', headAfter: '', stalled: 1 }).stop, 'stalled');
});

test('blocked takes precedence over stalled and still counts the stall', () => {
  assert.deepEqual(ejectDecision({ ...base, outcome: 'blocked', stalled: 1 }), { stop: 'blocked', stalled: 2 });
});

test('filterPorcelain drops loop bookkeeping under the state dir but keeps real work', () => {
  const text = [
    '?? .ralph/ITERATION_STATUS.json',
    '?? .ralph/iterations.jsonl',
    '?? .ralph/logs/demo/20260101-iter001.jsonl',
    ' M .ralph/SPECS_LEDGER.md',
    ' M src/app.js',
    '?? ITERATION_STATUS.json',
  ].join('\n');
  assert.equal(filterPorcelain(text, '.ralph'), [' M .ralph/SPECS_LEDGER.md', ' M src/app.js', '?? ITERATION_STATUS.json'].join('\n'));
});

test('fingerprint changes with the plan hash and with tracked-tree edits, not with bookkeeping', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-fp-'));
  try {
    const git = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@e.invalid', ...a], { encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), '1');
    git('add', '.');
    git('commit', '-qm', 'init');
    fs.mkdirSync(path.join(dir, '.ralph'));
    const plan = path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md');
    fs.writeFileSync(plan, '- [ ] **P**');
    const fp = () => progressFingerprint({ root: dir, planFile: plan, stateDir: '.ralph' });
    const a = fp();
    fs.writeFileSync(path.join(dir, '.ralph', 'iterations.jsonl'), '{}');
    assert.equal(fp(), a, 'bookkeeping is not progress');
    fs.writeFileSync(plan, '- [x] **P**');
    const b = fp();
    assert.notEqual(b, a, 'plan edits are progress');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
    assert.notEqual(fp(), b, 'an untracked source file is progress');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

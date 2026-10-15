import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixture, rmDir, runScript } from './helpers/kit.mjs';

const run = (dir, args) => runScript('verify-plan-ticks.mjs', args, { cwd: dir });
const withProject = (fn) => async () => { const dir = copyFixture(); try { await fn(dir); } finally { rmDir(dir); } };
const PLAN = (dir) => path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md');

/** Snapshot the plan as `before`, apply `edit` to produce `after`. */
function snapshot(dir, edit) {
  const before = path.join(dir, 'before.md');
  const after = path.join(dir, 'after.md');
  const text = fs.readFileSync(PLAN(dir), 'utf8');
  fs.writeFileSync(before, text);
  fs.writeFileSync(after, edit(text));
  return { before, after };
}

const tickPhase2 = (t) => t
  .replace('- [ ] **Phase 2: CLI entry** ← NEXT', '- [x] **Phase 2: CLI entry**')
  .replace('  - [ ] Build `run`', '  - [x] Build `run`');

test('no new ticks passes', withProject((dir) => {
  const { before, after } = snapshot(dir, (t) => t);
  const r = run(dir, ['--before', before, '--after', after]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /no new phase ticks/);
}));

test('an earned tick (tasks done, tests bound) passes', withProject((dir) => {
  const { before, after } = snapshot(dir, tickPhase2);
  const r = run(dir, ['--before', before, '--after', after, '--spec', 'specs/hello.md']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ok\s+- \[x\] \*\*Phase 2/);
}));

test('a tick with an open task is not earned, and --fix un-ticks it', withProject((dir) => {
  const { before, after } = snapshot(dir, (t) => t.replace('- [ ] **Phase 2: CLI entry** ← NEXT', '- [x] **Phase 2: CLI entry**'));
  const r = run(dir, ['--before', before, '--after', after, '--spec', 'specs/hello.md']);
  assert.equal(r.status, 1);
  assert.match(r.out, /task\(s\) are still unticked/);
  const fixed = run(dir, ['--before', before, '--after', after, '--spec', 'specs/hello.md', '--fix']);
  assert.equal(fixed.status, 1);
  assert.match(fs.readFileSync(after, 'utf8'), /- \[ \] \*\*Phase 2: CLI entry\*\*/);
  assert.match(fs.readFileSync(after, 'utf8'), /- \[x\] \*\*Phase 1/);
}));

test('a tick whose acceptance test does not exist is not earned', withProject((dir) => {
  fs.rmSync(path.join(dir, 'src', 'cli.integration.test.mjs'));
  const { before, after } = snapshot(dir, tickPhase2);
  const r = run(dir, ['--before', before, '--after', after, '--spec', 'specs/hello.md', '--json']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.illegitimate, 1);
  assert.equal(out.checked[0].bindings[0].name, 'cliPrintsGreeting');
}));

test('a gate clause with a backticked command must exit 0', withProject((dir) => {
  const failing = (t) => tickPhase2(t).replace('- [ ] **Phase 2', '- [x] **Phase 2');
  const withGate = (t) => failing(t).replace('Phase 2: CLI entry**', 'Phase 2: CLI entry**\n  gate: `node -e "process.exit(3)"`');
  let { before, after } = snapshot(dir, withGate);
  let r = run(dir, ['--before', before, '--after', after, '--spec', 'specs/hello.md']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /gate .* exited 3/);
  ({ before, after } = snapshot(dir, (t) => withGate(t).replace('process.exit(3)', 'process.exit(0)')));
  r = run(dir, ['--before', before, '--after', after, '--spec', 'specs/hello.md']);
  assert.equal(r.status, 0, r.out);
}));

test('the Exit Gate cannot be ticked while a phase is open', withProject((dir) => {
  const { before, after } = snapshot(dir, (t) => t.replace('- [ ] **Exit Gate**', '- [x] **Exit Gate**'));
  const r = run(dir, ['--before', before, '--after', after, '--spec', 'specs/hello.md']);
  assert.equal(r.status, 1);
  assert.match(r.out, /earlier phase\(s\) are not ticked: phase-2/);
}));

test('without a spec the binding check reports itself as not run', withProject((dir) => {
  fs.rmSync(path.join(dir, '.ralph', 'ACTIVE_SPEC'));
  const { before, after } = snapshot(dir, tickPhase2);
  const r = run(dir, ['--before', before, '--after', after]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /acceptance bindings not checked/);
}));

test('usage: missing files exit 2', withProject((dir) => {
  assert.equal(run(dir, ['--before', 'nope.md', '--after', 'nope2.md']).status, 2);
  assert.equal(run(dir, []).status, 2);
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmDir, initRepo, git, runScript, KIT } from './helpers/kit.mjs';
import { createLane } from '../scripts/new-lane.mjs';

/** A repo nested one level down so its sibling lane directory lands inside a disposable parent. */
function project(files = { 'README.md': 'x\n' }) {
  const parent = tmpDir('kit-lane-');
  const dir = path.join(parent, 'proj');
  fs.mkdirSync(dir);
  initRepo(dir, files);
  return { parent, dir };
}

test('--dry-run prints the plan and changes nothing', () => {
  const { parent, dir } = project();
  try {
    const r = runScript('new-lane.mjs', ['--name', 'backend', '--dry-run'], { cwd: dir });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /dry-run/);
    assert.match(r.out, /main-lane-backend/);
    assert.match(r.out, /ralph-queue.cjs start/);
    assert.match(r.out, /MOVED to lane backend/);
    assert.equal(fs.readdirSync(parent).length, 1);
    assert.equal(git(dir, ['branch', '--list', 'main-lane-backend']), '');
  } finally { rmDir(parent); }
});

test('creates the worktree, branch and queue; copies an untracked ralph.config.json', () => {
  const { parent, dir } = project();
  try {
    fs.writeFileSync(path.join(dir, 'ralph.config.json'), '{"project":{"name":"p"}}');
    const r = runScript('new-lane.mjs', ['--name', 'frontend', '--base', 'main'], { cwd: dir });
    assert.equal(r.status, 0, r.out);
    const lane = path.join(parent, 'proj-lane-frontend');
    assert.ok(fs.existsSync(path.join(lane, '.git')));
    assert.equal(git(lane, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main-lane-frontend');
    assert.equal(fs.readFileSync(path.join(lane, 'ralph.config.json'), 'utf8'), '{"project":{"name":"p"}}');
    const queue = fs.readFileSync(path.join(lane, '.claude-temp', 'ralph-queue', 'QUEUE.md'), 'utf8');
    assert.match(queue, /^# Ralph queue/);
    assert.ok(git(dir, ['worktree', 'list']).includes('proj-lane-frontend'));
  } finally { rmDir(parent); }
});

test('a tracked ralph.config.json arrives through the checkout, not a copy', () => {
  const { parent, dir } = project({ 'README.md': 'x\n', 'ralph.config.json': '{"project":{"name":"tracked"}}' });
  try {
    const r = createLane({ root: dir, name: 'a' });
    assert.equal(fs.readFileSync(path.join(r.laneDir, 'ralph.config.json'), 'utf8'), '{"project":{"name":"tracked"}}');
  } finally { rmDir(parent); }
});

test('the base defaults to the current branch', () => {
  const { parent, dir } = project();
  try {
    git(dir, ['checkout', '-q', '-b', 'integration']);
    const r = createLane({ root: dir, name: 'x', dryRun: true });
    assert.equal(r.base, 'integration');
    assert.equal(r.branch, 'integration-lane-x');
  } finally { rmDir(parent); }
});

test('refuses an existing branch or directory, a bad name and a missing base; nothing is deleted', () => {
  const { parent, dir } = project();
  try {
    assert.equal(runScript('new-lane.mjs', ['--name', 'one'], { cwd: dir }).status, 0);
    const again = runScript('new-lane.mjs', ['--name', 'one'], { cwd: dir });
    assert.equal(again.status, 1);
    assert.match(again.out, /already exists/);
    git(dir, ['branch', 'main-lane-two']);
    assert.match(runScript('new-lane.mjs', ['--name', 'two'], { cwd: dir }).out, /branch .* already exists/);
    assert.match(runScript('new-lane.mjs', ['--name', 'Bad Name'], { cwd: dir }).out, /lane name must be/);
    assert.match(runScript('new-lane.mjs', ['--name', 'three', '--base', 'nope'], { cwd: dir }).out, /does not exist/);
    assert.equal(runScript('new-lane.mjs', [], { cwd: dir }).status, 2);
    assert.ok(fs.existsSync(path.join(parent, 'proj-lane-one')));
  } finally { rmDir(parent); }
});

test('the queue template exists and carries no runnable entry', () => {
  const text = fs.readFileSync(path.join(KIT, 'templates', 'queue.md'), 'utf8');
  assert.equal(text.split(/\r?\n/).filter((l) => /^- \[[ x!]\]/.test(l)).length, 0);
});

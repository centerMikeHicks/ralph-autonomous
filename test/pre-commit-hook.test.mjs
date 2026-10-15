import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KIT, tmpDir, rmDir, initRepo, git, writeFiles } from './helpers/kit.mjs';
import { installHooks } from '../scripts/install-hooks.mjs';

/** A repo that carries the kit's scripts and hook, with the hook installed. */
function kitRepo(config) {
  const dir = tmpDir('kit-hook-');
  initRepo(dir, { 'ralph.config.json': JSON.stringify(config), 'a.txt': 'a\n' });
  fs.cpSync(path.join(KIT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(KIT, '.githooks'), path.join(dir, '.githooks'), { recursive: true });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'add kit']);
  installHooks(dir);
  return dir;
}

const commit = (dir, msg = 'change') => {
  fs.appendFileSync(path.join(dir, 'a.txt'), 'x\n');
  git(dir, ['add', '-A']);
  return spawnSync('git', ['commit', '-m', msg], { cwd: dir, encoding: 'utf8' });
};

test('pre-commit lets a commit through when nothing is configured', () => {
  const dir = kitRepo({});
  try {
    const r = commit(dir);
    assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally { rmDir(dir); }
});

test('pre-commit runs hooks.preCommit commands and blocks on the first failure', () => {
  const dir = kitRepo({ hooks: { preCommit: [['node', '-e', 'process.exit(0)'], 'node -e "process.exit(7)"'] } });
  try {
    const r = commit(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /BLOCKED/);
    assert.equal(git(dir, ['log', '--oneline']).split('\n').length, 2);
  } finally { rmDir(dir); }
});

test('pre-commit passes when every hooks.preCommit command succeeds', () => {
  const dir = kitRepo({ hooks: { preCommit: [['node', '-e', 'process.exit(0)']] } });
  try {
    const r = commit(dir);
    assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally { rmDir(dir); }
});

test('with tracker.provider jira, a JIRA DEGRADED marker blocks the commit until it is cleared', () => {
  const dir = kitRepo({ tracker: { provider: 'jira' } });
  try {
    writeFiles(dir, { '.ralph/PROGRESS.md': '# Progress\n⚠️ JIRA DEGRADED: transition failed\n' });
    const blocked = commit(dir);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr + blocked.stdout, /JIRA DEGRADED/);
    fs.writeFileSync(path.join(dir, '.ralph', 'PROGRESS.md'), '# Progress\nall good\n');
    const ok = spawnSync('git', ['commit', '-m', 'again'], { cwd: dir, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  } finally { rmDir(dir); }
});

test('with tracker.provider none the marker is ignored', () => {
  const dir = kitRepo({});
  try {
    writeFiles(dir, { '.ralph/PROGRESS.md': 'JIRA DEGRADED\n' });
    assert.equal(commit(dir).status, 0);
  } finally { rmDir(dir); }
});

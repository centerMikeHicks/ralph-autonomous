import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmDir, initRepo, git, runScript } from './helpers/kit.mjs';
import { installHooks } from '../scripts/install-hooks.mjs';
import { runPreCommit } from '../scripts/lib/run-precommit.mjs';

test('install-hooks sets core.hooksPath and is idempotent', () => {
  const dir = tmpDir('kit-install-');
  try {
    initRepo(dir, { '.githooks/pre-commit': '#!/bin/sh\nexit 0\n' });
    assert.equal(installHooks(dir).changed, true);
    assert.equal(git(dir, ['config', '--get', 'core.hooksPath']), '.githooks');
    assert.equal(installHooks(dir).changed, false);
    if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(dir, '.githooks', 'pre-commit')).mode & 0o111);
  } finally { rmDir(dir); }
});

test('install-hooks refuses a non-repository and a missing .githooks directory', () => {
  const dir = tmpDir('kit-install-');
  try {
    assert.throws(() => installHooks(dir), /not inside a git work tree/);
    initRepo(dir);
    assert.throws(() => installHooks(dir), /\.githooks\/ not found/);
    const r = runScript('install-hooks.mjs', ['--root', dir], { cwd: dir });
    assert.equal(r.status, 1);
  } finally { rmDir(dir); }
});

test('install-hooks will not silently replace another core.hooksPath', () => {
  const dir = tmpDir('kit-install-');
  try {
    initRepo(dir, { '.githooks/pre-commit': '#!/bin/sh\nexit 0\n' });
    git(dir, ['config', 'core.hooksPath', '.husky/_']);
    assert.throws(() => installHooks(dir), /would disable your existing hooks.*\.husky\/_.*hooks\.preCommit/);
    assert.equal(git(dir, ['config', '--get', 'core.hooksPath']), '.husky/_');
    const r = runScript('install-hooks.mjs', ['--root', dir], { cwd: dir });
    assert.equal(r.status, 1);
    assert.equal(installHooks(dir, { force: true }).changed, true);
    assert.equal(git(dir, ['config', '--get', 'core.hooksPath']), '.githooks');
  } finally { rmDir(dir); }
});

test('install-hooks will not silently bypass a real .git/hooks/pre-commit', () => {
  const dir = tmpDir('kit-install-');
  try {
    initRepo(dir, { '.githooks/pre-commit': '#!/bin/sh\nexit 0\n' });
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    assert.throws(() => installHooks(dir), /\.git\/hooks\/pre-commit exists/);
    assert.equal(runScript('install-hooks.mjs', ['--root', dir, '--force'], { cwd: dir }).status, 0);
  } finally { rmDir(dir); }
});

test('the install-hooks CLI works end to end', () => {
  const dir = tmpDir('kit-install-');
  try {
    initRepo(dir, { '.githooks/pre-commit': '#!/bin/sh\nexit 0\n' });
    const r = runScript('install-hooks.mjs', ['--root', dir], { cwd: dir });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /core\.hooksPath/);
    assert.match(runScript('install-hooks.mjs', ['--root', dir], { cwd: dir }).out, /already installed/);
  } finally { rmDir(dir); }
});

test('runPreCommit returns the failing status and sets RALPH_PRECOMMIT', () => {
  const lines = [];
  assert.equal(runPreCommit([], process.cwd(), { log: (l) => lines.push(l) }), 0);
  const code = runPreCommit([['node', '-e', 'process.exit(process.env.RALPH_PRECOMMIT === "1" ? 4 : 0)']], process.cwd(), { log: (l) => lines.push(l) });
  assert.equal(code, 4);
  assert.ok(lines.some((l) => /BLOCKED/.test(l)));
  assert.equal(runPreCommit([['definitely-not-a-command-xyz']], process.cwd(), { log: () => undefined }), 1);
});

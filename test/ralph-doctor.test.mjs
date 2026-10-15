import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmDir, initRepo, git, runScript, writeFiles, KIT } from './helpers/kit.mjs';
import { diagnose, which } from '../scripts/ralph-doctor.mjs';
import { installHooks } from '../scripts/install-hooks.mjs';

const by = (results, name) => results.find((r) => r.name === name);
// A fake agent that is guaranteed to exist: the node binary running the tests.
const agentEnv = { ...process.env, RALPH_AGENT_CMD: `"${process.execPath}"` };

function readyRepo(config = {}) {
  const dir = tmpDir('kit-doc-');
  initRepo(dir, { 'ralph.config.json': JSON.stringify(config), '.githooks/pre-commit': '#!/bin/sh\nexit 0\n', 'specs/.keep': '', '.ralph/SPECS_LEDGER.md': fs.readFileSync(path.join(KIT, 'templates', 'ledger.md'), 'utf8') });
  installHooks(dir);
  return dir;
}

test('a fully set-up checkout passes every check', () => {
  const dir = readyRepo();
  try {
    const results = diagnose(dir, { env: agentEnv });
    assert.deepEqual(results.filter((r) => r.status !== 'pass'), []);
  } finally { rmDir(dir); }
});

test('missing pieces are warnings (hooks, ledger, specs) and do not fail the run', () => {
  const dir = tmpDir('kit-doc-');
  try {
    initRepo(dir);
    const results = diagnose(dir, { env: agentEnv });
    for (const name of ['git hooks installed', 'ledger present', 'specs directory']) assert.equal(by(results, name).status, 'warn', name);
    const cli = runScript('ralph-doctor.mjs', ['--root', dir], { cwd: dir, env: { RALPH_AGENT_CMD: `"${process.execPath}"` } });
    assert.equal(cli.status, 0, cli.out);
    assert.match(cli.out, /WARN\s+ledger present/);
  } finally { rmDir(dir); }
});

test('an unusable agent command fails the run', () => {
  const dir = readyRepo({ agent: { command: 'definitely-not-installed-xyz' } });
  try {
    const results = diagnose(dir, { env: { ...process.env, RALPH_AGENT_CMD: '' } });
    assert.equal(by(results, 'agent CLI').status, 'fail');
    const cli = runScript('ralph-doctor.mjs', ['--root', dir], { cwd: dir, env: { RALPH_AGENT_CMD: '' } });
    assert.equal(cli.status, 1);
    assert.match(cli.out, /FAIL\s+agent CLI/);
    const viaEnv = diagnose(dir, { env: { ...process.env, RALPH_AGENT_CMD: 'node-missing-xyz script.mjs' } });
    assert.match(by(viaEnv, 'agent CLI').detail, /RALPH_AGENT_CMD/);
  } finally { rmDir(dir); }
});

test('an invalid ralph.config.json fails with the offending key', () => {
  const dir = readyRepo({ queue: { maxBuild: 'lots' } });
  try {
    const r = by(diagnose(dir, { env: agentEnv }), 'ralph.config.json parses');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /queue\.maxBuild/);
  } finally { rmDir(dir); }
});

test('jira tracker configuration is sanity-checked', () => {
  const bad = readyRepo({ tracker: { provider: 'jira' } });
  const good = readyRepo({ tracker: { provider: 'jira', jira: { project: 'ABC', site: 'x.atlassian.net' } } });
  try {
    const b = by(diagnose(bad, { env: agentEnv }), 'tracker config');
    assert.equal(b.status, 'fail');
    assert.match(b.detail, /PROJ/);
    assert.equal(by(diagnose(good, { env: agentEnv }), 'tracker config').status, 'pass');
  } finally { rmDir(bad); rmDir(good); }
});

test('not a git repository fails; hooks pointing elsewhere warn', () => {
  const plain = tmpDir('kit-doc-');
  const other = readyRepo();
  try {
    assert.equal(by(diagnose(plain, { env: agentEnv }), 'git repository').status, 'fail');
    git(other, ['config', 'core.hooksPath', 'elsewhere']);
    const h = by(diagnose(other, { env: agentEnv }), 'git hooks installed');
    assert.equal(h.status, 'warn');
    assert.match(h.detail, /elsewhere/);
  } finally { rmDir(plain); rmDir(other); }
});

test('an unwritable state directory fails (a file where the directory should be)', () => {
  const dir = readyRepo();
  try {
    fs.rmSync(path.join(dir, '.ralph'), { recursive: true });
    writeFiles(dir, { '.ralph': 'i am a file' });
    assert.equal(by(diagnose(dir, { env: agentEnv }), 'state dirs writable').status, 'fail');
  } finally { rmDir(dir); }
});

test('--json output is machine readable', () => {
  const dir = readyRepo();
  try {
    const r = runScript('ralph-doctor.mjs', ['--json', '--root', dir], { cwd: dir, env: { RALPH_AGENT_CMD: `"${process.execPath}"` } });
    assert.equal(r.status, 0, r.out);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.ok(j.checks.length >= 9);
  } finally { rmDir(dir); }
});

test('which resolves absolute paths and returns null for unknown commands', () => {
  assert.equal(which(process.execPath), process.execPath);
  assert.equal(which('definitely-not-installed-xyz'), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfig, findRoot, getCommand, deepMerge, validateConfig } from '../scripts/lib/config.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-config-'));
const write = (dir, text) => fs.writeFileSync(path.join(dir, 'ralph.config.json'), text);

test('no config file: loadConfig returns the defaults', () => {
  const dir = tmp();
  try {
    assert.deepEqual(loadConfig(dir), JSON.parse(JSON.stringify(DEFAULTS)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DEFAULTS match the contract schema', () => {
  assert.equal(DEFAULTS.project.stateDir, '.ralph');
  assert.deepEqual(DEFAULTS.queue, { buildChunk: 3, maxBuild: 40, maxReview: 8, minFreeGb: 4, maxRetries: 3, watchTimeoutMin: 45 });
  assert.equal(DEFAULTS.sweep.timeoutMin, 180);
  assert.equal(DEFAULTS.sweep.stallMin, 20);
  assert.deepEqual(DEFAULTS.gates.exitGate, ['lint', 'typecheck', 'build', 'test']);
  assert.equal(DEFAULTS.commands.test, null);
  assert.equal(DEFAULTS.tracker.provider, 'none');
  assert.equal(DEFAULTS.tracker.jira.transitions.exitGate, 'Review Required');
});

test('a partial file is deep-merged; arrays replace; unknown keys survive; BOM is tolerated', () => {
  const dir = tmp();
  try {
    write(dir, `﻿${JSON.stringify({
      project: { name: 'acme' },
      queue: { maxBuild: 10 },
      tests: { globs: ['**/*.t.js'] },
      commands: { test: 'npm test', lint: ['eslint', '.'] },
      custom: { keep: true },
    })}`);
    const c = loadConfig(dir);
    assert.equal(c.project.name, 'acme');
    assert.equal(c.project.baseBranch, 'main');
    assert.equal(c.queue.maxBuild, 10);
    assert.equal(c.queue.buildChunk, 3);
    assert.deepEqual(c.tests.globs, ['**/*.t.js']);
    assert.deepEqual(c.tests.ignore, ['**/node_modules/**']);
    assert.deepEqual(c.custom, { keep: true });
    assert.equal(DEFAULTS.project.name, 'my-project', 'defaults are never mutated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid JSON and invalid types give clear errors naming the file and every bad key', () => {
  const dir = tmp();
  try {
    write(dir, '{ nope');
    assert.throws(() => loadConfig(dir), /ralph\.config\.json: not valid JSON/);
    write(dir, '[1]');
    assert.throws(() => loadConfig(dir), /top level must be a JSON object/);
    write(dir, JSON.stringify({ queue: { maxBuild: 'lots' }, commands: { test: 42 }, tracker: { provider: 'trello' }, sweep: 5 }));
    assert.throws(() => loadConfig(dir), (err) => {
      assert.match(err.message, /invalid configuration/);
      assert.match(err.message, /"queue\.maxBuild" must be a non-negative number/);
      assert.match(err.message, /"commands\.test" must be null/);
      assert.match(err.message, /"tracker\.provider" must be "none" or "jira"/);
      assert.match(err.message, /"sweep" must be an object/);
      return true;
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('findRoot walks up to ralph.config.json, then to .git, then falls back to the start dir', () => {
  const dir = tmp();
  try {
    const deep = path.join(dir, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    write(path.join(dir, 'a'), '{}');
    assert.equal(findRoot(deep), path.join(dir, 'a'));

    const other = tmp();
    try {
      const sub = path.join(other, 'x');
      fs.mkdirSync(path.join(other, '.git'));
      fs.mkdirSync(sub);
      // The temp dir may sit under a directory that has a config; only assert the .git rule when it does not.
      const found = findRoot(sub);
      assert.ok(found === other || fs.existsSync(path.join(found, 'ralph.config.json')));
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('findRoot uses the kit directory when the start directory has no config above it', () => {
  const project = tmp();
  try {
    write(project, '{}');
    const kit = path.join(project, 'tools', 'kit');
    fs.mkdirSync(kit, { recursive: true });
    const elsewhere = tmp();
    try {
      const found = findRoot(elsewhere, { kitDir: kit });
      assert.ok(found === project || fs.existsSync(path.join(found, 'ralph.config.json')));
    } finally { fs.rmSync(elsewhere, { recursive: true, force: true }); }
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('getCommand normalises null, shell strings and argv arrays', () => {
  const config = deepMerge(DEFAULTS, { commands: { test: 'npm test', lint: ['node', 'lint.js', '--fix'], build: '   ' } });
  assert.equal(getCommand(config, 'typecheck'), null);
  assert.equal(getCommand(config, 'nonexistent'), null);
  assert.equal(getCommand(config, 'build'), null);
  assert.deepEqual(getCommand(config, 'test'), { kind: 'shell', command: 'npm test', args: [], display: 'npm test' });
  assert.deepEqual(getCommand(config, 'lint'), { kind: 'argv', command: 'node', args: ['lint.js', '--fix'], display: 'node lint.js --fix' });
});

test('validateConfig accepts the defaults', () => {
  assert.doesNotThrow(() => validateConfig(JSON.parse(JSON.stringify(DEFAULTS))));
});

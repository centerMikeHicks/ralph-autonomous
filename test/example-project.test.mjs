// The worked example under test/fixtures/example-project is the kit's reference: every verifier passes on it,
// and each mutation below is a negative case the corresponding verifier must catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyFixture, rmDir, runScript, KIT } from './helpers/kit.mjs';
import { loadConfig, DEFAULTS, deepMerge } from '../scripts/lib/config.mjs';

const withProject = (fn) => async () => { const dir = copyFixture(); try { await fn(dir); } finally { rmDir(dir); } };

test('every verifier passes on the worked example', withProject((dir) => {
  const spec = ['--spec', 'specs/hello.md'];
  for (const [script, args] of [
    ['lint-spec.mjs', [...spec, '--strict']],
    ['verify-plan-completeness.mjs', [...spec, '--strict']],
    ['verify-acceptance-bindings.mjs', [...spec, '--all']],
  ]) {
    const r = runScript(script, args, { cwd: dir });
    assert.equal(r.status, 0, `${script}\n${r.out}`);
  }
}));

test("the example's own tests pass with the node test runner", withProject((dir) => {
  const r = spawnSync(process.execPath, ['--test', 'src/hello.test.mjs', 'src/cli.integration.test.mjs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
}));

test('the example ledger has exactly one active row in the planned state', withProject((dir) => {
  const text = fs.readFileSync(path.join(dir, '.ralph', 'SPECS_LEDGER.md'), 'utf8');
  assert.match(text, /\| `specs\/hello\.md` \| Hello greeting \|.*\| planned \| yes \|/);
}));

test('negative: deleting a test fails bindings; dropping a task from the plan fails completeness; breaking the spec fails lint', withProject((dir) => {
  fs.rmSync(path.join(dir, 'src', 'cli.integration.test.mjs'));
  assert.equal(runScript('verify-acceptance-bindings.mjs', ['--spec', 'specs/hello.md', '--all'], { cwd: dir }).status, 1);

  const planFile = path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md');
  fs.writeFileSync(planFile, fs.readFileSync(planFile, 'utf8').replace(/  - \[ \] Build `run`[\s\S]*?cliPrintsGreeting\n/, ''));
  assert.equal(runScript('verify-plan-completeness.mjs', ['--spec', 'specs/hello.md', '--strict'], { cwd: dir }).status, 1);

  const specFile = path.join(dir, 'specs', 'hello.md');
  fs.writeFileSync(specFile, fs.readFileSync(specFile, 'utf8').replace('## Security Considerations', '## Notes'));
  assert.equal(runScript('lint-spec.mjs', ['--spec', 'specs/hello.md'], { cwd: dir }).status, 1);
}));

test('templates: config.example.json is a valid, complete configuration and the root config loads', () => {
  const example = JSON.parse(fs.readFileSync(path.join(KIT, 'templates', 'config.example.json'), 'utf8'));
  // Every default key is present in the example (it documents them all).
  const missing = [];
  const walk = (def, ex, prefix) => {
    for (const [k, v] of Object.entries(def)) {
      if (!(k in ex)) { missing.push(`${prefix}${k}`); continue; }
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, ex[k], `${prefix}${k}.`);
    }
  };
  walk(DEFAULTS, example, '');
  assert.deepEqual(missing, []);
  assert.ok(example.hooks && example.tests.layers);
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || process.env.TMPDIR || '/tmp'), 'kit-cfg-'));
  try {
    fs.writeFileSync(path.join(tmp, 'ralph.config.json'), JSON.stringify(example));
    assert.equal(loadConfig(tmp).tracker.provider, 'none');
  } finally { rmDir(tmp); }
  const root = loadConfig(KIT);
  assert.equal(root.commands.test, 'node --test');
  assert.deepEqual(deepMerge(DEFAULTS, {}), JSON.parse(JSON.stringify(DEFAULTS)));
});

test('templates: config.example.md documents every top-level key', () => {
  const md = fs.readFileSync(path.join(KIT, 'templates', 'config.example.md'), 'utf8');
  const example = JSON.parse(fs.readFileSync(path.join(KIT, 'templates', 'config.example.json'), 'utf8'));
  for (const key of Object.keys(example)) assert.match(md, new RegExp('^## ' + key + '( |$)', 'm'), key);
});

test('the shipped hook is LF-only POSIX sh', () => {
  const hook = fs.readFileSync(path.join(KIT, '.githooks', 'pre-commit'), 'utf8');
  assert.ok(hook.startsWith('#!/bin/sh\n'));
  assert.ok(!hook.includes('\r'));
  assert.match(hook, /verify-jira-sync\.mjs/);
  assert.match(hook, /run-precommit\.mjs/);
});

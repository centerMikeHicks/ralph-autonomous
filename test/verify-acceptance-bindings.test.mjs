import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixture, rmDir, runScript, writeFiles } from './helpers/kit.mjs';
import { parseTestDeclarations, parseNamedFunctions, layerOf } from '../scripts/lib/acceptance-bindings.mjs';

const run = (dir, args) => runScript('verify-acceptance-bindings.mjs', args, { cwd: dir });
const withProject = (fn) => async () => { const dir = copyFixture(); try { await fn(dir); } finally { rmDir(dir); } };
const unitTests = (dir) => path.join(dir, 'src', 'hello.test.mjs');

test('the worked example binds every row of every phase', withProject((dir) => {
  const r = run(dir, ['--spec', 'specs/hello.md', '--all']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /phase-1.*2\/2 row\(s\) bound/);
  assert.match(r.out, /phase-2.*1\/1/);
}));

test('only phases the plan ticks are checked by default (phase 1 is ticked in the example plan)', withProject((dir) => {
  const r = run(dir, ['--json']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(JSON.parse(r.stdout).phases.map((p) => p.key), ['phase-1']);
}));

test('a missing test is a finding (exit 1) with a message naming the test', withProject((dir) => {
  fs.writeFileSync(unitTests(dir), "import test from 'node:test';\ntest('greetsByName', () => { expect(1).toBe(1); });\n");
  const r = run(dir, ['--phase', '1']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /greetsTheWorldWithoutName/);
  assert.match(r.out, /missing/);
}));

test('a skipped or todo test does not bind', withProject((dir) => {
  fs.writeFileSync(unitTests(dir), [
    "import test from 'node:test';", "import assert from 'node:assert/strict';",
    "test.skip('greetsByName', () => { assert.ok(true); });",
    "test('greetsTheWorldWithoutName', { skip: true }, () => { assert.ok(true); });",
  ].join('\n'));
  const r = run(dir, ['--phase', 'phase-1', '--json']);
  assert.equal(r.status, 1);
  const kinds = JSON.parse(r.stdout).findings.map((f) => f.kind);
  assert.deepEqual(kinds, ['skipped', 'skipped']);
}));

test('a test with no assertion-looking call does not bind', withProject((dir) => {
  fs.writeFileSync(unitTests(dir), [
    "import test from 'node:test';",
    "test('greetsByName', () => { console.log('hi'); });",
    "test('greetsTheWorldWithoutName', () => { assert.equal(1, 1); });",
  ].join('\n'));
  const r = run(dir, ['--phase', '1', '--json']);
  assert.equal(r.status, 1);
  const f = JSON.parse(r.stdout).findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'no-assertion');
  assert.equal(f[0].name, 'greetsByName');
}));

test('with tests.layers configured, an [integration] row bound only by a unit-layer test fails', withProject((dir) => {
  fs.rmSync(path.join(dir, 'src', 'cli.integration.test.mjs'));
  writeFiles(dir, { 'src/cli.test.mjs': "import test from 'node:test';\ntest('cliPrintsGreeting', () => { assert.equal(1, 1); });\n" });
  const r = run(dir, ['--phase', '2', '--json']);
  assert.equal(r.status, 1);
  const f = JSON.parse(r.stdout).findings;
  assert.equal(f[0].kind, 'wrong-layer');
}));

test('without tests.layers the layer tag is not checked', withProject((dir) => {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'ralph.config.json'), 'utf8'));
  delete cfg.tests.layers;
  fs.writeFileSync(path.join(dir, 'ralph.config.json'), JSON.stringify(cfg));
  fs.rmSync(path.join(dir, 'src', 'cli.integration.test.mjs'));
  writeFiles(dir, { 'src/cli.test.mjs': "import test from 'node:test';\ntest('cliPrintsGreeting', () => { assert.equal(1, 1); });\n" });
  const r = run(dir, ['--phase', '2']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /layer tag is not checked/);
}));

test('a test bound by a named function (not a test title) counts', withProject((dir) => {
  fs.writeFileSync(unitTests(dir), [
    "import assert from 'node:assert/strict';",
    'function greetsByName() { assert.equal(1, 1); }',
    'export const greetsTheWorldWithoutName = () => { assert.ok(true); };',
  ].join('\n'));
  const r = run(dir, ['--phase', '1']);
  assert.equal(r.status, 0, r.out);
}));

test('an unnamed [unit] row is a finding', withProject((dir) => {
  const spec = path.join(dir, 'specs', 'hello.md');
  fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('- [ ] `[unit]` greetsByName', '- [ ] `[unit]`'));
  const r = run(dir, ['--phase', '1', '--json']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).findings[0].kind, 'unnamed');
}));

test('requireAcceptanceBindings=false makes the check a reported no-op', withProject((dir) => {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'ralph.config.json'), 'utf8'));
  cfg.gates = { requireAcceptanceBindings: false };
  fs.writeFileSync(path.join(dir, 'ralph.config.json'), JSON.stringify(cfg));
  fs.writeFileSync(unitTests(dir), '');
  const r = run(dir, ['--all']);
  assert.equal(r.status, 0);
  assert.match(r.out, /skipped/);
}));

test('usage errors exit 2: unknown option, missing spec file, unknown phase on --phase exits 1', withProject((dir) => {
  assert.equal(run(dir, ['--bogus']).status, 2);
  assert.equal(run(dir, ['--spec', 'specs/nope.md', '--all']).status, 2);
  assert.equal(run(dir, ['--phase', '9']).status, 1);
}));

test('parseTestDeclarations handles modifiers, describe, and quoting', () => {
  const src = [
    "describe('suiteName', () => { it('inner', () => { expect(1).toBe(1); }); });",
    "it.skip('skippedOne', () => { expect(1).toBe(1); });",
    "xit(\"xOne\", () => { expect(1).toBe(1); });",
    'test(`tmpl`, () => { /* expect( in a comment */ });',
    "test('todoOne', { todo: true }, () => { assert.ok(1); });",
  ].join('\n');
  const d = Object.fromEntries(parseTestDeclarations(src).map((x) => [x.title, x]));
  assert.equal(d.suiteName.kind, 'describe');
  assert.equal(d.suiteName.hasAssertion, true);
  assert.equal(d.skippedOne.skipped, true);
  assert.equal(d.xOne.skipped, true);
  assert.equal(d.tmpl.hasAssertion, false);
  assert.equal(d.todoOne.skipped, true);
  assert.equal(parseNamedFunctions('def test_it():\n    assert 1\n', 'test_it')[0].hasAssertion, true);
});

test('layerOf picks the highest matching layer and is null when unconfigured', () => {
  const layers = { unit: ['src/**'], integration: ['src/**/*.integration.*'], e2e: ['e2e/**'] };
  assert.equal(layerOf('src/a.integration.test.js', layers), 'integration');
  assert.equal(layerOf('e2e/x.js', layers), 'e2e');
  assert.equal(layerOf('lib/y.test.js', layers), 'unit');
  assert.equal(layerOf('src/a.js', undefined), null);
  assert.equal(layerOf('src/a.js', { unit: [], integration: [], e2e: [] }), null);
});

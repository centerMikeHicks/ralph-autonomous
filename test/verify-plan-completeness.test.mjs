import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixture, rmDir, runScript } from './helpers/kit.mjs';
import { checkPlanCompleteness, specInventory } from '../scripts/verify-plan-completeness.mjs';

const run = (dir, args) => runScript('verify-plan-completeness.mjs', args, { cwd: dir });
const withProject = (fn) => async () => { const dir = copyFixture(); try { await fn(dir); } finally { rmDir(dir); } };
const editPlan = (dir, fn) => {
  const p = path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md');
  fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
};

test('the worked example plan is complete under --strict', withProject((dir) => {
  const r = run(dir, ['--spec', 'specs/hello.md', '--strict']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /0 finding/);
}));

test('inventory covers table rows, named acceptance rows and in-scope decisions', () => {
  const spec = fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'example-project', 'specs', 'hello.md'), 'utf8');
  const { items, decisions } = specInventory(spec);
  const kinds = items.map((i) => `${i.kind}:${i.id}`);
  assert.ok(kinds.includes('data-model:greeting message'));
  assert.ok(kinds.includes('service-change:cli'));
  assert.ok(kinds.includes('acceptance:greetsByName'));
  assert.ok(kinds.includes('acceptance:cliPrintsGreeting'));
  assert.ok(kinds.includes('decision:D1'));
  assert.equal(decisions[0].inScope, true);
});

test('a decision marked out of scope is not required in the plan', () => {
  const spec = '## Technical Design\n\n### Decisions\n\n**D1 — Export is not built in v1**\nDeferred.\n\n**D2 — Sync ships in phase 1**\n';
  const { items } = specInventory(spec);
  assert.deepEqual(items.map((i) => i.id), ['D2']);
});

test('an acceptance test the plan never names is UNREFERENCED (strict exit 1, advisory exit 0)', withProject((dir) => {
  editPlan(dir, (t) => t.replace('Tests: cliPrintsGreeting', 'Tests: something'));
  const strict = run(dir, ['--spec', 'specs/hello.md', '--strict']);
  assert.equal(strict.status, 1);
  assert.match(strict.out, /UNREFERENCED\s+acceptance.*cliPrintsGreeting/);
  const advisory = run(dir, ['--spec', 'specs/hello.md']);
  assert.equal(advisory.status, 0);
  assert.match(advisory.out, /advisory/);
}));

test('an in-scope decision the plan never cites is UNREFERENCED', withProject((dir) => {
  editPlan(dir, (t) => t.replace(' (D1) [sonnet]', ' [sonnet]').replace('- D1 — The greeting', '- Decision one — The greeting'));
  const r = run(dir, ['--spec', 'specs/hello.md', '--strict', '--json']);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout).unreferenced.map((u) => u.id), ['D1']);
}));

test('a reference from an open task without Files: is reported as NO FILES', withProject((dir) => {
  editPlan(dir, (t) => t.replace('    Files: src/cli.mjs, src/cli.integration.test.mjs\n', ''));
  const r = run(dir, ['--spec', 'specs/hello.md', '--strict']);
  assert.equal(r.status, 1);
  assert.match(r.out, /TASK NO FILES/);
  assert.match(r.out, /NO FILES:/);
}));

test('a completed task is exempt from Files:', () => {
  const spec = '### Data Model\n\n| Item | Change |\n|---|---|\n| `widgetStore` | new |\n';
  const plan = '## Phases\n- [x] **Phase 1: A**\n  - [x] Build widgetStore\n';
  const r = checkPlanCompleteness(spec, plan);
  assert.equal(r.unreferenced.length + r.withoutFiles.length, 0);
});

test('usage: missing plan exits 2', withProject((dir) => {
  fs.rmSync(path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md'));
  assert.equal(run(dir, ['--spec', 'specs/hello.md']).status, 2);
}));

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

// --- stable ids ----------------------------------------------------------------------------------
const readFixture = (rel) => fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'example-project', rel), 'utf8').replace(/\r\n/g, '\n');
const idSpec = () => readFixture('specs/hello.md');
const idPlan = () => readFixture('.ralph/IMPLEMENTATION_PLAN.md');
const lineOf = (plan, needle) => plan.split('\n').findIndex((l) => l.includes(needle)) + 1;

test('planWithoutIdsHasNoIdFindings', () => {
  const r = checkPlanCompleteness(idSpec(), idPlan());
  assert.deepEqual(r.missingIds, []);
  assert.deepEqual(r.repeatedIds, []);
});

test('mixedPlanReportsTaskWithoutId', () => {
  const plan = idPlan()
    .replace('Build `formatGreeting`', 'P1.T1 Build `formatGreeting`')
    .replace('Build `run`', 'P2.T1 Build `run`')
    .replace('    Tests: cliPrintsGreeting', '    Tests: cliPrintsGreeting\n  - [ ] Print the exit code [sonnet]\n    Files: src/cli.mjs');
  const r = checkPlanCompleteness(idSpec(), plan);
  assert.deepEqual(r.missingIds, [{ line: lineOf(plan, 'Print the exit code'), text: '- [ ] Print the exit code [sonnet]' }]);
  assert.deepEqual(r.repeatedIds, []);
});

test('repeatedIdReported', () => {
  const plan = idPlan()
    .replace('Build `formatGreeting`', 'P1.T1 Build `formatGreeting`')
    .replace('Build `run`', 'P1.T1 Build `run`');
  const r = checkPlanCompleteness(idSpec(), plan);
  assert.deepEqual(r.repeatedIds, [{ id: 'P1.T1', lines: [lineOf(plan, 'Build `formatGreeting`'), lineOf(plan, 'Build `run`')] }]);
});

test('testRowsAndOpenQuestionsNeedNoId', () => {
  const plan = idPlan()
    .replace('Build `formatGreeting`', 'P1.T1 Build `formatGreeting`')
    .replace('Build `run`', 'P2.T1 Build `run`')
    .replace('    Tests: cliPrintsGreeting', '    Tests: cliPrintsGreeting\n  - [ ] `[unit]` cliPrintsGreeting is the row, not a task')
    .replace('## Open Questions / Blocked\n\nNone.', '## Open Questions / Blocked\n\n- [ ] [product] Is the greeting localised?');
  const r = checkPlanCompleteness(idSpec(), plan);
  assert.deepEqual(r.missingIds, []);
  assert.deepEqual(r.repeatedIds, []);
});

test('strictFailsOnIdFindings', withProject((dir) => {
  editPlan(dir, (p) => p
    .replace('Build `run`', 'P2.T1 Build `run`')
    .replace('    Tests: cliPrintsGreeting', '    Tests: cliPrintsGreeting\n  - [ ] Print the exit code [sonnet]\n    Files: src/cli.mjs'));
  const loose = run(dir, ['--spec', 'specs/hello.md']);
  assert.equal(loose.status, 0, loose.out);
  assert.match(loose.out, /MISSING ID/);
  const strict = run(dir, ['--spec', 'specs/hello.md', '--strict']);
  assert.equal(strict.status, 1, strict.out);
  assert.match(strict.out, /MISSING ID/);
}));

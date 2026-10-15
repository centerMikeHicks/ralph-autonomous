import test from 'node:test';
import assert from 'node:assert/strict';
import { isExitGateNext, nextTask, isMechanicalTask, allPhasesDone, planView, planActiveSpec } from '../ralph/lib/plan-parse.mjs';
import { selectModel, describeStrategy } from '../ralph/lib/model-select.mjs';

const models = {
  planning: 'opus', execution: 'sonnet', mechanical: 'haiku', review: 'opus',
  efforts: { planning: 'high', execution: 'medium', mechanical: 'low', exitGate: 'high' },
};

const PLAN = `# Implementation Plan
## Status: planned
## Active Spec
\`specs/demo.md\`
## Phases
- [x] **Phase 1: Done**
  - [x] old task
- [ ] **Phase 2: Work** ← NEXT
  - [x] finished task
  - [ ] implement the widget
  - [ ] regenerate the docs
- [ ] **Phase 3: Later**
  - [ ] later task
- [ ] **Exit Gate**
## Decisions
- D1 - something
`;

test('nextTask returns the first unchecked task under the NEXT phase, not a later phase', () => {
  assert.equal(nextTask(PLAN), 'implement the widget');
});

test('nextTask accepts the ASCII <- NEXT marker and CRLF', () => {
  assert.equal(nextTask(PLAN.replace('←', '<-').replace(/\n/g, '\r\n')), 'implement the widget');
});

test('nextTask without a marker uses the first unchecked task in the file', () => {
  assert.equal(nextTask(PLAN.replace(' ← NEXT', '')), 'implement the widget');
});

test('nextTask is empty when the NEXT phase has no unchecked task or there is no plan', () => {
  assert.equal(nextTask('- [ ] **Phase 1** <- NEXT\n- [ ] **Phase 2**\n  - [ ] other'), '');
  assert.equal(nextTask(''), '');
});

test('isMechanicalTask: tags and regex', () => {
  for (const t of ['x [haiku]', 'x [mechanical]', '[DOC] write the guide', 'Regenerate the types', 're-run the suite',
    'rerun suite', 're-capture shots', 'codemod the imports', 'rename foo to bar', 'reformat tree',
    'update the ledger row', 'update the changelog', 'update the docs', 'bump version to 2']) {
    assert.equal(isMechanicalTask(t), true, t);
  }
  for (const t of ['implement the widget', 'fix the parser', 'add tests for rename handling', '']) {
    assert.equal(isMechanicalTask(t), false, t);
  }
});

test('[sonnet] overrides the mechanical regex, [haiku] wins when both absent of sonnet', () => {
  assert.equal(isMechanicalTask('regenerate the schema [sonnet]'), false);
  assert.equal(isMechanicalTask('regenerate the schema [haiku]'), true);
});

test('isExitGateNext: explicit marker, first-unchecked fallback, and negatives', () => {
  assert.equal(isExitGateNext('- [x] **Phase 1**\n- [ ] **Exit Gate** ← NEXT\n'), true);
  assert.equal(isExitGateNext('- [x] **Phase 1**\n- [ ] **Exit Gate** <- NEXT\n'), true);
  assert.equal(isExitGateNext('- [x] **Phase 1**\n- [ ] **Exit Gate**\n'), true);
  assert.equal(isExitGateNext(PLAN), false);
  assert.equal(isExitGateNext(''), false);
});

test('allPhasesDone requires at least one phase and all ticked', () => {
  assert.equal(allPhasesDone(PLAN), false);
  assert.equal(allPhasesDone(PLAN.replace(/\[ \]/g, '[x]')), true);
  assert.equal(allPhasesDone('# nothing'), false);
});

test('planView keeps the status, overview and only the NEXT phase in full', () => {
  const view = planView(PLAN);
  assert.match(view, /## Status: planned/);
  assert.match(view, /Phase 3: Later/);
  assert.match(view, /implement the widget/);
  assert.doesNotMatch(view, /later task/);
  assert.doesNotMatch(view, /D1/);
});

test('planActiveSpec reads the backticked path', () => {
  assert.equal(planActiveSpec(PLAN), 'specs/demo.md');
});

test('selection matrix', () => {
  const pick = (mode, planText = '', forced = '') => selectModel({ mode, planText, models, forced });
  assert.deepEqual(pick('plan'), { model: 'opus', effort: 'high', tier: 'planning', reason: 'plan mode' });
  assert.equal(pick('review').model, 'opus');
  assert.equal(pick('review').effort, 'high');
  // routine build task
  assert.deepEqual([pick('build', PLAN).model, pick('build', PLAN).effort], ['sonnet', 'medium']);
  // mechanical-tagged next task
  const tagged = PLAN.replace('implement the widget', 'implement the widget [haiku]');
  assert.deepEqual([pick('build', tagged).model, pick('build', tagged).effort, pick('build', tagged).tier], ['haiku', 'low', 'mechanical']);
  // mechanical by regex
  const regen = PLAN.replace('implement the widget', 'regenerate the client');
  assert.equal(pick('build', regen).tier, 'mechanical');
  // [sonnet] tag beats the regex
  assert.equal(pick('build', regen.replace('client', 'client [sonnet]')).tier, 'execution');
  // Exit Gate -> execution model at exitGate effort
  const gate = '- [x] **Phase 1**\n  - [x] t\n- [ ] **Exit Gate** <- NEXT\n';
  assert.deepEqual([pick('build', gate).model, pick('build', gate).effort, pick('build', gate).tier], ['sonnet', 'high', 'exit-gate']);
  // a mechanical task wins over the Exit Gate fallback, matching the production order
  const gateTask = '- [ ] **Exit Gate** <- NEXT\n  - [ ] re-run the full suite\n';
  assert.equal(pick('build', gateTask).tier, 'mechanical');
  // never the planning model in build
  assert.notEqual(pick('build', PLAN).model, 'opus');
});

test('a forced model wins everywhere and sends no effort', () => {
  for (const mode of ['plan', 'build', 'review']) {
    const sel = selectModel({ mode, planText: PLAN, models, forced: 'custom-1' });
    assert.equal(sel.model, 'custom-1');
    assert.equal(sel.effort, '');
    assert.equal(sel.tier, 'forced');
  }
});

test('describeStrategy mentions the tiers', () => {
  assert.match(describeStrategy({ mode: 'build', models }), /sonnet\/medium.*haiku\/low.*sonnet\/high/);
  assert.match(describeStrategy({ mode: 'plan', models, forced: 'x' }), /^x \(forced/);
});

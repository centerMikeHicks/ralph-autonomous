import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixture, rmDir, runScript, KIT } from './helpers/kit.mjs';
import { lintSpec, findContradictions } from '../scripts/lint-spec.mjs';

const SPEC = fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'example-project', 'specs', 'hello.md'), 'utf8');
const rules = (text, opts) => lintSpec(text, opts).findings.map((f) => f.rule);

test('the worked example and the spec template are clean even under --strict', () => {
  for (const text of [SPEC, fs.readFileSync(path.join(KIT, 'templates', 'spec.md'), 'utf8')]) {
    const r = lintSpec(text, { strict: true });
    assert.deepEqual(r.findings, []);
  }
});

test('missing front matter and missing required sections are errors', () => {
  const text = SPEC.replace(/^---[\s\S]*?---\n/, '').replace('## Security Considerations', '## Something else');
  const r = lintSpec(text);
  assert.ok(r.findings.some((f) => f.rule === 'front-matter'));
  assert.ok(r.findings.some((f) => f.rule === 'section' && /Security Considerations/.test(f.message)));
  assert.ok(r.errors >= 2);
});

test('with tracker.provider jira, tracker_issue is required in the front matter', () => {
  assert.ok(rules(SPEC, { trackerProvider: 'jira' }).includes('front-matter'));
  assert.ok(!rules(SPEC.replace('# tracker_issue: PROJ-1', 'tracker_issue: PROJ-1'), { trackerProvider: 'jira' }).includes('front-matter'));
});

test('a phase without an Acceptance Tests block, or with an empty one, is an error', () => {
  const noBlock = SPEC.replace(/### Phase 2: CLI entry[\s\S]*?### Exit Gate/, '### Phase 2: CLI entry\n\nNothing.\n\n### Exit Gate');
  assert.ok(rules(noBlock).includes('phase-acceptance'));
  const empty = SPEC.replace(/- \[ \] `\[integration\]` cliPrintsGreeting[^\n]*\n/, '');
  assert.ok(lintSpec(empty).findings.some((f) => f.rule === 'phase-acceptance' && /no rows/.test(f.message)));
});

test('an untagged row and an unnamed row are errors', () => {
  const untagged = SPEC.replace('- [ ] `[unit]` greetsByName', '- [ ] greetsByName');
  assert.ok(rules(untagged).includes('row-tag'));
  const unnamed = SPEC.replace('`[unit]` greetsByName —', '`[unit]` —');
  assert.ok(rules(unnamed).includes('row-name'));
});

test('a row without Given/When/Then is advisory, and an error under --strict', () => {
  const text = SPEC.replace('— Given the name "Ada", When formatting, Then the result is "Hello, Ada!" (SC1)', '— it works (SC1)');
  const loose = lintSpec(text);
  assert.ok(loose.findings.some((f) => f.rule === 'row-form' && f.severity === 'advisory'));
  assert.equal(loose.errors, 0);
  const strict = lintSpec(text, { strict: true });
  assert.ok(strict.errors > 0);
});

test('a success criterion cited by no row is an error', () => {
  const text = SPEC.replace('- [ ] SC2: The CLI prints', '- [ ] SC3: Orphan criterion. The CLI prints');
  const f = lintSpec(text).findings.filter((x) => x.rule === 'sc-trace');
  assert.ok(f.some((x) => /SC3/.test(x.message)));
});

test('open questions must be tagged; "none" is allowed', () => {
  const bad = SPEC.replace('- [x] `[tooling]` Which test runner?', '- [ ] Which test runner?');
  assert.ok(rules(bad).includes('open-question'));
  assert.ok(!rules(SPEC.replace(/- \[x\] `\[tooling\]`[^\n]*\n/, '- None\n')).includes('open-question'));
});

test('bare TODO is an error but TODO in code spans and fences is not', () => {
  assert.ok(rules(`${SPEC}\nTODO decide this\n`).includes('todo'));
  assert.ok(!rules(`${SPEC}\nUse the \`TODO\` marker.\n\n\`\`\`\nTODO in a fence\n\`\`\`\n`).includes('todo'));
});

test('a decision id defined twice is an error', () => {
  assert.ok(rules(`${SPEC}\n**D1 — Again**\n`).includes('decision-dup'));
});

test('contradictory affordance words about one subject are an error; grep rows are advisory', () => {
  const c = findContradictions('Then Publish is disabled and Publish is hidden');
  assert.ok(c.some((x) => x.severity === 'error' && x.subject === 'publish'));
  const text = SPEC.replace('Then the result is "Hello, world!" (SC1)', 'Then Save is disabled and Save is hidden (SC1)');
  assert.ok(rules(text).includes('contradiction'));
  const grep = SPEC.replace('Then the result is "Hello, world!" (SC1)', 'Then grep returns nothing (SC1)');
  const r = lintSpec(grep);
  assert.ok(r.findings.some((f) => f.rule === 'grep-row' && f.severity === 'advisory'));
});

test('CLI: exit codes, --json, --strict and usage', () => {
  const dir = copyFixture();
  try {
    const ok = runScript('lint-spec.mjs', ['--spec', 'specs/hello.md', '--strict'], { cwd: dir });
    assert.equal(ok.status, 0, ok.out);
    const specFile = path.join(dir, 'specs', 'hello.md');
    fs.writeFileSync(specFile, `${SPEC}\nTODO later\n`);
    const bad = runScript('lint-spec.mjs', ['--spec', 'specs/hello.md', '--json'], { cwd: dir });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).findings[0].rule, 'todo');
    assert.equal(runScript('lint-spec.mjs', ['--spec', 'specs/none.md'], { cwd: dir }).status, 2);
    assert.equal(runScript('lint-spec.mjs', ['--bad'], { cwd: dir }).status, 2);
  } finally { rmDir(dir); }
});

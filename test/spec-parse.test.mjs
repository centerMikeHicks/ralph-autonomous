import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAcceptanceRow, parseSpecPhases, parseSuccessCriteria, parseDecisions, parsePlan, planPhaseOf,
  parseFrontMatter, findSpecPhase, tableRows, sectionLines, splitLines,
} from '../scripts/lib/spec-parse.mjs';
import { globToRegExp, compileGlobs, walkFiles } from '../scripts/lib/glob.mjs';
import { parseArgs } from '../scripts/lib/args.mjs';
import { FIXTURE, tmpDir, rmDir, writeFiles } from './helpers/kit.mjs';

test('parseAcceptanceRow reads both tag/name spellings', () => {
  const a = parseAcceptanceRow('- [ ] `[unit]` doesThing — Given a, When b, Then c');
  assert.equal(a.tag, 'unit');
  assert.equal(a.name, 'doesThing');
  assert.equal(a.kind, 'test');
  assert.match(a.text, /^Given a/);
  const b = parseAcceptanceRow('- [x] `[integration] otherThing` — Given a');
  assert.equal(b.name, 'otherThing');
  assert.equal(b.ticked, true);
  assert.equal(parseAcceptanceRow('- [ ] `[integration]` `quoted` — Given').name, 'quoted');
});

test('parseAcceptanceRow classifies visual-only, none, command and unnamed rows', () => {
  assert.equal(parseAcceptanceRow('- [ ] `[visual-only]` — look at it').kind, 'visual-only');
  assert.equal(parseAcceptanceRow('- [ ] `[e2e]` — none: no deployed surface').kind, 'none');
  assert.equal(parseAcceptanceRow('- [ ] `[unit]` `npm test` exits 0').kind, 'command');
  assert.equal(parseAcceptanceRow('- [ ] `[unit]` — Given a, When b, Then c').kind, 'unnamed');
  assert.equal(parseAcceptanceRow('- [ ] plain checkbox'), null);
  assert.equal(parseAcceptanceRow('not a row'), null);
});

test('parseSpecPhases attaches rows, wraps continuation lines and finds the Exit Gate', () => {
  const spec = [
    '## Implementation Plan', '', '### Phase 1: First', '', '**Acceptance Tests**', '',
    '- [ ] `[unit]` one — Given a,', '  When b, Then c', '- [ ] `[unit]` two — Given', '',
    '### Phase 2b: Second', '**Acceptance Tests**', '- [ ] `[e2e]` — none: nothing', '',
    '### Exit Gate', '**Acceptance Tests**', '- [ ] `[unit]` three — x', '', '## Edge Cases',
  ].join('\n');
  const phases = parseSpecPhases(spec);
  assert.deepEqual(phases.map((p) => p.key), ['phase-1', 'phase-2b', 'exit-gate']);
  assert.equal(phases[0].rows.length, 2);
  assert.match(phases[0].rows[0].text, /When b, Then c/);
  assert.equal(phases[0].hasAcceptanceBlock, true);
  assert.equal(findSpecPhase(phases, 'exit-gate').key, 'exit-gate');
});

test('rows inside code fences are ignored', () => {
  const spec = ['### Phase 1: A', '**Acceptance Tests**', '```', '- [ ] `[unit]` fenced — x', '```', '- [ ] `[unit]` real — x'].join('\n');
  assert.deepEqual(parseSpecPhases(spec)[0].rows.map((r) => r.name), ['real']);
});

test('success criteria, decisions and front matter', () => {
  const spec = '---\ntracker_issue: PROJ-9\nother: "q"\n---\n- [ ] SC1: first\n- [x] **SC-2**: second\n**D3 — title**\n  more text\nD4: plain\n';
  assert.deepEqual(parseSuccessCriteria(spec).map((s) => s.id), ['SC1', 'SC2']);
  assert.deepEqual(parseDecisions(spec).map((d) => d.id), ['D3', 'D4']);
  assert.match(parseDecisions(spec)[0].text, /more text/);
  const fm = parseFrontMatter(spec);
  assert.equal(fm.present, true);
  assert.equal(fm.data.tracker_issue, 'PROJ-9');
  assert.equal(fm.data.other, 'q');
  assert.equal(parseFrontMatter('# no front matter').present, false);
  assert.equal(parseFrontMatter('---\na: b\n').unterminated, true);
});

test('parsePlan reads phases, NEXT, gate, tasks, Files and Tests; planPhaseOf anchors at column 0', () => {
  const plan = [
    '## Phases',
    '- [x] **Phase 1: Alpha**', '  gate: `node --version`',
    '  - [x] do it [sonnet]', '    Files: a.js, b.js', '    Tests: t1, t2',
    '- [ ] **Phase 2: Beta** <- NEXT', '  - [ ] later',
    '- [ ] **Exit Gate**',
  ].join('\n');
  const phases = parsePlan(plan);
  assert.deepEqual(phases.map((p) => p.key), ['phase-1', 'phase-2', 'exit-gate']);
  assert.equal(phases[0].gate, '`node --version`');
  assert.deepEqual(phases[0].tasks[0].files, ['a.js', 'b.js']);
  assert.deepEqual(phases[0].tasks[0].tests, ['t1', 't2']);
  assert.equal(phases[1].next, true);
  assert.equal(phases[1].title, 'Beta');
  assert.equal(planPhaseOf('  - [x] Exit Gate sweep'), null);
});

test('tables and sections', () => {
  const lines = splitLines('### Data Model\n\n| A | B |\n|---|---|\n| x | y |\n| z | w |\n\n### Next\n| no | table |');
  const rows = tableRows(sectionLines(lines, /^###\s+Data Model/));
  assert.deepEqual(rows.map((r) => r.cells), [['x', 'y'], ['z', 'w']]);
});

test('the worked example spec parses to its three phases', () => {
  const phases = parseSpecPhases(fs.readFileSync(path.join(FIXTURE, 'specs', 'hello.md'), 'utf8'));
  assert.deepEqual(phases.map((p) => p.key), ['phase-1', 'phase-2', 'exit-gate']);
  assert.deepEqual(phases.map((p) => p.rows.length), [2, 1, 2]);
});

test('glob matching: **, *, ?, braces, and ignore during a walk', () => {
  assert.ok(globToRegExp('**/*.test.*').test('a/b/c.test.js'));
  assert.ok(globToRegExp('**/*.test.*').test('c.test.js'));
  assert.ok(!globToRegExp('*.js').test('a/b.js'));
  assert.ok(globToRegExp('src/**').test('src/a/b.js'));
  assert.ok(globToRegExp('x/*.{js,ts}').test('x/a.ts'));
  assert.ok(!globToRegExp('x/*.{js,ts}').test('x/a.md'));
  assert.ok(compileGlobs(['a?.js'])('ab.js'));
  const dir = tmpDir();
  try {
    writeFiles(dir, { 'a.test.js': '', 'node_modules/p/b.test.js': '', 'sub/c.test.js': '' });
    assert.deepEqual(walkFiles(dir, ['**/node_modules/**']), ['a.test.js', 'sub/c.test.js']);
  } finally { rmDir(dir); }
});

test('parseArgs accepts --k v and --k=v, flags, and rejects unknown options', () => {
  const a = parseArgs(['--spec', 'a.md', '--plan=p.md', '--json', 'pos'], { flags: ['json'], opts: ['spec', 'plan'] });
  assert.equal(a.spec, 'a.md');
  assert.equal(a.plan, 'p.md');
  assert.equal(a.json, true);
  assert.deepEqual(a._, ['pos']);
  assert.throws(() => parseArgs(['--nope'], {}), /unknown option/);
  assert.throws(() => parseArgs(['--spec'], { opts: ['spec'] }), /needs a value/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmDir, runScript, KIT } from './helpers/kit.mjs';
import { parseLedger, diffLedgers, checklist, LEDGER_COLUMNS } from '../scripts/lane-merge-notes.mjs';

const HEAD = '| Spec | Title | Created | Last updated | State | Active? | Commits | Notes |\n|---|---|---|---|---|---|---|---|\n';
const row = (spec, state, extra = '') => `| \`${spec}\` | T | 2026-01-01 | 2026-01-02 | ${state} | no | ${extra || '—'} | n |\n`;
const ledger = (...rows) => `## Active\n\n${HEAD}${rows.join('')}\n## Recently shipped\n\n${HEAD}`;

test('parseLedger reads rows with their section and columns; the template parses to none', () => {
  const rows = parseLedger(ledger(row('specs/a.md', 'planned')));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].spec, 'specs/a.md');
  assert.equal(rows[0].section, 'Active');
  assert.equal(rows[0].cells.State, 'planned');
  assert.equal(parseLedger(fs.readFileSync(path.join(KIT, 'templates', 'ledger.md'), 'utf8')).length, 0);
});

test('the ledger template has the four sections and the exact columns', () => {
  const text = fs.readFileSync(path.join(KIT, 'templates', 'ledger.md'), 'utf8');
  assert.deepEqual([...text.matchAll(/^## (.*)$/gm)].map((m) => m[1]), ['Active', 'Recently shipped', 'Superseded / paused', 'Backlog (not started)']);
  assert.equal([...text.matchAll(/^\| Spec \|.*$/gm)].length, 4);
  for (const line of text.matchAll(/^\| Spec \|.*$/gm)) assert.equal(line[0], `| ${LEDGER_COLUMNS.join(' | ')} |`);
});

test('diffLedgers reports lane-only, integration-only and changed rows', () => {
  const integration = ledger(row('specs/a.md', 'planned'), row('specs/b.md', 'built'), row('specs/only-main.md', 'drafted'));
  const lane = ledger(row('specs/a.md', 'reviewed', 'abc123'), row('specs/b.md', 'built'), row('specs/only-lane.md', 'planned'));
  const d = diffLedgers(integration, lane);
  assert.deepEqual(d.onlyInLane.map((r) => r.spec), ['specs/only-lane.md']);
  assert.deepEqual(d.onlyInIntegration.map((r) => r.spec), ['specs/only-main.md']);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].spec, 'specs/a.md');
  assert.equal(d.changed[0].laneAhead, true);
  assert.deepEqual(d.changed[0].columns.sort(), ['Commits', 'State']);
});

test('checklist covers the merge-back steps', () => {
  const text = checklist({ lane: 'main-lane-x', base: 'main', spec: 'hello' }).join('\n');
  for (const needle of ['reviewed', 'IMPLEMENTATION_PLAN.hello.md', 'git merge main-lane-x', 'row by row', 'push', 'git pull']) assert.ok(text.includes(needle), needle);
});

test('CLI prints the checklist and, with two ledgers, the diff', () => {
  const dir = tmpDir('kit-lmn-');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), ledger(row('specs/a.md', 'planned')));
    fs.writeFileSync(path.join(dir, 'b.md'), ledger(row('specs/a.md', 'built')));
    const plain = runScript('lane-merge-notes.mjs', ['--lane', 'x', '--base', 'main'], { cwd: dir });
    assert.equal(plain.status, 0, plain.out);
    assert.match(plain.out, /Merge-back checklist/);
    assert.doesNotMatch(plain.out, /Ledger diff/);
    const diff = runScript('lane-merge-notes.mjs', ['--ledger-a', 'a.md', '--ledger-b', 'b.md'], { cwd: dir });
    assert.match(diff.out, /~ specs\/a\.md: planned -> built \(lane is further along\)/);
    const json = JSON.parse(runScript('lane-merge-notes.mjs', ['--ledger-a', 'a.md', '--ledger-b', 'b.md', '--json'], { cwd: dir }).stdout);
    assert.equal(json.diff.changed.length, 1);
    assert.equal(runScript('lane-merge-notes.mjs', ['--ledger-a', 'a.md'], { cwd: dir }).status, 2);
    assert.equal(runScript('lane-merge-notes.mjs', ['--ledger-a', 'a.md', '--ledger-b', 'missing.md'], { cwd: dir }).status, 2);
  } finally { rmDir(dir); }
});

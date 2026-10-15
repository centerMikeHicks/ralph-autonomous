import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport, fmt, readJsonl, table, toolCalls } from '../ralph/report.mjs';

function stateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-report-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('fmt renders seconds compactly', () => {
  assert.equal(fmt(9), '9s');
  assert.equal(fmt(125), '2m05s');
  assert.equal(fmt(3900), '1h05m');
});

test('readJsonl tolerates a BOM, CRLF, torn lines and a missing file', () => {
  const { dir, cleanup } = stateDir();
  try {
    const file = path.join(dir, 'x.jsonl');
    fs.writeFileSync(file, `﻿{"a":1}\r\n{"a":2}\r\n{broken\r\n`);
    assert.deepEqual(readJsonl(file), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(readJsonl(path.join(dir, 'nope.jsonl')), []);
  } finally { cleanup(); }
});

test('table aligns columns', () => {
  const lines = table(['name', 'n'], [['aa', 1], ['b', 22]]);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith('name'));
});

test('reports a clear message when there are no iterations', () => {
  const { dir, cleanup } = stateDir();
  try {
    assert.match(buildReport({ stateDir: dir }), /No iterations found/);
  } finally { cleanup(); }
});

test('buildReport covers phases, outcomes, the gap with its bracketing events, and slowest tool calls', () => {
  const { dir, cleanup } = stateDir();
  try {
    const t0 = Date.parse('2026-03-01T10:00:00Z');
    const iso = (s) => new Date(t0 + s * 1000).toISOString();
    const transcript = path.join(dir, 'iter1.jsonl');
    const line = (ms, content) => `tag\t${ms}\t${JSON.stringify({ message: { content } })}`;
    fs.writeFileSync(transcript, [
      line(1000, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { description: 'run the tests' } }]),
      line(61000, [{ type: 'tool_result', tool_use_id: 't1' }]),
      line(62000, [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.txt' } }]),
      line(63000, [{ type: 'tool_result', tool_use_id: 't2' }]),
    ].join('\n'));
    assert.deepEqual(toolCalls(transcript).map((c) => [c.name, c.label, c.dur_s]), [['Bash', 'run the tests', 60], ['Read', 'Read a.txt', 1]]);

    fs.writeFileSync(path.join(dir, 'iterations.jsonl'), jsonl([
      { spec: 'a', run: 'r1', iter: 1, phase: 'Phase 1', outcome: 'committed', committed: true, started_at: iso(0), ended_at: iso(100), dur_s: 100, api_s: 60, tool_s: 30, overhead_s: 10, gap_s: 0, cost_usd: 1.5, transcript },
      { spec: 'a', run: 'r1', iter: 2, phase: 'Phase 1', outcome: 'blocked', committed: false, started_at: iso(1000), ended_at: iso(1100), dur_s: 100, api_s: 50, tool_s: 40, overhead_s: 10, gap_s: 900, cost_usd: 0.5 },
      { spec: 'a', run: 'r2', iter: 3, phase: 'Exit Gate', outcome: 'aborted', committed: false, started_at: iso(1200), ended_at: iso(1260), dur_s: 60, gap_s: 100, cost_usd: null },
    ]));
    fs.writeFileSync(path.join(dir, 'loop-events.jsonl'), jsonl([
      { ts: iso(500), event: 'loop_stop', reason: 'human' },
      { ts: iso(990), event: 'loop_start' },
    ]));

    const text = buildReport({ stateDir: dir, gap: 300 });
    assert.match(text, /Time per phase \(3 iterations/);
    assert.match(text, /Phase 1/);
    assert.match(text, /TOTAL/);
    assert.match(text, /1 aborted iteration\(s\), cost unknown/);
    assert.match(text, /=== Outcomes ===/);
    assert.match(text, /blocked/);
    assert.match(text, /15m00s before iter 2/);
    assert.match(text, /loop_stop reason=human/);
    assert.match(text, /Slowest tool calls \(1 retained transcript/);
    assert.match(text, /run the tests/);

    const filtered = buildReport({ stateDir: dir, spec: 'nomatch' });
    assert.match(filtered, /No iterations found/);
    const since = buildReport({ stateDir: dir, since: '2030-01-01' });
    assert.match(since, /No iterations found/);
  } finally { cleanup(); }
});

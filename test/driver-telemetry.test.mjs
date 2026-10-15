import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildIterationRow, readIterationStatus, resolveOutcome, transcriptMetrics, usageLogRow, writeIterationRecord,
  parseTranscript, createEventLog, readJsonl, USAGE_HEADER,
} from '../ralph/lib/telemetry.mjs';
import { readText } from '../ralph/lib/fsutil.mjs';

const j = JSON.stringify;
const TRANSCRIPT = [
  j({ type: 'system', subtype: 'init' }),
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: '1', name: 'Bash', input: { command: 'node --test test/' } }, { type: 'tool_use', id: '2', name: 'Read', input: {} }] } }),
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: '3', name: 'Agent', input: {} }, { type: 'tool_use', id: '4', name: 'Bash', input: { command: 'ls' } }] } }),
  'not json at all',
  j({ type: 'result', duration_ms: 10000, duration_api_ms: 4000, num_turns: 7, total_cost_usd: 0.5, is_error: false, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }),
];

test('transcriptMetrics counts tools, tests and sub-agents and reads the result event', () => {
  const m = transcriptMetrics(TRANSCRIPT);
  assert.equal(m.tool_calls, 4);
  assert.deepEqual(m.tools, { Bash: 2, Read: 1, Agent: 1 });
  assert.equal(m.tests_run, 1);
  assert.equal(m.subagents, 1);
  assert.equal(m.duration_ms, 10000);
  assert.equal(m.api_ms, 4000);
  assert.equal(m.turns, 7);
  assert.equal(m.cost, 0.5);
  assert.deepEqual([m.input, m.output, m.cache_r, m.cache_w], [1, 2, 3, 4]);
});

test('an empty or truncated transcript yields zeros, not an exception', () => {
  assert.equal(transcriptMetrics([]).tool_calls, 0);
  assert.equal(transcriptMetrics(['{"type":"result","dur']).turns, 0);
  assert.equal(parseTranscript(['﻿{"a":1}', '', 'x']).length, 1);
});

test('readIterationStatus: fresh, stale, missing, and BOM-prefixed files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-st-'));
  try {
    const file = path.join(dir, 'ITERATION_STATUS.json');
    assert.equal(readIterationStatus(file, Date.now()).fresh, false);
    fs.writeFileSync(file, `﻿${j({ spec: 's', phase: 'P1', outcome: 'blocked', did: 'd', committed: true })}`);
    const fresh = readIterationStatus(file, Date.now() - 1000);
    assert.equal(fresh.fresh, true);
    assert.equal(fresh.outcome, 'blocked');
    assert.equal(fresh.committed, true);
    const stale = readIterationStatus(file, Date.now() + 60000);
    assert.equal(stale.fresh, false);
    assert.equal(stale.outcome, 'unknown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveOutcome corrects a missing status with git and exit code', () => {
  const none = { fresh: false, outcome: 'unknown' };
  assert.equal(resolveOutcome({ status: none, headMoved: true, exitCode: 0 }), 'committed(no-status)');
  assert.equal(resolveOutcome({ status: none, headMoved: false, exitCode: 3 }), 'error(exit 3)');
  assert.equal(resolveOutcome({ status: { fresh: true, outcome: 'progressed' }, headMoved: false, exitCode: 0 }), 'progressed');
});

function sampleRow(over = {}) {
  return buildIterationRow({
    run: 'r1', iter: 2, branch: 'main', specName: 'demo', mode: 'build', modelLabel: 'sonnet (medium)',
    startMs: Date.parse('2026-01-01T00:00:00Z'), endMs: Date.parse('2026-01-01T00:00:20Z'), gapS: 4.26, exitCode: 0,
    headBefore: 'aaa', headAfter: 'bbb',
    status: { fresh: true, spec: 'demo', phase: 'Phase 1', outcome: 'committed', did: 'x | y', result: 'r', next: 'n' },
    metrics: transcriptMetrics(TRANSCRIPT), transcript: '.ralph/logs/demo/t.jsonl', ...over,
  });
}

test('iterations row carries every contract field and the derived timings', () => {
  const row = sampleRow();
  for (const k of ['ts', 'run', 'iter', 'branch', 'spec', 'mode', 'model', 'phase', 'outcome', 'status_fresh', 'committed',
    'head_before', 'head_after', 'did', 'result', 'next', 'transcript', 'dur_s', 'api_s', 'tool_s', 'overhead_s', 'gap_s']) {
    assert.ok(k in row, `missing ${k}`);
  }
  assert.equal(row.committed, true);
  assert.equal(row.dur_s, 20);
  assert.equal(row.api_s, 4);
  assert.equal(row.tool_s, 6);
  assert.equal(row.overhead_s, 10);
  assert.equal(row.gap_s, 4.3);
  assert.equal(row.spec, 'demo');
});

test('usage log row escapes pipes and matches the header column count', () => {
  const line = usageLogRow(sampleRow());
  assert.doesNotMatch(line, /x \| y/);
  const header = USAGE_HEADER.split('\n').find((l) => l.startsWith('| timestamp'));
  assert.equal(line.split(' | ').length, header.split(' | ').length);
});

test('writeIterationRecord and events write BOM-free, parseable files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-tel-'));
  try {
    writeIterationRecord(dir, sampleRow());
    writeIterationRecord(dir, sampleRow({ iter: 3 }));
    const emit = createEventLog(dir, 'r1');
    emit('loop_start', { mode: 'build' });
    emit('loop_stop', { reason: 'completed' });
    for (const f of ['iterations.jsonl', 'USAGE_LOG.md', 'loop-events.jsonl']) {
      assert.notEqual(fs.readFileSync(path.join(dir, f))[0], 0xef, `${f} has a BOM`);
    }
    assert.equal(readJsonl(path.join(dir, 'iterations.jsonl')).length, 2);
    assert.deepEqual(readJsonl(path.join(dir, 'loop-events.jsonl')).map((e) => e.event), ['loop_start', 'loop_stop']);
    assert.equal(readText(path.join(dir, 'USAGE_LOG.md')).split('\n').filter((l) => l.startsWith('| 2026')).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonl tolerates a BOM on the first line and junk lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-jl-'));
  try {
    const f = path.join(dir, 'x.jsonl');
    fs.writeFileSync(f, '﻿{"a":1}\r\n{bad\r\n{"a":2}\r\n');
    assert.deepEqual(readJsonl(f).map((r) => r.a), [1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the row names the driver\'s active spec even when the agent reports another name', () => {
  const row = sampleRow({ status: { fresh: true, spec: 'something-else', phase: 'P', outcome: 'committed', did: '', result: '', next: '' } });
  assert.equal(row.spec, 'demo');
});

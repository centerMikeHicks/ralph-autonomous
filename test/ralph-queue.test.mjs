import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const q = require('../scripts/ralph-queue.cjs');
const { parseQueue, updateQueueLine, ledgerState, nextMode, classifyInvocation, parseArgs, read, jsonlLines, startArgs, makeContext, driveSpec } = q;

const queue = ['# Queue', '- [x] specs/a.md — reviewed', '- [ ] specs/b.md', 'notes', '- [!] specs/c.md — blocked: needs a waiver'].join('\r\n');

test('reads an iteration file whose first line starts with a BOM (PowerShell 5.1 created it)', () => {
  const text = '﻿{"spec":"a","iter":1}\r\n{"spec":"a","iter":2}\r\n';
  const rows = jsonlLines(text).map((line) => JSON.parse(line));
  assert.deepEqual(rows, [{ spec: 'a', iter: 1 }, { spec: 'a', iter: 2 }]);
  assert.notEqual(classifyInvocation(rows, 0).kind, 'blocked');
});

test('parses queue entries with their marker, spec and note', () => {
  assert.deepEqual(parseQueue(queue), [
    { index: 1, marker: 'x', spec: 'specs/a.md', note: 'reviewed' },
    { index: 2, marker: ' ', spec: 'specs/b.md', note: '' },
    { index: 4, marker: '!', spec: 'specs/c.md', note: 'blocked: needs a waiver' },
  ]);
});

test('rewrites one entry in place and keeps CRLF', () => {
  const next = updateQueueLine(queue, 2, '!', 'blocked in build: D60');
  assert.equal(next.split('\r\n')[2], '- [!] specs/b.md — blocked in build: D60');
  assert.equal(next.split('\r\n').length, 5);
  assert.throws(() => updateQueueLine(queue, 3, 'x', ''), /not a queue entry/);
});

test('reads a spec state from the ledger table', () => {
  const ledger = [
    '| Spec | Title | Created | Last updated | State | Active? | Commits | Notes |',
    '|------|-------|---------|--------------|-------|---------|---------|-------|',
    '| `specs/b.md` | B | 2026-09-23 | 2026-09-24 | planned | yes | — | n |',
  ].join('\n');
  assert.equal(ledgerState(ledger, 'specs/b.md'), 'planned');
  assert.equal(ledgerState(ledger, 'specs/zzz.md'), null);
});

test('picks the next loop mode from the ledger state and the active spec', () => {
  assert.equal(nextMode('drafted', 'specs/b.md', 'specs/b.md'), 'plan');
  assert.equal(nextMode('planned', 'specs/b.md', 'specs/b.md\n'), 'build');
  assert.equal(nextMode('planned', 'specs/b.md', 'specs/other.md'), 'plan');
  assert.equal(nextMode('built', 'specs/b.md', 'specs/b.md'), 'review');
  assert.equal(nextMode('built', 'specs/b.md', 'specs/x.md'), 'plan');
  assert.equal(nextMode('reviewed', 'specs/b.md', ''), 'done');
  assert.equal(nextMode('shipped', 'specs/b.md', ''), 'done');
  assert.equal(nextMode('superseded', 'specs/b.md', ''), 'skip');
  assert.equal(nextMode('paused', 'specs/b.md', ''), 'skip');
  assert.equal(nextMode('mystery', 'specs/b.md', ''), 'skip');
  assert.equal(nextMode(null, 'specs/new.md', ''), 'plan');
});

test('classifyInvocation: a killed or aborted invocation is interrupted, never a stop', () => {
  assert.equal(classifyInvocation([], 1).kind, 'interrupted');
  assert.equal(classifyInvocation([{ outcome: 'aborted', committed: false }], 0).kind, 'interrupted');
  assert.equal(classifyInvocation([{ outcome: 'error(exit 1)', committed: false }], 1).kind, 'interrupted');
  assert.deepEqual(classifyInvocation([], 0), { kind: 'blocked', reason: 'loop ran no iteration' });
});

test('classifyInvocation: parks on a reported blocker with its reason', () => {
  const verdict = classifyInvocation([{ outcome: 'committed', committed: true }, { outcome: 'blocked', committed: false, next: 'A person decides D60' }], 0);
  assert.deepEqual(verdict, { kind: 'blocked', reason: 'A person decides D60' });
  assert.equal(classifyInvocation([{ outcome: 'failed', committed: false, result: 'tests red' }], 0).kind, 'blocked');
});

test('classifyInvocation: committed, progressed and waiting iterations are progress', () => {
  assert.deepEqual(classifyInvocation([{ outcome: 'committed', committed: true }], 0), { kind: 'progressed', committed: true });
  assert.equal(classifyInvocation([{ outcome: 'waiting', committed: false }], 0).kind, 'progressed');
  assert.equal(classifyInvocation([{ outcome: 'failed', committed: false }, { outcome: 'progressed', committed: true }], 0).kind, 'progressed');
});

test('read strips a leading BOM so a file PowerShell created with -Encoding UTF8 still parses', () => {
  const file = path.join(os.tmpdir(), `ralph-queue-bom-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(file, `﻿${JSON.stringify({ outcome: 'committed' })}\n`);
  try {
    assert.deepEqual(read(file).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)), [{ outcome: 'committed' }]);
    assert.equal(read(path.join(os.tmpdir(), 'ralph-queue-does-not-exist')), '');
  } finally { fs.unlinkSync(file); }
});

test('parseArgs: config defaults, flag overrides, validation', () => {
  assert.equal(parseArgs(['run']).maxBuild, 40);
  assert.equal(parseArgs(['watch']).timeoutMin, 45);
  const withDefaults = parseArgs(['run', '--min-free-gb', '6'], { buildChunk: 5, maxBuild: 12, minFreeGb: 1 });
  assert.deepEqual([withDefaults.command, withDefaults.buildChunk, withDefaults.maxBuild, withDefaults.minFreeGb], ['run', 5, 12, 6]);
  assert.equal(parseArgs(['run', '--queue', 'q.md']).queue, path.resolve('q.md'));
  assert.throws(() => parseArgs(['run', '--nope']), /Unknown flag/);
  assert.throws(() => parseArgs(['run', '--max-build', 'x']), /non-negative number/);
  assert.throws(() => parseArgs(['run', '--queue']), /needs a value/);
});

test('startArgs: the runner outlives the session that starts it and has no idle ceiling', () => {
  const ctx = makeContext(path.join(os.tmpdir(), 'proj'));
  const args = startArgs({ queue: 'Q.md', buildChunk: 5, maxBuild: 25, minFreeGb: 4, maxRetries: 2 }, ctx);
  const sweepArgs = args.slice(0, args.indexOf('--'));
  for (const flag of ['run', '--service', '--detached', '--idle-min']) assert.ok(sweepArgs.includes(flag), flag);
  assert.equal(sweepArgs[sweepArgs.indexOf('--idle-min') + 1], '0');
  assert.equal(sweepArgs[sweepArgs.indexOf('--dir') + 1], path.join(ctx.queueDir, 'runner'));
  const runnerArgs = args.slice(args.indexOf('--') + 1);
  assert.ok(runnerArgs.includes('run'));
  assert.equal(runnerArgs[runnerArgs.indexOf('--queue') + 1], 'Q.md');
  assert.equal(runnerArgs[runnerArgs.indexOf('--max-retries') + 1], '2');
});

// ---- driveSpec against a temp project with a scripted loop ----

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-proj-'));
  fs.mkdirSync(path.join(root, '.ralph'), { recursive: true });
  const ctx = makeContext(root);
  fs.mkdirSync(ctx.queueDir, { recursive: true });
  const ledger = (state) => `| Spec | Title | Created | Last updated | State | Active? | Commits | Notes |\n|---|---|---|---|---|---|---|---|\n| \`specs/a.md\` | A | d | d | ${state} | yes | - | - |\n`;
  const setState = (state) => fs.writeFileSync(ctx.ledger, ledger(state));
  const row = (outcome, extra = {}) => fs.appendFileSync(ctx.iterations, `${JSON.stringify({ spec: 'a', outcome, committed: outcome === 'committed', ...extra })}\n`);
  const queueFile = path.join(ctx.queueDir, 'QUEUE.md');
  fs.writeFileSync(queueFile, '- [ ] specs/a.md\n');
  const opts = { queue: queueFile, buildChunk: 2, maxBuild: 4, minFreeGb: 0, maxRetries: 1 };
  return { root, ctx, setState, row, opts, queueFile, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('driveSpec walks drafted -> planned -> built -> reviewed and marks the queue entry done', async () => {
  const p = project();
  try {
    p.setState('drafted');
    const modes = [];
    p.ctx.runLoop = async (mode) => {
      modes.push(mode);
      p.row('committed');
      if (mode === 'plan') { p.setState('planned'); fs.writeFileSync(p.ctx.activeSpec, 'specs/a.md'); }
      if (mode === 'build') p.setState('built');
      if (mode === 'review') p.setState('reviewed');
      return { exitCode: 0, logFile: path.join(p.ctx.queueDir, 'x.log') };
    };
    const entry = parseQueue(fs.readFileSync(p.queueFile, 'utf8'))[0];
    assert.equal(await driveSpec(entry, p.opts, p.ctx), 'done');
    assert.deepEqual(modes, ['plan', 'build', 'review']);
    assert.match(fs.readFileSync(p.queueFile, 'utf8'), /^- \[x\] specs\/a\.md — reviewed /);
    const events = fs.readFileSync(p.ctx.events, 'utf8');
    assert.match(events, /"spec_done"/);
  } finally { p.cleanup(); }
});

test('driveSpec parks a spec whose loop reports blocked, with the reason', async () => {
  const p = project();
  try {
    p.setState('planned');
    fs.writeFileSync(p.ctx.activeSpec, 'specs/a.md');
    p.ctx.runLoop = async () => { p.row('blocked', { next: 'needs a decision' }); return { exitCode: 0, logFile: 'l.log' }; };
    const entry = parseQueue(fs.readFileSync(p.queueFile, 'utf8'))[0];
    assert.equal(await driveSpec(entry, p.opts, p.ctx), 'parked');
    assert.match(fs.readFileSync(p.queueFile, 'utf8'), /^- \[!\] specs\/a\.md — blocked in build: needs a decision/);
  } finally { p.cleanup(); }
});

test('driveSpec retries an interrupted invocation, then parks after maxRetries', async () => {
  const p = project();
  try {
    p.setState('planned');
    fs.writeFileSync(p.ctx.activeSpec, 'specs/a.md');
    let calls = 0;
    p.ctx.runLoop = async () => { calls++; return { exitCode: 1, logFile: path.join(p.root, 'l.log') }; };
    const entry = parseQueue(fs.readFileSync(p.queueFile, 'utf8'))[0];
    assert.equal(await driveSpec(entry, p.opts, p.ctx), 'parked');
    assert.equal(calls, 2);
    assert.match(fs.readFileSync(p.queueFile, 'utf8'), /interrupted 2 times/);
  } finally { p.cleanup(); }
});

test('driveSpec caps build iterations and parks a spec that never reaches built', async () => {
  const p = project();
  try {
    p.setState('planned');
    fs.writeFileSync(p.ctx.activeSpec, 'specs/a.md');
    const counts = [];
    p.ctx.runLoop = async (mode, count) => { counts.push(count); for (let i = 0; i < count; i++) p.row('progressed'); return { exitCode: 0, logFile: 'l.log' }; };
    const entry = parseQueue(fs.readFileSync(p.queueFile, 'utf8'))[0];
    assert.equal(await driveSpec(entry, p.opts, p.ctx), 'parked');
    assert.deepEqual(counts, [2, 2]);
    assert.match(fs.readFileSync(p.queueFile, 'utf8'), /build cap 4 reached/);
  } finally { p.cleanup(); }
});

test('driveSpec parks a plan that twice leaves the ledger where it was; STOP ends the drive', async () => {
  const p = project();
  try {
    p.setState('drafted');
    p.ctx.runLoop = async () => { p.row('progressed'); return { exitCode: 0, logFile: 'l.log' }; };
    const entry = parseQueue(fs.readFileSync(p.queueFile, 'utf8'))[0];
    assert.equal(await driveSpec(entry, p.opts, p.ctx), 'parked');
    assert.match(fs.readFileSync(p.queueFile, 'utf8'), /plan ran twice without committing or moving the ledger/);

    fs.writeFileSync(p.queueFile, '- [ ] specs/a.md\n');
    fs.writeFileSync(p.ctx.stop, 'now');
    assert.equal(await driveSpec(entry, p.opts, p.ctx), 'stopped');
  } finally { p.cleanup(); }
});

test('driveSpec keeps a review that commits fixes running, and parks it at the review cap', async () => {
  const p = project();
  try {
    p.setState('built');
    fs.writeFileSync(p.ctx.activeSpec, 'specs/a.md');
    let passes = 0;
    p.ctx.runLoop = async () => { passes++; p.row('committed'); return { exitCode: 0, logFile: 'l.log' }; };
    const entry = parseQueue(fs.readFileSync(p.queueFile, 'utf8'))[0];
    assert.equal(await driveSpec(entry, { ...p.opts, maxReview: 3 }, p.ctx), 'parked');
    assert.equal(passes, 3);
    assert.match(fs.readFileSync(p.queueFile, 'utf8'), /review cap 3 reached without a clean pass/);
  } finally { p.cleanup(); }
});

test('driveSpec still parks a review that twice neither commits nor moves the ledger', async () => {
  const p = project();
  try {
    p.setState('built');
    fs.writeFileSync(p.ctx.activeSpec, 'specs/a.md');
    p.ctx.runLoop = async () => { p.row('progressed'); return { exitCode: 0, logFile: 'l.log' }; };
    const entry = parseQueue(fs.readFileSync(p.queueFile, 'utf8'))[0];
    assert.equal(await driveSpec(entry, { ...p.opts, maxReview: 8 }, p.ctx), 'parked');
    assert.match(fs.readFileSync(p.queueFile, 'utf8'), /review ran twice without committing or moving the ledger/);
  } finally { p.cleanup(); }
});

test('parseArgs and startArgs carry --max-review', () => {
  assert.equal(parseArgs(['run']).maxReview, 8);
  assert.equal(parseArgs(['run', '--max-review', '3']).maxReview, 3);
  const args = startArgs({ queue: 'Q.md', buildChunk: 5, maxBuild: 25, maxReview: 6, minFreeGb: 4, maxRetries: 2 }, makeContext(path.join(os.tmpdir(), 'proj')));
  assert.equal(args[args.indexOf('--max-review') + 1], '6');
});

test('driveSpec parks specs whose ledger state is not runnable', async () => {
  const p = project();
  try {
    p.setState('paused');
    const entry = parseQueue(fs.readFileSync(p.queueFile, 'utf8'))[0];
    assert.equal(await driveSpec(entry, p.opts, p.ctx), 'parked');
    assert.match(fs.readFileSync(p.queueFile, 'utf8'), /ledger state 'paused'/);
  } finally { p.cleanup(); }
});

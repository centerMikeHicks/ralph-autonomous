#!/usr/bin/env node
/**
 * Ralph queue runner: carries a list of specs through `ralph/loop` plan -> build
 * -> review, one spec at a time, without needing an agent session to stay awake.
 *
 *   node scripts/ralph-queue.cjs start   [--queue F] [runner flags]   launch the runner detached (sweep --service)
 *   node scripts/ralph-queue.cjs run     [--queue F] [runner flags]   the runner itself (foreground)
 *   node scripts/ralph-queue.cjs status  [--queue F]                  queue, current spec, last events
 *   node scripts/ralph-queue.cjs watch   [--timeout-min 45]           block until the runner logs a new event or exits
 *   node scripts/ralph-queue.cjs stop                                 finish the current loop invocation, then exit
 *
 * Runner flags (defaults from `queue.*` in ralph.config.json): --build-chunk 3 (build
 * iterations per invocation), --max-build 40 (build iterations per spec before it is
 * parked), --min-free-gb 4 (wait for this much free memory before each invocation),
 * --max-retries 3 (re-runs of an interrupted invocation), --timeout-min 45 (watch).
 *
 * Queue file (default `.claude-temp/ralph-queue/QUEUE.md`), one spec per line:
 *   - [ ] specs/next.md          pending
 *   - [x] specs/done.md — ...    reviewed
 *   - [!] specs/stuck.md — ...   parked: needs a person (reason follows)
 * The runner rewrites the marker and reason in place; edit the file to add,
 * reorder or re-queue specs (change `[!]` back to `[ ]`).
 *
 * Where a spec starts is read from its `<stateDir>/SPECS_LEDGER.md` state, so a
 * queue resumes where the last run left off: drafted -> plan; planned -> build
 * (re-plan first when `<stateDir>/ACTIVE_SPEC` names another spec); built -> review;
 * reviewed/shipped -> done; paused/superseded -> parked.
 *
 * An interruption is not a stop: an invocation that dies (killed, reaped for
 * memory, aborted iteration) is retried after free memory is back above the
 * floor. Only a loop that reports `blocked`, a phase that makes no progress, or
 * the build cap parks a spec, and the runner moves on to the next one.
 *
 * The project root is the nearest directory holding ralph.config.json (else the
 * kit's parent, else the nearest .git directory, else the current directory);
 * RALPH_ROOT overrides.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const { acquireKeepAwake } = require('./lib/keep-awake.cjs');

const KIT_SCRIPTS = __dirname;
const QUEUE_LINE = /^(\s*-\s*\[)([ x!])(\]\s*)(\S+\.md)(.*)$/;

/** Runner defaults when ralph.config.json says nothing (mirrors config.mjs DEFAULTS.queue). */
const FALLBACK_OPTS = { buildChunk: 3, maxBuild: 40, maxReview: 8, minFreeGb: 4, maxRetries: 3, timeoutMin: 45 };

// ---------- pure helpers (unit-tested) ----------

/** Parse the queue file into entries `{ index, marker, spec, note }` (index = line number). */
function parseQueue(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const m = QUEUE_LINE.exec(line);
    if (m) entries.push({ index, marker: m[2], spec: m[4], note: m[5].replace(/^\s*—\s*/, '').trim() });
  });
  return entries;
}

/** Rewrite one queue line's marker and note, preserving the file's line endings. */
function updateQueueLine(text, index, marker, note) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const m = QUEUE_LINE.exec(lines[index]);
  if (!m) throw new Error(`queue line ${index + 1} is not a queue entry`);
  lines[index] = `${m[1]}${marker}${m[3]}${m[4]}${note ? ` — ${note}` : ''}`;
  return lines.join(eol);
}

/** The ledger state of a spec (`drafted`, `planned`, `built`, ...) or null when it has no row. */
function ledgerState(ledgerText, spec) {
  const specCell = `\`${spec.replace(/\\/g, '/')}\``;
  for (const line of ledgerText.split(/\r?\n/)) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells[1] === specCell) return (cells[5] || '').toLowerCase() || null;
  }
  return null;
}

/** Which loop mode a spec needs next, from its ledger state and the active spec. */
function nextMode(state, spec, activeSpec) {
  const active = (activeSpec || '').trim().replace(/\\/g, '/');
  switch (state) {
    case 'drafted':
      return 'plan';
    case 'planned':
      return active === spec ? 'build' : 'plan';
    case 'built':
      return active === spec ? 'review' : 'plan';
    case 'reviewed':
    case 'shipped':
      return 'done';
    case 'paused':
    case 'superseded':
      return 'skip';
    default:
      return state ? 'skip' : 'plan';
  }
}

/**
 * Classify one loop invocation from the iteration rows it appended and its exit:
 *   interrupted: the process died or an iteration was aborted (retry);
 *   blocked:     the last iteration reported blocked, or failed with nothing committed (park);
 *   progressed:  anything else (re-read the ledger and carry on).
 */
function classifyInvocation(rows, exitCode) {
  if (rows.some((r) => r.outcome === 'aborted')) return { kind: 'interrupted' };
  if (rows.length === 0) return { kind: exitCode === 0 ? 'blocked' : 'interrupted', reason: exitCode === 0 ? 'loop ran no iteration' : undefined };
  const last = rows[rows.length - 1];
  const anyCommit = rows.some((r) => r.committed);
  if (last.outcome === 'blocked' || (last.outcome === 'failed' && !anyCommit)) {
    return { kind: 'blocked', reason: (last.next || last.result || last.outcome || '').slice(0, 300) };
  }
  if (/^error/.test(last.outcome || '') && !anyCommit) return { kind: 'interrupted' };
  return { kind: 'progressed', committed: anyCommit };
}

const NUMERIC_FLAGS = {
  '--build-chunk': 'buildChunk',
  '--max-build': 'maxBuild',
  '--max-review': 'maxReview',
  '--min-free-gb': 'minFreeGb',
  '--max-retries': 'maxRetries',
  '--timeout-min': 'timeoutMin',
};

/**
 * Parse `command [flags]`. `defaults` supplies the numeric options (from the config's
 * `queue.*`) and the default `queue` path; a flag overrides it.
 */
function parseArgs(argv, defaults = {}) {
  const [command = 'status', ...rest] = argv;
  const opts = { command, queue: null, ...FALLBACK_OPTS, ...defaults };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) throw new Error(`${flag} needs a value`);
      return rest[++i];
    };
    if (flag === '--queue') opts.queue = path.resolve(value());
    else if (NUMERIC_FLAGS[flag]) {
      const raw = value();
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} expects a non-negative number, got ${JSON.stringify(raw)}`);
      opts[NUMERIC_FLAGS[flag]] = n;
    } else throw new Error(`Unknown flag: ${flag}`);
  }
  return opts;
}

/** Every path the runner touches, for one project root. */
function makeContext(root, { stateDirName = '.ralph' } = {}) {
  const absRoot = path.resolve(root);
  const queueDir = path.join(absRoot, '.claude-temp', 'ralph-queue');
  const stateDir = path.join(absRoot, stateDirName);
  return {
    root: absRoot,
    queueDir,
    defaultQueue: path.join(queueDir, 'QUEUE.md'),
    events: path.join(queueDir, 'events.jsonl'),
    state: path.join(queueDir, 'state.json'),
    stop: path.join(queueDir, 'STOP'),
    ledger: path.join(stateDir, 'SPECS_LEDGER.md'),
    activeSpec: path.join(stateDir, 'ACTIVE_SPEC'),
    iterations: path.join(stateDir, 'iterations.jsonl'),
    runLoop: null,
  };
}

// ---------- side-effecting runner ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// PowerShell 5.1's `-Encoding UTF8` writes a BOM when it creates a file (Add-Content in
// ralph/loop.ps1 does this for iterations.jsonl on the very first row), and Node's utf8
// decoder leaves that BOM in the string instead of stripping it. Left in place, it breaks
// JSON.parse on the file's first line, which would misclassify a genuinely-committed
// iteration as "loop ran no iteration" and park the spec.
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^﻿/, '') : '');

/** The lines of a JSONL file, BOM- and CRLF-tolerant, blanks dropped. */
function jsonlLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^﻿/, ''))
    .filter(Boolean);
}

function logEvent(ctx, event) {
  fs.mkdirSync(ctx.queueDir, { recursive: true });
  const record = { ts: new Date().toISOString(), ...event };
  fs.appendFileSync(ctx.events, `${JSON.stringify(record)}\n`);
  console.log(`[ralph-queue] ${record.ts} ${event.event}${event.spec ? ` ${event.spec}` : ''}${event.mode ? ` ${event.mode}` : ''}${event.detail ? ` — ${event.detail}` : ''}`);
}

function readState(ctx) {
  try {
    return fs.existsSync(ctx.state) ? JSON.parse(read(ctx.state)) : {};
  } catch {
    return {};
  }
}

function writeState(ctx, patch) {
  fs.mkdirSync(ctx.queueDir, { recursive: true });
  fs.writeFileSync(ctx.state, JSON.stringify({ ...readState(ctx), ...patch, updated: new Date().toISOString() }, null, 2));
}

function iterationRowCount(ctx) {
  return jsonlLines(read(ctx.iterations)).length;
}

function iterationRowsSince(ctx, count, specName) {
  return jsonlLines(read(ctx.iterations))
    .slice(count)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row && (!specName || row.spec === specName));
}

async function waitForMemory(ctx, minFreeGb) {
  let logged = false;
  while (os.freemem() / 1024 ** 3 < minFreeGb) {
    if (fs.existsSync(ctx.stop)) return false;
    if (!logged) {
      logEvent(ctx, { event: 'memory_wait', detail: `${(os.freemem() / 1024 ** 3).toFixed(1)} GB free < ${minFreeGb} GB` });
      logged = true;
    }
    await sleep(60_000);
  }
  if (logged) logEvent(ctx, { event: 'memory_ok', detail: `${(os.freemem() / 1024 ** 3).toFixed(1)} GB free` });
  return true;
}

/** The loop driver for this OS: `[command, args]` for `mode count [spec]`. */
function loopCommand(ctx, mode, count, spec) {
  const loopArgs = [mode, String(count), ...(mode === 'plan' ? [spec] : [])];
  const dir = fs.existsSync(path.join(ctx.root, 'ralph')) ? path.join(ctx.root, 'ralph') : path.resolve(KIT_SCRIPTS, '..', 'ralph');
  return process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'loop.ps1'), ...loopArgs]]
    : ['bash', [path.join(dir, 'loop.sh'), ...loopArgs]];
}

/** Run one `ralph/loop` invocation to completion, streaming its output to a log file. */
function runLoop(ctx, mode, count, spec) {
  if (typeof ctx.runLoop === 'function') return ctx.runLoop(mode, count, spec);
  fs.mkdirSync(ctx.queueDir, { recursive: true });
  const logFile = path.join(ctx.queueDir, `loop-${path.basename(spec, '.md')}-${mode}-${Date.now()}.log`);
  const [cmd, args] = loopCommand(ctx, mode, count, spec);
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(cmd, args, { cwd: ctx.root, stdio: ['ignore', out, out], shell: false });
    writeState(ctx, { loopPid: child.pid, loopLog: logFile });
    child.on('error', (error) => {
      fs.closeSync(out);
      resolve({ exitCode: -1, logFile, error: String(error) });
    });
    child.on('exit', (code, signal) => {
      fs.closeSync(out);
      resolve({ exitCode: code === null ? -1 : code, signal, logFile });
    });
  });
}

function markQueue(queueFile, entry, marker, note) {
  fs.writeFileSync(queueFile, updateQueueLine(read(queueFile), entry.index, marker, note));
}

/** Carry one spec as far as it will go. Returns 'done' | 'parked' | 'stopped'. */
async function driveSpec(entry, opts, ctx) {
  const spec = entry.spec.replace(/\\/g, '/');
  const specName = path.basename(spec, '.md');
  let buildIterations = 0;
  let reviewPasses = 0;
  let retries = 0;
  let lastMode = null;
  let sameModeNoProgress = 0;

  for (;;) {
    if (fs.existsSync(ctx.stop)) return 'stopped';
    const state = ledgerState(read(ctx.ledger), spec);
    const mode = nextMode(state, spec, read(ctx.activeSpec));
    if (mode === 'done') {
      markQueue(opts.queue, entry, 'x', `${state} ${new Date().toISOString().slice(0, 16)}`);
      logEvent(ctx, { event: 'spec_done', spec, detail: state });
      return 'done';
    }
    if (mode === 'skip') {
      markQueue(opts.queue, entry, '!', `ledger state '${state}' — not runnable`);
      logEvent(ctx, { event: 'spec_parked', spec, detail: `ledger state ${state}` });
      return 'parked';
    }
    if (mode === 'build' && buildIterations >= opts.maxBuild) {
      markQueue(opts.queue, entry, '!', `build cap ${opts.maxBuild} reached without the ledger reaching built`);
      logEvent(ctx, { event: 'spec_parked', spec, detail: 'build cap reached' });
      return 'parked';
    }
    if (mode === 'review' && opts.maxReview > 0 && reviewPasses >= opts.maxReview) {
      markQueue(opts.queue, entry, '!', `review cap ${opts.maxReview} reached without a clean pass — needs a scope audit by a person`);
      logEvent(ctx, { event: 'spec_parked', spec, detail: 'review cap reached' });
      return 'parked';
    }

    if (!(await waitForMemory(ctx, opts.minFreeGb))) return 'stopped';
    const count = mode === 'build' ? Math.min(opts.buildChunk, opts.maxBuild - buildIterations) : 1;
    const before = iterationRowCount(ctx);
    writeState(ctx, { runnerPid: process.pid, spec, mode, state });
    logEvent(ctx, { event: 'loop_start', spec, mode, detail: `${count} iteration(s), ledger ${state}` });
    const result = await runLoop(ctx, mode, count, spec);
    const rows = iterationRowsSince(ctx, before, specName);
    if (mode === 'build') buildIterations += rows.length || count;
    if (mode === 'review') reviewPasses += 1;
    const verdict = classifyInvocation(rows, result.exitCode);
    const after = ledgerState(read(ctx.ledger), spec);
    logEvent(ctx, { event: 'loop_end', spec, mode, detail: `${verdict.kind}; exit ${result.exitCode}; ${rows.length} iteration(s); ledger ${state} → ${after}`, log: result.logFile });

    if (verdict.kind === 'interrupted') {
      if (++retries > opts.maxRetries) {
        markQueue(opts.queue, entry, '!', `${mode} interrupted ${retries} times${result.logFile ? ` — see ${path.relative(ctx.root, result.logFile)}` : ''}`);
        logEvent(ctx, { event: 'spec_parked', spec, detail: 'too many interruptions' });
        return 'parked';
      }
      logEvent(ctx, { event: 'retry', spec, mode, detail: `attempt ${retries}/${opts.maxRetries}` });
      continue;
    }
    retries = 0;
    if (verdict.kind === 'blocked') {
      markQueue(opts.queue, entry, '!', `blocked in ${mode}: ${verdict.reason}`);
      logEvent(ctx, { event: 'spec_parked', spec, detail: `blocked in ${mode}: ${verdict.reason}` });
      return 'parked';
    }
    // Progressed: a plan or review that twice in a row neither moves the ledger nor commits is stuck.
    // A review pass that commits fixes is progress even when the ledger stays at `built`; the review
    // cap (maxReview) bounds that case instead.
    const advanced = after !== state || verdict.committed;
    sameModeNoProgress = !advanced && mode === lastMode && mode !== 'build' ? sameModeNoProgress + 1 : 0;
    lastMode = mode;
    if (sameModeNoProgress >= 1) {
      markQueue(opts.queue, entry, '!', `${mode} ran twice without committing or moving the ledger past '${after}'`);
      logEvent(ctx, { event: 'spec_parked', spec, detail: `${mode} made no ledger progress` });
      return 'parked';
    }
  }
}

async function run(opts, ctx) {
  fs.mkdirSync(ctx.queueDir, { recursive: true });
  if (fs.existsSync(ctx.stop)) fs.unlinkSync(ctx.stop);
  if (!fs.existsSync(opts.queue)) throw new Error(`No queue file at ${opts.queue}`);
  writeState(ctx, { runnerPid: process.pid, startedAt: new Date().toISOString(), queue: opts.queue, finished: false });
  logEvent(ctx, { event: 'runner_start', detail: path.relative(ctx.root, opts.queue) });
  // Hold the machine out of system sleep only while there is queue work.
  const keepAwakeLog = (event, detail) => logEvent(ctx, { event, detail });
  let hold = null;
  const releaseHold = async () => {
    if (!hold) return;
    const current = hold;
    hold = null;
    await current.release();
  };
  const onSignal = (signal) => {
    releaseHold().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    for (;;) {
      const entry = parseQueue(read(opts.queue)).find((e) => e.marker === ' ');
      if (!entry) {
        await releaseHold();
        logEvent(ctx, { event: 'queue_empty' });
        break;
      }
      if (!hold) hold = acquireKeepAwake({ ownerPid: process.pid, log: keepAwakeLog });
      const outcome = await driveSpec(entry, opts, ctx);
      if (outcome === 'stopped') {
        await releaseHold();
        logEvent(ctx, { event: 'runner_stopped', spec: entry.spec });
        break;
      }
    }
  } finally {
    await releaseHold();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  writeState(ctx, { finished: true, loopPid: null });
  logEvent(ctx, { event: 'runner_end' });
}

/**
 * The `sweep.mjs run` arguments that launch the runner. `--detached`: the runner exists to
 * outlive the session that starts it (an overnight queue), so it must not be bound to that
 * session the way an ordinary `--service` is. `--idle-min 0`: the runner is quiet for hours
 * while a loop works (the loop writes its own log), so the unowned-service idle ceiling
 * must not apply; each loop it runs keeps its own ceilings.
 */
function startArgs(opts, ctx) {
  return [
    path.join(KIT_SCRIPTS, 'sweep.mjs'),
    'run',
    '--dir',
    path.join(ctx.queueDir, 'runner'),
    '--cwd',
    ctx.root,
    '--env',
    `RALPH_ROOT=${ctx.root}`,
    '--service',
    '--detached',
    '--idle-min',
    '0',
    '--',
    process.execPath,
    path.join(KIT_SCRIPTS, 'ralph-queue.cjs'),
    'run',
    '--queue',
    opts.queue,
    '--build-chunk',
    String(opts.buildChunk),
    '--max-build',
    String(opts.maxBuild),
    '--max-review',
    String(opts.maxReview ?? FALLBACK_OPTS.maxReview),
    '--min-free-gb',
    String(opts.minFreeGb),
    '--max-retries',
    String(opts.maxRetries),
  ];
}

function start(opts, ctx) {
  const result = spawnSync(process.execPath, startArgs(opts, ctx), { cwd: ctx.root, stdio: 'inherit', shell: false, env: { ...process.env, RALPH_ROOT: ctx.root } });
  process.exit(result.status ?? 1);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function formatEvent(e) {
  return `${e.ts} ${e.event}${e.spec ? ` ${e.spec}` : ''}${e.mode ? ` ${e.mode}` : ''}${e.detail ? ` — ${e.detail}` : ''}`;
}

function status(opts, ctx) {
  const state = readState(ctx);
  console.log(`runner: ${isAlive(state.runnerPid) && !state.finished ? `running (pid ${state.runnerPid})` : 'not running'}${state.spec ? `; current ${state.spec} ${state.mode}` : ''}`);
  for (const e of parseQueue(read(opts.queue))) console.log(`  [${e.marker}] ${e.spec}${e.note ? ` — ${e.note}` : ''}`);
  const events = jsonlLines(read(ctx.events)).slice(-8);
  if (events.length) console.log('recent events:');
  for (const line of events) {
    try {
      console.log(`  ${formatEvent(JSON.parse(line))}`);
    } catch {
      /* a torn line is not worth failing a status for */
    }
  }
}

async function watch(opts, ctx) {
  const startSize = fs.existsSync(ctx.events) ? fs.statSync(ctx.events).size : 0;
  const deadline = Date.now() + opts.timeoutMin * 60_000;
  for (;;) {
    const size = fs.existsSync(ctx.events) ? fs.statSync(ctx.events).size : 0;
    if (size > startSize) {
      const fd = fs.openSync(ctx.events, 'r');
      const buf = Buffer.alloc(size - startSize);
      fs.readSync(fd, buf, 0, buf.length, startSize);
      fs.closeSync(fd);
      process.stdout.write(buf.toString('utf8'));
      return;
    }
    const state = readState(ctx);
    if (!isAlive(state.runnerPid) || state.finished) {
      console.log('[ralph-queue] runner is not running');
      return;
    }
    if (Date.now() > deadline) {
      console.log(`[ralph-queue] no new event in ${opts.timeoutMin} min; runner still running (${state.spec || '-'} ${state.mode || ''})`);
      return;
    }
    await sleep(15_000);
  }
}

/** Load config.mjs (ESM) from this CommonJS file. */
async function loadKitConfig(root) {
  const mod = await import(pathToFileURL(path.join(KIT_SCRIPTS, 'lib', 'config.mjs')).href);
  return mod.loadConfig(root);
}

async function resolveRoot() {
  const mod = await import(pathToFileURL(path.join(KIT_SCRIPTS, 'lib', 'config.mjs')).href);
  return mod.resolveRoot(pathToFileURL(path.join(KIT_SCRIPTS, 'ralph-queue.cjs')).href);
}

async function main() {
  const argv = process.argv.slice(2);
  const root = await resolveRoot();
  const config = await loadKitConfig(root);
  const ctx = makeContext(root, { stateDirName: config.project.stateDir });
  const q = config.queue;
  const opts = parseArgs(argv, {
    buildChunk: q.buildChunk,
    maxBuild: q.maxBuild,
    maxReview: q.maxReview,
    minFreeGb: q.minFreeGb,
    maxRetries: q.maxRetries,
    timeoutMin: q.watchTimeoutMin,
  });
  if (!opts.queue) opts.queue = ctx.defaultQueue;
  if (opts.command === 'run') return run(opts, ctx);
  if (opts.command === 'start') return start(opts, ctx);
  if (opts.command === 'status') return status(opts, ctx);
  if (opts.command === 'watch') return watch(opts, ctx);
  if (opts.command === 'stop') {
    fs.mkdirSync(ctx.queueDir, { recursive: true });
    fs.writeFileSync(ctx.stop, new Date().toISOString());
    console.log('[ralph-queue] stop requested — the runner exits after the current loop invocation');
    return undefined;
  }
  throw new Error(`Unknown command: ${opts.command}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[ralph-queue] ${error.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  run, driveSpec, parseQueue, updateQueueLine, ledgerState, nextMode, classifyInvocation,
  parseArgs, startArgs, makeContext, loopCommand, read, jsonlLines,
};

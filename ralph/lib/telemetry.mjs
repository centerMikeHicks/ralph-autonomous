// Telemetry: transcript metrics, the iterations.jsonl row, the USAGE_LOG.md row, and
// loop-events.jsonl events. The shells never write these files; this module does, BOM-free.
import fs from 'node:fs';
import path from 'node:path';
import { appendLine, ensureDir, readJson, readText, splitLines, writeText } from './fsutil.mjs';

export const USAGE_HEADER = `# Ralph Usage Log

One row per agent invocation, appended by the loop driver. Columns: timestamp (UTC), git branch,
spec, loop mode, model, iteration, plan phase and outcome (from \`.ralph/ITERATION_STATUS.json\`,
authored by the agent), whether HEAD moved, wall duration (s), \`api_s\` = time the model was being
called, \`tool_s\` = time inside the run but not in the model, \`overhead_s\` = wall minus the run
(CLI startup), \`gap_s\` = idle time since the previous iteration ended, turns, tool calls, test
runs, sub-agents, token counts and cost (USD). Machine-readable twin: \`.ralph/iterations.jsonl\`.
Report: \`node ralph/report.mjs\`.

| timestamp | branch | spec | mode | model | iter | plan_phase | outcome | committed | dur_s | api_s | tool_s | overhead_s | gap_s | turns | tool_calls | tests | subagents | input | output | cache_r | cache_w | cost_usd |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
`;

const round1 = (n) => Math.round(n * 10) / 10;

/** Parse transcript lines into JSON events, skipping anything that is not JSON. */
export function parseTranscript(lines) {
  const events = [];
  for (const raw of lines) {
    const line = raw && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    if (!line || line[0] !== '{') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // truncated line
    }
  }
  return events;
}

/**
 * How the iteration spent its time, from the stream-json events: the final `result` event's
 * model-vs-wall split, turn count, usage and cost, plus tool-call counts by name.
 */
export function transcriptMetrics(lines, { testPattern } = {}) {
  const m = {
    duration_ms: 0, api_ms: 0, turns: 0, is_error: false, stop_reason: '',
    input: 0, output: 0, cache_r: 0, cache_w: 0, cost: 0,
    tool_calls: 0, tools: {}, tests_run: 0, subagents: 0, subagent_ms: 0,
  };
  const testRe = testPattern || /\b(jest|vitest|pytest|mocha)\b|node --test|(npm|pnpm|yarn)( run)? test\b/;
  const events = parseTranscript(lines);
  const result = [...events].reverse().find((e) => e.type === 'result');
  if (result) {
    m.duration_ms = Number(result.duration_ms) || 0;
    m.api_ms = Number(result.duration_api_ms) || 0;
    m.turns = Number(result.num_turns) || 0;
    m.is_error = Boolean(result.is_error);
    m.stop_reason = result.stop_reason ? String(result.stop_reason) : '';
    const u = result.usage || {};
    m.input = Number(u.input_tokens) || 0;
    m.output = Number(u.output_tokens) || 0;
    m.cache_r = Number(u.cache_read_input_tokens) || 0;
    m.cache_w = Number(u.cache_creation_input_tokens) || 0;
    m.cost = Number(result.total_cost_usd) || 0;
    const stats = result.subagent_stats;
    const entries = Array.isArray(stats) ? stats : stats && typeof stats === 'object' ? [stats] : [];
    for (const entry of entries) {
      for (const [k, v] of Object.entries(entry)) {
        if (/duration|_ms/i.test(k) && typeof v === 'number') m.subagent_ms += v;
      }
    }
  }
  for (const e of events) {
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      m.tool_calls += 1;
      m.tools[block.name] = (m.tools[block.name] || 0) + 1;
      if (block.name === 'Agent' || block.name === 'Task') m.subagents += 1;
      const cmd = block.input && typeof block.input.command === 'string' ? block.input.command : '';
      if ((block.name === 'Bash' || block.name === 'PowerShell') && testRe.test(cmd)) m.tests_run += 1;
    }
  }
  return m;
}

/**
 * The agent's own report for this iteration, trusted only when written after the iteration
 * started (2 s of slack for filesystem timestamp granularity).
 */
export function readIterationStatus(file, iterStartMs) {
  const r = { fresh: false, spec: '-', phase: '-', outcome: 'unknown', did: '(agent emitted no ITERATION_STATUS.json this iteration)', result: '', next: '', committed: false, exit_gate: '' };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return r;
  }
  if (stat.mtimeMs < iterStartMs - 2000) return r;
  const st = readJson(file, null);
  if (!st || typeof st !== 'object') return r;
  r.fresh = true;
  for (const key of ['spec', 'phase', 'outcome', 'did', 'result', 'next', 'exit_gate']) {
    if (st[key]) r[key] = String(st[key]);
  }
  r.committed = st.committed === true;
  return r;
}

/** Final outcome label: the agent's word, corrected by what git and the exit code show. */
export function resolveOutcome({ status, headMoved, exitCode }) {
  let outcome = status.outcome;
  if (!status.fresh && headMoved) outcome = 'committed(no-status)';
  if (exitCode !== 0 && outcome === 'unknown') outcome = `error(exit ${exitCode})`;
  return outcome;
}

/** Build the iterations.jsonl row. All times are ISO strings or seconds. */
export function buildIterationRow(i) {
  const m = i.metrics;
  const durS = round1((i.endMs - i.startMs) / 1000);
  const apiS = round1(m.api_ms / 1000);
  const runS = round1(m.duration_ms / 1000);
  const headMoved = Boolean(i.headBefore && i.headAfter && i.headBefore !== i.headAfter);
  const outcome = resolveOutcome({ status: i.status, headMoved, exitCode: i.exitCode });
  return {
    ts: new Date(i.endMs).toISOString(),
    run: i.run,
    iter: i.iter,
    branch: i.branch,
    // The driver's active spec is authoritative: the queue runner matches rows to a spec by this field,
    // and an agent's self-reported name (or a stale status file) must not be able to hide an iteration.
    spec: i.specName,
    mode: i.mode,
    model: i.modelLabel,
    phase: i.status.phase,
    outcome,
    status_fresh: i.status.fresh,
    committed: headMoved,
    head_before: i.headBefore,
    head_after: i.headAfter,
    started_at: new Date(i.startMs).toISOString(),
    ended_at: new Date(i.endMs).toISOString(),
    dur_s: durS,
    api_s: apiS,
    tool_s: round1(Math.max(0, runS - apiS)),
    overhead_s: round1(Math.max(0, durS - runS)),
    gap_s: round1(i.gapS || 0),
    turns: m.turns,
    tool_calls: m.tool_calls,
    tools: m.tools,
    tests_run: m.tests_run,
    subagents: m.subagents,
    subagent_s: round1(m.subagent_ms / 1000),
    exit_code: i.exitCode,
    is_error: m.is_error,
    stop_reason: m.stop_reason,
    input: m.input,
    output: m.output,
    cache_r: m.cache_r,
    cache_w: m.cache_w,
    cost_usd: Math.round(m.cost * 10000) / 10000,
    did: i.status.did,
    result: i.status.result,
    next: i.status.next,
    transcript: i.transcript || '',
  };
}

function cell(value, max) {
  const t = String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

export function usageLogRow(row) {
  const cols = [
    row.ts, row.branch, cell(row.spec, 80), row.mode, row.model, row.iter, cell(row.phase, 80),
    cell(row.outcome, 40), row.committed, row.dur_s, row.api_s, row.tool_s, row.overhead_s,
    Math.round(row.gap_s), row.turns, row.tool_calls, row.tests_run, row.subagents,
    row.input, row.output, row.cache_r, row.cache_w, row.cost_usd.toFixed(4),
  ];
  return `| ${cols.join(' | ')} |`;
}

/** Append the iterations.jsonl row and the USAGE_LOG.md row. */
export function writeIterationRecord(stateDir, row) {
  ensureDir(stateDir);
  appendLine(path.join(stateDir, 'iterations.jsonl'), JSON.stringify(row));
  const usage = path.join(stateDir, 'USAGE_LOG.md');
  if (!readText(usage).includes('| timestamp | branch |')) writeText(usage, USAGE_HEADER);
  appendLine(usage, usageLogRow(row));
}

/** Event writer for loop-events.jsonl; never throws. */
export function createEventLog(stateDir, run) {
  const file = path.join(stateDir, 'loop-events.jsonl');
  return function emit(event, data = {}) {
    try {
      appendLine(file, JSON.stringify({ ts: new Date().toISOString(), run, event, ...data }));
    } catch {
      // telemetry must not take the loop down
    }
  };
}

export function writeHeartbeat(stateDir, run, iter) {
  try {
    writeText(path.join(stateDir, '.loop-heartbeat'), JSON.stringify({ run, iter, pid: process.pid, ts: new Date().toISOString() }));
  } catch {
    // liveness is best effort
  }
}

export function removeHeartbeat(stateDir) {
  try {
    fs.rmSync(path.join(stateDir, '.loop-heartbeat'), { force: true });
  } catch {
    // already gone
  }
}

/** Read every row of a JSONL file, tolerating a BOM and bad lines. */
export function readJsonl(file) {
  return splitLines(readText(file))
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

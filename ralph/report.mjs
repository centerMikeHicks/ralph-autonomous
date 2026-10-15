#!/usr/bin/env node
/**
 * ralph/report.mjs: where did the loop's wall-clock go?
 *
 * Reads the telemetry sinks `ralph/loop.{sh,ps1}` write (all gitignored, under the
 * configured state directory, `.ralph` by default):
 *   iterations.jsonl    one record per agent invocation
 *   loop-events.jsonl   loop start/stop, iteration start/end, push, ... each with a duration
 *   logs/<spec>/*.jsonl timestamped stream-json transcripts, for per-tool-call timing
 *                       (kept unless the loop ran with --no-transcripts)
 * and prints:
 *   1. per-phase totals: iterations, wall, model, tool, overhead, idle, cost
 *   2. outcome histogram, with the cost of blocked/no-progress iterations
 *   3. gaps > --gap seconds between iterations, with the loop events that bracket them
 *      (so a human stop/restart shows as loop_stop/loop_start)
 *   4. the slowest tool calls across retained transcripts (if any)
 *
 * Usage:
 *   node ralph/report.mjs                    # everything in the state directory
 *   node ralph/report.mjs --spec <name>      # one spec only
 *   node ralph/report.mjs --since 2026-09-07 # ISO date/time lower bound
 *   node ralph/report.mjs --gap 300          # gap threshold in seconds (default 300)
 *   node ralph/report.mjs --top 15           # slowest tool calls to show
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveRoot } from '../scripts/lib/config.mjs';

/** Parse a JSONL file, BOM-, CRLF- and torn-line-tolerant. Missing file -> []. */
export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^﻿/, '')).filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

/** Seconds -> `1h05m`, `2m03s` or `9s`. */
export const fmt = (seconds) => {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  return m ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
};
const usd = (c) => `$${c.toFixed(2)}`;
const pad = (v, n, right = false) => (right ? String(v).padStart(n) : String(v).padEnd(n));

/** Render a fixed-width table as an array of lines. */
export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => (i > 0 && (typeof rows[0]?.[i] === 'number' || /^\$?[\d.]+[hms]?[\dms]*$/.test(String(c))) ? pad(c, widths[i], true) : pad(c, widths[i]))).join(' | ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('-+-'), ...rows.map(line)];
}

/** One tool call per tool_use/tool_result pair in a tab-separated `<tag>\t<ms>\t<json>` transcript. */
export function toolCalls(transcriptFile) {
  const calls = [];
  const pending = new Map();
  for (const line of fs.readFileSync(transcriptFile, 'utf8').split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const ms = Number(parts[1]);
    let ev;
    try { ev = JSON.parse(parts.slice(2).join('\t')); } catch { continue; }
    const blocks = ev?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        const inp = b.input || {};
        let label = b.name;
        if (b.name === 'Bash') label = inp.description || String(inp.command || '').split('\n')[0];
        else if (b.name === 'Read') label = `Read ${inp.file_path || ''}`;
        else if (b.name === 'Agent') label = `Agent: ${inp.description || ''}`;
        pending.set(b.id, { name: b.name, label: String(label).slice(0, 90), t0: ms });
      }
      if (b.type === 'tool_result' && pending.has(b.tool_use_id)) {
        const p = pending.get(b.tool_use_id);
        calls.push({ ...p, dur_s: (ms - p.t0) / 1000, transcript: path.basename(transcriptFile) });
        pending.delete(b.tool_use_id);
      }
    }
  }
  return calls;
}

/**
 * Build the report as text.
 * @param {{ stateDir: string, spec?: string|null, since?: string|null, gap?: number, top?: number }} options
 */
export function buildReport({ stateDir, spec = null, since = null, gap = 300, top = 15 }) {
  const out = [];
  const say = (line = '') => out.push(line);
  const SINCE = since ? new Date(since).getTime() : 0;
  let iters = readJsonl(path.join(stateDir, 'iterations.jsonl'));
  let events = readJsonl(path.join(stateDir, 'loop-events.jsonl'));
  if (spec) iters = iters.filter((r) => (r.spec || '').includes(spec));
  if (SINCE) {
    iters = iters.filter((r) => new Date(r.ended_at || r.ts).getTime() >= SINCE);
    events = events.filter((e) => new Date(e.ts).getTime() >= SINCE);
  }
  if (!iters.length) {
    return `No iterations found in ${path.join(stateDir, 'iterations.jsonl')} (filters: spec=${spec ?? '*'}, since=${SINCE ? new Date(SINCE).toISOString() : '*'}).\n`;
  }
  const startOf = (r) => new Date(r.started_at || r.ts).getTime();
  iters.sort((a, b) => startOf(a) - startOf(b));

  // An aborted iteration is one the loop process died inside: its wall time is bounded from
  // timestamps, but it has no transcript, so its cost is null. Null is not zero: the sums
  // below skip it and the count is reported on its own so the totals are read as a floor.
  const aborted = iters.filter((r) => r.outcome === 'aborted');
  const abortedWall = aborted.reduce((a, r) => a + (r.dur_s || 0), 0);

  // 1. per-phase totals
  const first = iters[0];
  const last = iters.at(-1);
  say(`\n=== Time per phase (${iters.length} iterations, ${new Date(startOf(first)).toISOString()} -> ${new Date(last.ended_at || last.ts).toISOString()}) ===\n`);
  if (aborted.length) say(`${aborted.length} aborted iteration(s), cost unknown: ${fmt(abortedWall)} of wall bounded from timestamps, no transcript; every cost total below is a floor.\n`);
  const blank = () => ({ n: 0, wall: 0, api: 0, tool: 0, overhead: 0, idle: 0, cost: 0, commits: 0, blocked: 0 });
  const byPhase = new Map();
  for (const r of iters) {
    const k = r.phase || '-';
    const p = byPhase.get(k) || blank();
    p.n++; p.wall += r.dur_s || 0; p.api += r.api_s || 0; p.tool += r.tool_s || 0; p.overhead += r.overhead_s || 0; p.idle += r.gap_s || 0; p.cost += r.cost_usd || 0;
    if (r.committed) p.commits++;
    if (String(r.outcome).startsWith('blocked')) p.blocked++;
    byPhase.set(k, p);
  }
  const tot = blank();
  const phaseRows = [...byPhase.entries()].map(([k, p]) => {
    for (const f of Object.keys(tot)) tot[f] += p[f];
    return [k.slice(0, 42), p.n, fmt(p.wall), fmt(p.api), fmt(p.tool), fmt(p.overhead), fmt(p.idle), p.commits, p.blocked, usd(p.cost)];
  });
  phaseRows.push(['TOTAL', tot.n, fmt(tot.wall), fmt(tot.api), fmt(tot.tool), fmt(tot.overhead), fmt(tot.idle), tot.commits, tot.blocked, usd(tot.cost)]);
  table(['phase', 'iters', 'wall', 'model', 'tools', 'overhead', 'idle-before', 'commits', 'blocked', 'cost'], phaseRows).forEach((l) => say(l));
  say("\nwall = model (API) + tools (inside the run, not in the model) + overhead (CLI/MCP startup). idle-before = time between the previous iteration's end and this one's start.");

  // 2. outcomes
  say('\n=== Outcomes ===\n');
  const byOutcome = new Map();
  for (const r of iters) {
    const k = r.outcome || 'unknown';
    const o = byOutcome.get(k) || { n: 0, wall: 0, cost: 0 };
    o.n++; o.wall += r.dur_s || 0; o.cost += r.cost_usd || 0;
    byOutcome.set(k, o);
  }
  table(['outcome', 'iters', 'wall', 'cost'], [...byOutcome.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, o]) => [k, o.n, fmt(o.wall), k === 'aborted' ? 'unknown' : usd(o.cost)])).forEach((l) => say(l));
  if (aborted.length) say(`\n${aborted.length} aborted iteration(s), cost unknown (run(s): ${[...new Set(aborted.map((r) => r.run))].join(', ')}).`);
  const noProgress = iters.filter((r) => !r.committed && /^(blocked|unknown|error|failed)/.test(String(r.outcome)));
  if (noProgress.length) say(`\n${noProgress.length} iteration(s) made no progress (blocked/failed/unknown/error, no commit): ${fmt(noProgress.reduce((a, r) => a + (r.dur_s || 0), 0))} wall, ${usd(noProgress.reduce((a, r) => a + (r.cost_usd || 0), 0))}.`);
  let streak = 0;
  let worst = 0;
  for (const r of iters) { streak = String(r.outcome).startsWith('blocked') ? streak + 1 : 0; worst = Math.max(worst, streak); }
  if (worst >= 2) say(`Longest blocked streak: ${worst} consecutive iterations.`);

  // 3. gaps
  say(`\n=== Gaps > ${fmt(gap)} between iterations ===\n`);
  let anyGap = false;
  for (const r of iters) {
    if ((r.gap_s || 0) <= gap) continue;
    anyGap = true;
    const start = startOf(r);
    const prevEnd = start - r.gap_s * 1000;
    const inside = events.filter((e) => {
      const t = new Date(e.ts).getTime();
      return t >= prevEnd - 2000 && t <= start + 2000 && !['iteration_start', 'iteration_end'].includes(e.event);
    });
    say(`${fmt(r.gap_s)} before iter ${r.iter} (${r.phase}) starting ${r.started_at || r.ts}`);
    for (const e of inside) say(`    ${e.ts}  ${e.event}${e.reason ? ` reason=${e.reason}` : ''}${e.dur_s != null ? ` dur=${fmt(e.dur_s)}` : ''}${e.ok === false ? ' FAILED' : ''}`);
    if (!inside.length) say('    (no loop events in the gap: the loop process itself was not running, or predates event logging)');
  }
  if (!anyGap) say('none');

  // 4. slowest tool calls from retained transcripts
  const transcripts = iters.map((r) => r.transcript).filter((t) => t && fs.existsSync(t));
  if (transcripts.length) {
    say(`\n=== Slowest tool calls (${transcripts.length} retained transcript(s)) ===\n`);
    const calls = transcripts.flatMap((t) => toolCalls(t));
    calls.sort((a, b) => b.dur_s - a.dur_s);
    table(['dur', 'tool', 'what', 'transcript'], calls.slice(0, top).map((c) => [fmt(c.dur_s), c.name, c.label, c.transcript])).forEach((l) => say(l));
    const byTool = new Map();
    for (const c of calls) { const o = byTool.get(c.name) || { n: 0, s: 0 }; o.n++; o.s += c.dur_s; byTool.set(c.name, o); }
    say('');
    table(['tool', 'calls', 'total', 'avg'], [...byTool.entries()].sort((a, b) => b[1].s - a[1].s).map(([k, o]) => [k, o.n, fmt(o.s), fmt(o.s / o.n)])).forEach((l) => say(l));
  } else {
    say('\n(per-tool-call timing needs retained transcripts: run the loop without --no-transcripts / -NoTranscripts)');
  }
  say('');
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
  const root = resolveRoot(import.meta.url);
  const config = loadConfig(root);
  process.stdout.write(buildReport({
    stateDir: path.join(root, config.project.stateDir),
    spec: opt('--spec', null),
    since: opt('--since', null),
    gap: Number(opt('--gap', 300)),
    top: Number(opt('--top', 15)),
  }));
}

const here = fileURLToPath(import.meta.url);
const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
if (process.argv[1] && norm(process.argv[1]) === norm(here)) {
  try { main(); } catch (err) { console.error(`[report] ${err.message}`); process.exit(1); }
}

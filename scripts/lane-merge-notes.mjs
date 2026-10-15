#!/usr/bin/env node
/**
 * lane-merge-notes — the merge-back checklist for a finished lane, and a ledger-row diff.
 *
 *   node scripts/lane-merge-notes.mjs [--lane BRANCH] [--base BRANCH] [--spec NAME]
 *                                     [--ledger-a FILE --ledger-b FILE] [--json]
 *
 * --ledger-a is the integration branch's ledger, --ledger-b the lane's. The diff lists rows
 * only in the lane, rows only in the integration ledger, and rows whose cells differ (with the
 * state change called out), so the ledgers can be merged row by row by hand. Prints only;
 * changes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, usageExit } from './lib/args.mjs';

export const LEDGER_COLUMNS = ['Spec', 'Title', 'Created', 'Last updated', 'State', 'Active?', 'Commits', 'Notes'];
const STATE_ORDER = ['drafted', 'planned', 'built', 'reviewed', 'shipped'];

/** Parse a ledger into rows keyed by spec path: { spec, section, cells: {Column: value} }. */
export function parseLedger(text) {
  const rows = [];
  let section = '';
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { section = h[1].trim(); continue; }
    if (!/^\s*\|/.test(line) || /^\s*\|\s*:?-{2,}/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
    if (cells[0].replace(/[`*]/g, '') === 'Spec') continue;
    const spec = cells[0].replace(/`/g, '');
    if (!spec) continue;
    rows.push({ spec, section, cells: Object.fromEntries(LEDGER_COLUMNS.map((c, i) => [c, cells[i] ?? ''])) });
  }
  return rows;
}

/** Row-level diff: `a` = integration ledger, `b` = lane ledger. */
export function diffLedgers(aText, bText) {
  const a = new Map(parseLedger(aText).map((r) => [r.spec, r]));
  const b = new Map(parseLedger(bText).map((r) => [r.spec, r]));
  const onlyInLane = [...b.values()].filter((r) => !a.has(r.spec));
  const onlyInIntegration = [...a.values()].filter((r) => !b.has(r.spec));
  const changed = [];
  for (const [spec, rb] of b) {
    const ra = a.get(spec);
    if (!ra) continue;
    const cols = LEDGER_COLUMNS.filter((c) => ra.cells[c] !== rb.cells[c]);
    if (!cols.length) continue;
    const sa = STATE_ORDER.indexOf(ra.cells.State);
    const sb = STATE_ORDER.indexOf(rb.cells.State);
    changed.push({
      spec, columns: cols, integrationState: ra.cells.State, laneState: rb.cells.State,
      laneAhead: sa >= 0 && sb >= 0 ? sb > sa : null,
      before: Object.fromEntries(cols.map((c) => [c, ra.cells[c]])), after: Object.fromEntries(cols.map((c) => [c, rb.cells[c]])),
    });
  }
  return { onlyInLane, onlyInIntegration, changed };
}

export function checklist({ lane = '<lane-branch>', base = '<integration-branch>', spec = '<spec>' } = {}) {
  return [
    `Confirm \`${spec}\` is \`reviewed\` in the lane's ledger (.ralph/SPECS_LEDGER.md) and its review pass found nothing open.`,
    `Archive the lane's live plan: it must already exist as .ralph/IMPLEMENTATION_PLAN.${spec}.md in the lane (the live plan file is never merged).`,
    `In the integration checkout, merge the branch with the owner's approval: git merge ${lane}   (integration branch: ${base})`,
    'Keep the integration branch\'s own .ralph/IMPLEMENTATION_PLAN.md if the merge touched it.',
    'Merge .ralph/SPECS_LEDGER.md row by row (diff below); take the further-along state, union the Commits cells, keep the integration branch\'s Active? flags.',
    `Run the project's checks on the merged result, then push ${base}.`,
    'Every other lane: git pull the integration branch (then re-run its queue; specs it already finished stay done).',
    `Remove the \`MOVED to lane\` mark for \`${spec}\` in the integration queue, or leave it as the record. The lane worktree is removed by hand (git worktree remove), never by the kit.`,
  ];
}

function renderDiff(d) {
  const out = [];
  out.push(`Rows only in the lane ledger (${d.onlyInLane.length}):`);
  for (const r of d.onlyInLane) out.push(`  + ${r.spec}  [${r.cells.State}]  ${r.section}`);
  out.push(`Rows only in the integration ledger (${d.onlyInIntegration.length}):`);
  for (const r of d.onlyInIntegration) out.push(`  - ${r.spec}  [${r.cells.State}]  ${r.section}`);
  out.push(`Rows that differ (${d.changed.length}):`);
  for (const c of d.changed) {
    const hint = c.laneAhead === true ? ' (lane is further along)' : c.laneAhead === false ? ' (integration is further along or equal)' : '';
    out.push(`  ~ ${c.spec}: ${c.integrationState || '-'} -> ${c.laneState || '-'}${hint}; differing columns: ${c.columns.join(', ')}`);
  }
  return out;
}

function main() {
  const USAGE = 'lane-merge-notes.mjs [--lane BRANCH] [--base BRANCH] [--spec NAME] [--ledger-a FILE --ledger-b FILE] [--json]';
  let args;
  try { args = parseArgs(process.argv.slice(2), { flags: ['json'], opts: ['lane', 'base', 'spec', 'ledger-a', 'ledger-b'] }); } catch (e) { usageExit(e.message, USAGE); }
  const a = args['ledger-a'];
  const b = args['ledger-b'];
  if ((a && !b) || (!a && b)) usageExit('lane-merge-notes: --ledger-a and --ledger-b go together', USAGE);
  let diff = null;
  if (a && b) {
    for (const f of [a, b]) if (!fs.existsSync(f)) usageExit(`lane-merge-notes: not found: ${f}`, USAGE);
    diff = diffLedgers(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'));
  }
  const steps = checklist({ lane: args.lane, base: args.base, spec: args.spec });
  if (args.json) { console.log(JSON.stringify({ checklist: steps, diff }, null, 2)); return; }
  console.log('Merge-back checklist');
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  if (diff) { console.log('\nLedger diff (integration -> lane)'); for (const l of renderDiff(diff)) console.log(l); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

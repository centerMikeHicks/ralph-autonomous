#!/usr/bin/env node
/**
 * Plan completeness — does every requirement the spec states land in a plan task that names its files?
 *
 * A decision recorded in a spec's log can be missed by a plan: the build loop builds what the
 * plan says, and nobody notices until review. This is the check that the spec's requirement
 * inventory is covered, run before the plan loop ends.
 *
 * THE INVENTORY (what must be referenced)
 *   - every row of every table under `### Data Model` and `### Service Changes` (a row whose
 *     second cell reads "none"/"—" is skipped)
 *   - every named acceptance row (`[unit] name`, `[integration] name`, ...)
 *   - every decision-log entry (`**Dn — ...**`, `Dn:`) that is IN SCOPE: its text matches a
 *     positive scope phrase and no negative one (see IN_SCOPE / OUT_OF_SCOPE; `--json` lists
 *     every decision with the verdict under `decisions`).
 *
 * WHAT COUNTS AS A REFERENCE
 *   A plan TASK (a checkbox line under a phase, or the phase line itself when it has no
 *   sub-tasks, plus its indented continuation lines) whose text mentions the item: the test name
 *   as a word, `Dn` as a word, or (table rows) one of the row's backticked identifiers, its
 *   path, or its label. The reference must come from a task that carries a `Files:` line; an
 *   acceptance row inherits the `Files:` of its phase's work tasks. A completed `[x]` task is
 *   exempt from `Files:` (the commit is its record), and so is the Exit Gate line (its work is
 *   the sweep).
 *
 *   node scripts/verify-plan-completeness.mjs --spec S [--plan P] [--strict] [--json]
 *
 * Without --strict findings are advisory (exit 0). Exit 0 = complete (or advisory),
 * 1 = findings under --strict, 2 = cannot run.
 */
import fs from 'node:fs';
import { parseArgs, usageExit } from './lib/args.mjs';
import { getContext, readText } from './lib/context.mjs';
import { parseSpecPhases, parseDecisions, sectionLines, tableRows, splitLines, planPhaseOf } from './lib/spec-parse.mjs';

const IN_SCOPE = /\b(ships?|shipped|in scope|builds? now|built now|is built|are built|built in phase \d|is added|are added|is (?:in|part of) phase \d|added (?:in|to|with) phase \d|phase \d+[a-z]? (?:adds|added)|in v1|for v1|delivered)\b/i;
const OUT_OF_SCOPE = /\b(out of scope|not (?:in scope|built|offered|created|done|shipped|migrated|planned)|never (?:planned|built)|not in v1|isn't built|follow-?up|deferred|left to the user|for the user to|user to decide|not done here|stays? a waiver|left as-is)\b/i;
const STOP = new Set(['definition', 'description', 'string', 'number', 'boolean', 'object', 'array', 'record', 'type', 'name', 'value', 'null', 'true', 'false', 'label', 'first', 'last', 'none', 'kind', 'from', 'with', 'this', 'that', 'each', 'every', 'json', 'edit', 'view', 'list', 'default', 'service', 'client', 'route', 'routes', 'field', 'fields']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (t) => new RegExp(`(?<![\\w$])${escapeRe(t)}(?![\\w$])`, 'i');
const strip = (s) => s.replace(/[`*]/g, '').trim();

function identifierTokens(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    // A path is matched whole: its segments are in every plan.
    if (/\//.test(m[1])) { out.add(m[1].trim()); continue; }
    for (const tok of m[1].split(/[^\w$]+/)) {
      if (tok.length >= 4 && !STOP.has(tok.toLowerCase()) && !/^\d+$/.test(tok)) out.add(tok);
    }
  }
  return [...out];
}

function tableItems(lines, headingRe, kind) {
  return tableRows(sectionLines(lines, headingRe))
    .filter((r) => r.cells.length >= 2 && !/^(none|—|–|-|n\/a)\.?$/i.test(strip(r.cells[1])))
    .map((r) => {
      const label = strip(r.cells[0]);
      const tokens = identifierTokens(r.cells.join(' | '));
      const matchers = [...tokens.map(wordRe), ...(label.length >= 4 ? [new RegExp(escapeRe(label), 'i')] : [])];
      return { kind, id: label, line: r.line, tokens, matchers };
    });
}

export function specInventory(specText) {
  const lines = splitLines(specText);
  const acceptance = parseSpecPhases(specText).flatMap((p) => p.rows.filter((r) => r.name).map((r) => ({
    kind: 'acceptance', id: r.name, line: r.line, phase: p.key, matchers: [wordRe(r.name)],
  })));
  const decisions = parseDecisions(specText).map((d) => {
    const positive = IN_SCOPE.exec(d.text)?.[0] ?? null;
    const negative = OUT_OF_SCOPE.exec(d.text)?.[0] ?? null;
    return { kind: 'decision', id: d.id, line: d.line, inScope: Boolean(positive) && !negative, positive, negative, matchers: [new RegExp(`(?<![\\w$])${d.id}(?!\\d)`)] };
  });
  return {
    items: [
      ...tableItems(lines, /^###\s+Data Model\b/i, 'data-model'),
      ...tableItems(lines, /^###\s+Service Changes\b/i, 'service-change'),
      ...acceptance,
      ...decisions.filter((d) => d.inScope),
    ],
    decisions,
  };
}

// --- plan tasks ----------------------------------------------------------------------------------
const indentOf = (l) => /^(\s*)/.exec(l)[1].length;
const isCheckbox = (l) => /^\s*-\s*\[[ xX]\]/.test(l);
const isHeading = (l) => /^#{1,6}\s/.test(l);
const SKIPPED_SECTIONS = /^##+\s*(open questions|blocked|waivers|status|active spec|references|decisions)/i;

/** Every checkbox line with its continuation, tagged phase/test-row/ticked/Files. */
function planUnits(planText) {
  const lines = splitLines(planText);
  const units = [];
  let section = '';
  let phaseKey = null;
  let phaseIndent = -1;
  lines.forEach((raw, i) => {
    if (isHeading(raw)) { if (/^##\s/.test(raw)) section = raw; return; }
    if (!isCheckbox(raw)) return;
    const indent = indentOf(raw);
    let text = raw;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (!l.trim() || isHeading(l) || isCheckbox(l)) break;
      text += `\n${l}`;
    }
    const p = planPhaseOf(raw);
    if (p) { phaseKey = p.key; phaseIndent = indent; }
    units.push({
      line: i + 1, text, indent, ticked: /^\s*-\s*\[[xX]\]/.test(raw), isPhase: Boolean(p),
      phaseKey: p ? p.key : (indent > phaseIndent ? phaseKey : null),
      isTestRow: /^\s*-\s*\[[ xX]\]\s*`?\[(unit|integration|e2e|visual-only)\]/.test(raw),
      hasFiles: /\bFiles:\s*\S/.test(text), skipped: SKIPPED_SECTIONS.test(section),
    });
  });
  for (const u of units) {
    if (u.isPhase) u.subTasks = units.filter((o) => !o.isPhase && o.phaseKey === u.phaseKey && o.line > u.line && o.indent > u.indent);
  }
  return units;
}

export function checkPlanCompleteness(specText, planText) {
  const { items, decisions } = specInventory(specText);
  const units = planUnits(planText).filter((u) => !u.skipped);
  const phaseHasFiles = new Map();
  for (const u of units) if (u.hasFiles && u.phaseKey) phaseHasFiles.set(u.phaseKey, true);
  const carriesFiles = (u) => u.hasFiles || u.ticked
    || (u.isTestRow && phaseHasFiles.get(u.phaseKey) === true)
    || (u.isPhase && (u.subTasks ?? []).some((s) => s.hasFiles || s.ticked))
    || (u.isPhase && u.phaseKey === 'exit-gate');
  const plain = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'matchers'));
  const unreferenced = [];
  const withoutFiles = [];
  const referenced = [];
  for (const item of items) {
    const refs = units.filter((u) => item.matchers.some((re) => re.test(u.text)));
    if (!refs.length) { unreferenced.push(plain(item)); continue; }
    const ok = refs.filter(carriesFiles);
    if (!ok.length) withoutFiles.push({ ...plain(item), tasks: refs.map((r) => r.line) });
    else referenced.push({ kind: item.kind, id: item.id, line: item.line, tasks: ok.map((r) => r.line) });
  }
  const tasksWithoutFiles = units
    .filter((u) => !u.ticked && !u.isTestRow && !carriesFiles(u) && !(u.isPhase && (u.subTasks ?? []).length))
    .map((u) => ({ line: u.line, text: u.text.split('\n')[0].trim().slice(0, 100) }));
  return { items: items.length, decisions: decisions.map(plain), unreferenced, withoutFiles, tasksWithoutFiles, referenced };
}

// --- CLI -----------------------------------------------------------------------------------------
function main() {
  const USAGE = 'verify-plan-completeness.mjs --spec S [--plan P] [--strict] [--json]';
  let args;
  try { args = parseArgs(process.argv.slice(2), { flags: ['strict', 'json'], opts: ['spec', 'plan'] }); } catch (e) { usageExit(e.message, USAGE); }
  const ctx = getContext();
  const specArg = args.spec ?? ctx.activeSpec();
  const specPath = specArg ? ctx.resolve(specArg) : null;
  const planPath = args.plan ? ctx.resolve(args.plan) : ctx.planPath;
  if (!specPath || !fs.existsSync(specPath) || !fs.existsSync(planPath)) {
    usageExit(`verify-plan-completeness: need a spec (${specArg ?? 'none given and no ACTIVE_SPEC'}) and a plan (${planPath})`, USAGE);
  }
  const result = checkPlanCompleteness(readText(specPath), readText(planPath));
  const total = result.unreferenced.length + result.withoutFiles.length + result.tasksWithoutFiles.length;
  if (args.json) {
    console.log(JSON.stringify({ spec: specArg, plan: planPath, strict: Boolean(args.strict), findings: total, ...result }, null, 2));
  } else {
    console.log(`[plan-completeness] ${specArg}: ${result.items} item(s) in the spec inventory, ${result.referenced.length} referenced by a task with Files:`);
    for (const u of result.unreferenced) console.log(`  UNREFERENCED  ${u.kind} spec:${u.line}  ${u.id}${u.kind === 'decision' ? ` (in scope: "${u.positive}")` : ''}`);
    for (const u of result.withoutFiles) console.log(`  NO FILES:     ${u.kind} spec:${u.line}  ${u.id} — referenced only by open task(s) at plan:${u.tasks.join(',')} with no \`Files:\` line`);
    for (const t of result.tasksWithoutFiles) console.log(`  TASK NO FILES plan:${t.line}  ${t.text}`);
    console.log(`[plan-completeness] ${total} finding(s)${args.strict ? '' : ' (advisory — pass --strict to fail)'}`);
  }
  process.exit(args.strict && total ? 1 : 0);
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

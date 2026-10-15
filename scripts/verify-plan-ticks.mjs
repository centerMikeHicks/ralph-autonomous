#!/usr/bin/env node
/**
 * Plan ticks — which phases did an iteration mark complete, and did each one earn it?
 *
 * A build agent ticks its own phases; this is the check that a tick is deserved. Compare a
 * snapshot of the plan taken before an iteration with the plan after it. Each phase newly
 * ticked `[x]` must show:
 *
 *   1. every task under it is ticked (an open task means the phase is not done);
 *   2. its `gate:` clause, when it holds a backticked command, exits 0 (run through the
 *      shell in the project root; a gate written as plain prose is a note for people and is
 *      not executed);
 *   3. every acceptance row the SPEC lists for the phase is bound to a real test
 *      (scripts/verify-acceptance-bindings.mjs rules), when gates.requireAcceptanceBindings
 *      is on and a spec is known;
 *   4. for the Exit Gate: every other phase of the plan is ticked, and every phase of the
 *      spec is bound.
 *
 *   node scripts/verify-plan-ticks.mjs --before B --after A [--fix] [--spec S] [--json]
 *
 * --fix un-ticks the offending phase lines in the --after file. Exit 0 = every new tick is
 * earned (or there were none), 1 = at least one is not, 2 = cannot run.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs, usageExit } from './lib/args.mjs';
import { getContext, readText } from './lib/context.mjs';
import { parsePlan, parseSpecPhases } from './lib/spec-parse.mjs';
import { checkAcceptanceBindings } from './lib/acceptance-bindings.mjs';

const USAGE = 'verify-plan-ticks.mjs --before B --after A [--fix] [--spec S] [--json]';
let args;
try { args = parseArgs(process.argv.slice(2), { flags: ['fix', 'json'], opts: ['before', 'after', 'spec'] }); } catch (e) { usageExit(e.message, USAGE); }
if (!args.before || !args.after || !fs.existsSync(args.before) || !fs.existsSync(args.after)) {
  usageExit('verify-plan-ticks: --before and --after must name existing plan files', USAGE);
}

const ctx = getContext();
const gatesOn = ctx.config.gates.requireAcceptanceBindings !== false;
const specArg = args.spec ?? ctx.activeSpec();
const specPath = specArg ? ctx.resolve(specArg) : null;
const specText = specPath && fs.existsSync(specPath) ? readText(specPath) : null;
const notes = [];
if (gatesOn && !specText) notes.push(`acceptance bindings not checked: no spec (${specArg ?? 'no --spec and no ACTIVE_SPEC'})`);

const afterText = readText(args.after);
const afterPlan = parsePlan(afterText);
const wasTicked = new Set(parsePlan(readText(args.before)).filter((p) => p.ticked).map((p) => p.key));
const newTicks = afterPlan.filter((p) => p.ticked && !wasTicked.has(p.key));

/** Backticked commands in a `gate:` clause. */
const gateCommands = (gate) => [...String(gate ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);

function runGate(command) {
  // The command comes from the project's own plan, so it runs as a shell line like any configured project command.
  const r = spawnSync(command, { cwd: ctx.root, shell: true, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  return { pass: r.status === 0, status: r.status, tail: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300) };
}

function verdict(phase) {
  const reasons = [];
  const open = phase.tasks.filter((t) => !t.ticked);
  if (open.length) reasons.push(`${open.length} of its ${phase.tasks.length} task(s) are still unticked (e.g. ${open.slice(0, 3).map((t) => t.text.slice(0, 50)).join('; ')})`);
  for (const command of gateCommands(phase.gate)) {
    const g = runGate(command);
    if (!g.pass) reasons.push(`gate \`${command}\` exited ${g.status}${g.tail ? ` — ${g.tail}` : ''}`);
  }
  if (phase.key === 'exit-gate') {
    const notDone = afterPlan.filter((p) => p.key !== 'exit-gate' && !p.ticked);
    if (notDone.length) reasons.push(`${notDone.length} earlier phase(s) are not ticked: ${notDone.map((p) => p.key).join(', ')}`);
  }
  let findings = [];
  if (gatesOn && specText) {
    const keys = phase.key === 'exit-gate' ? parseSpecPhases(specText).map((p) => p.key) : [phase.key];
    const r = checkAcceptanceBindings({ specText, planText: afterText, phaseKeys: keys, root: ctx.root, tests: ctx.config.tests });
    findings = r.findings;
    if (findings.length) {
      const sample = findings.slice(0, 3).map((f) => `${f.name ?? `[${f.tag}] row`} (${f.kind}, spec:${f.specLine})`);
      reasons.push(`${findings.length} acceptance row(s) not bound: ${sample.join('; ')}${findings.length > 3 ? '; ...' : ''} — node scripts/verify-acceptance-bindings.mjs --phase ${phase.key}`);
    }
  }
  return { reasons, findings };
}

const checked = newTicks.map((p) => {
  const v = verdict(p);
  return { key: p.key, line: p.line, text: p.text.trim().slice(0, 100), gate: p.gate, ok: v.reasons.length === 0, reasons: v.reasons, bindings: v.findings };
});
const illegitimate = checked.filter((c) => !c.ok);

if (args.fix && illegitimate.length) {
  const lines = afterText.split(/(\r?\n)/);
  // split with a capturing group keeps the separators, so line N is at index 2*(N-1).
  for (const c of illegitimate) {
    const idx = 2 * (c.line - 1);
    lines[idx] = lines[idx].replace(/^-\s*\[[xX]\]/, '- [ ]');
  }
  fs.writeFileSync(args.after, lines.join(''));
}

if (args.json) {
  console.log(JSON.stringify({ newTicks: newTicks.length, spec: specText ? specArg : null, notes, checked, illegitimate: illegitimate.length, fixed: Boolean(args.fix) && illegitimate.length > 0 }, null, 2));
} else {
  if (!newTicks.length) console.log('[plan-ticks] no new phase ticks');
  for (const c of checked) {
    console.log(`[plan-ticks] ${c.ok ? 'ok  ' : 'FAIL'} ${c.text}`);
    for (const r of c.reasons) console.log(`              ${r}`);
  }
  if (newTicks.length) for (const n of notes) console.log(`[plan-ticks] note: ${n}`);
  if (illegitimate.length) console.log(`[plan-ticks] ${illegitimate.length} tick(s) not earned${args.fix ? ' - reverted' : ''}`);
}
process.exit(illegitimate.length ? 1 : 0);

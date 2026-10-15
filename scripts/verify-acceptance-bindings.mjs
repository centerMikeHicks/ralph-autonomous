#!/usr/bin/env node
/**
 * Acceptance bindings — for every phase the plan ticks, is each of the spec's acceptance rows
 * bound to a real test (un-skipped, with an assertion, at the layer its tag demands)?
 *
 *   node scripts/verify-acceptance-bindings.mjs --spec S [--plan P] [--phase N[,N]] [--all] [--json]
 *
 *   --spec   default: the path in <stateDir>/ACTIVE_SPEC
 *   --plan   default: <stateDir>/IMPLEMENTATION_PLAN.md — the phases it ticks `[x]` are checked
 *   --phase  check these spec phases instead: `3`, `phase-3`, `4b`, `exit-gate`
 *   --all    check every phase of the spec regardless of the plan
 *
 * Test files are those matching config `tests.globs`; the layer check runs only when
 * `tests.layers` is configured. `gates.requireAcceptanceBindings: false` turns the script into a
 * reported no-op. Exit 0 = bound (or nothing to check), 1 = findings, 2 = cannot run.
 */
import fs from 'node:fs';
import { parseArgs, usageExit } from './lib/args.mjs';
import { getContext, readText } from './lib/context.mjs';
import { checkAcceptanceBindings } from './lib/acceptance-bindings.mjs';
import { parseSpecPhases, phaseKey } from './lib/spec-parse.mjs';

const USAGE = 'verify-acceptance-bindings.mjs --spec S [--plan P] [--phase N[,N]] [--all] [--json]';
let args;
try { args = parseArgs(process.argv.slice(2), { flags: ['all', 'json', 'strict'], opts: ['spec', 'plan', 'phase'] }); } catch (e) { usageExit(e.message, USAGE); }

const ctx = getContext();
if (ctx.config.gates.requireAcceptanceBindings === false) {
  const note = 'gates.requireAcceptanceBindings is false — acceptance bindings are not enforced';
  if (args.json) console.log(JSON.stringify({ skipped: true, note, findings: [] }));
  else console.log(`[acceptance-bindings] skipped: ${note}`);
  process.exit(0);
}

const specArg = args.spec ?? ctx.activeSpec();
if (!specArg) usageExit('verify-acceptance-bindings: no spec — pass --spec or set the ACTIVE_SPEC file', USAGE);
const specPath = ctx.resolve(specArg);
if (!fs.existsSync(specPath)) usageExit(`verify-acceptance-bindings: spec not found: ${specArg}`, USAGE);
const planPath = args.plan ? ctx.resolve(args.plan) : ctx.planPath;
const specText = readText(specPath);
const planText = fs.existsSync(planPath) ? readText(planPath) : '';
if (!args.all && !args.phase && !planText) usageExit(`verify-acceptance-bindings: no plan at ${planPath} — pass --plan, --phase or --all`, USAGE);

const toKey = (s) => (/^exit/i.test(s) ? 'exit-gate' : /^phase-/i.test(s) ? s.toLowerCase() : phaseKey(s));
const phaseKeys = args.all
  ? parseSpecPhases(specText).map((p) => p.key)
  : args.phase ? args.phase.split(',').map((s) => s.trim()).filter(Boolean).map(toKey) : null;

const result = checkAcceptanceBindings({ specText, planText, phaseKeys, root: ctx.root, tests: ctx.config.tests });

if (args.json) {
  console.log(JSON.stringify({ spec: args.spec ?? specArg, plan: planText ? planPath : null, ...result }, null, 2));
} else {
  if (!result.phases.length && !result.unknownPhases.length) console.log('[acceptance-bindings] no ticked phases to check');
  if (!result.layerCheck) console.log('[acceptance-bindings] note: tests.layers is not configured, so the layer tag is not checked');
  for (const p of result.phases) {
    const bound = p.rows.filter((r) => r.ok).length;
    console.log(`[acceptance-bindings] ${p.findings.length ? 'FAIL' : 'ok  '} ${p.key} — ${p.title} (spec:${p.specLine}) — ${bound}/${p.rows.length} row(s) bound`);
    for (const f of p.findings) {
      console.log(`    spec:${f.specLine} [${f.tag}] ${f.kind}: ${f.message}`);
      for (const t of f.tests) console.log(`        ${t}`);
    }
  }
  for (const k of result.unknownPhases) console.log(`[acceptance-bindings] WARN ${k} is not a phase of the spec`);
  if (result.findings.length) console.log(`[acceptance-bindings] ${result.findings.length} row(s) not bound`);
}
process.exit(result.findings.length || (args.phase && result.unknownPhases.length) ? 1 : 0);

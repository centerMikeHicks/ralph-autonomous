#!/usr/bin/env node
/**
 * base-health.mjs — how red is the branch this spec forked from?
 *
 *   node scripts/base-health.mjs [--base REF]          measure the base; write <stateDir>/base-health.json
 *   node scripts/base-health.mjs --compare [--fresh]   base vs HEAD, regression table, exit 1 on any increase
 *   node scripts/base-health.mjs --summary [--plan P]  print the recorded verdict
 *   [--scratch DIR] [--keep] [--only a,b] [--json]
 *
 * A spec's Exit Gate runs the project's mechanical checks, and on a red base every full run
 * exits non-zero for reasons the spec never touched. This script turns "no worse than the base"
 * into a measurement: the same commands run at the merge-base (in a temporary `git worktree`)
 * and at HEAD, compared per check.
 *
 * Checks come from config `gates.baseHealth.checks`, each `{ name, command }`:
 *   command      a shell string (run through the shell) or an argv array (run without one)
 *   failPattern  optional regex source; a line matching it is one finding
 *                (default: error / fail / failed / failure / "not ok" lines)
 *   timeoutMin   optional per-check ceiling (default 20)
 * A check's findings are its matching lines; if none match but the exit code is non-zero it
 * counts as one finding. `null` findings mean "could not measure" and never count as 0.
 *
 * `gates.baseHealth.link` (default ["node_modules"]) lists directories of the main tree that
 * are junctioned/symlinked into the base worktree so the checks can run without an install;
 * the links are removed - and verified gone - BEFORE the worktree is deleted, because a
 * recursive delete through a junction empties the main tree's directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, usageExit } from './lib/args.mjs';
import { getContext } from './lib/context.mjs';

const DEFAULT_FAIL = /\b(?:errors?|fail(?:ed|ure|ures|ing|s)?)\b|^\s*not ok\b|✖|✗/i;
const DEFAULT_TIMEOUT_MIN = 20;

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout.trim();
};

/** Run one configured check in `cwd`; never throws — a check that cannot run records null and why. */
export function runCheck(check, cwd) {
  const t0 = Date.now();
  const done = (findings, reason, extra = {}) => ({ findings, reason, seconds: Math.round((Date.now() - t0) / 10) / 100, ...extra });
  try {
    const timeout = (check.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60 * 1000;
    const opts = { cwd, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } };
    const r = Array.isArray(check.command)
      ? spawnSync(check.command[0], check.command.slice(1), { ...opts, shell: false })
      : spawnSync(String(check.command), { ...opts, shell: true });
    if (r.error) return done(null, `${r.error.code === 'ETIMEDOUT' ? `timed out after ${timeout / 60000} min` : r.error.message}`);
    const re = check.failPattern ? new RegExp(check.failPattern, 'i') : DEFAULT_FAIL;
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const failingLines = out.split(/\r?\n/).filter((l) => re.test(l)).length;
    const findings = failingLines > 0 ? failingLines : (r.status === 0 ? 0 : 1);
    return done(findings, `exit ${r.status}, ${failingLines} failing line(s)`, { exit: r.status, failingLines });
  } catch (e) {
    return done(null, `${check.name}: ${e.message}`);
  }
}

export function runChecks(checks, cwd, { only = null, log = () => undefined } = {}) {
  const out = {};
  for (const c of checks) {
    if (only && !only.includes(c.name)) continue;
    out[c.name] = runCheck(c, cwd);
    log(`  ${c.name.padEnd(16)} ${out[c.name].findings ?? 'null'}  (${out[c.name].reason}, ${out[c.name].seconds}s)`);
  }
  return out;
}

// --- the base worktree -------------------------------------------------------------------------
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

export function linkDirs(root, worktree, dirs) {
  const linked = [];
  for (const rel of dirs) {
    const target = path.join(root, rel);
    const link = path.join(worktree, rel);
    if (!fs.existsSync(target) || isLink(target) || fs.existsSync(link) || isLink(link)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, 'junction');
    linked.push(link);
  }
  return linked;
}

/** Remove the given links and PROVE each is gone; returns { ok, remaining? }. */
export function unlinkDirs(links) {
  for (const link of links) {
    try { fs.rmdirSync(link); } catch { try { fs.unlinkSync(link); } catch { /* verified below */ } }
    if (isLink(link) || fs.existsSync(link)) return { ok: false, remaining: link };
  }
  return { ok: true };
}

export function baseWorktree(root, sha, scratch) {
  const dir = path.join(scratch, sha.slice(0, 7));
  if (fs.existsSync(path.join(dir, '.git'))) {
    if (git(['rev-parse', 'HEAD'], dir) === sha) return { dir, reused: true };
    removeWorktree(root, dir, []);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(['worktree', 'add', '--detach', dir, sha], root);
  return { dir, reused: false };
}

export function removeWorktree(root, dir, links) {
  const un = unlinkDirs(links);
  if (!un.ok) {
    throw new Error(`refusing to remove ${dir}: the link ${un.remaining} is still in place and a recursive delete through it would empty the main tree's directory. Remove the link by hand, then: git worktree remove --force "${dir}"`);
  }
  git(['worktree', 'remove', '--force', dir], root);
}

// --- the verdict ---------------------------------------------------------------------------------
export const isRed = (checks) => Object.values(checks).some((c) => (c.findings ?? 0) > 0);

export function summarise(record) {
  const parts = Object.entries(record.checks).map(([n, c]) => `${n} ${c.findings ?? 'not measured'}`);
  const lines = [`Base ${String(record.base).slice(0, 7)} (${record.base_ref ?? 'merge-base'}) is ${isRed(record.checks) ? 'RED' : 'GREEN'}: ${parts.join(', ') || 'no checks'}  (measured ${record.at})`];
  for (const [n, c] of Object.entries(record.checks)) if (c.findings == null) lines.push(`  not measured — ${n}: ${c.reason}`);
  if (isRed(record.checks)) lines.push('  Exit Gate scope for this spec is `node scripts/base-health.mjs --compare` (no regression vs base), never a hand-written subset list.');
  return lines;
}

export function compareTable(base, head) {
  const rows = [];
  let regressed = 0;
  for (const name of Object.keys(base)) {
    const b = base[name]?.findings ?? null;
    const h = head[name]?.findings ?? null;
    const delta = b == null || h == null ? null : h - b;
    if (delta != null && delta > 0) regressed += 1;
    rows.push({ check: name, base: b, head: h, delta, verdict: delta == null ? 'n/a' : delta > 0 ? 'REGRESSION' : delta < 0 ? 'improved' : 'same' });
  }
  return { rows, regressed };
}

function printTable(rows) {
  const w0 = Math.max(5, ...rows.map((r) => r.check.length));
  console.log(['check'.padEnd(w0), 'base'.padStart(6), 'head'.padStart(6), 'delta'.padStart(6), 'verdict'].join('  '));
  for (const r of rows) {
    const d = r.delta == null ? 'n/a' : r.delta > 0 ? `+${r.delta}` : String(r.delta);
    console.log([r.check.padEnd(w0), String(r.base ?? 'null').padStart(6), String(r.head ?? 'null').padStart(6), d.padStart(6), r.verdict].join('  '));
  }
}

// --- main ----------------------------------------------------------------------------------------
function resolveBase(root, baseBranch, explicit) {
  const ok = (ref) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root }).status === 0;
  const ref = explicit ?? [`origin/${baseBranch}`, baseBranch].find(ok);
  if (!ref || !ok(ref)) throw new Error(`base ref ${explicit ?? `origin/${baseBranch} or ${baseBranch}`} does not exist in this repository`);
  return { ref, sha: git(['merge-base', ref, 'HEAD'], root) };
}

function main() {
  const USAGE = 'base-health.mjs [--base REF] | --compare [--fresh] | --summary [--plan P] [--json]';
  let args;
  try {
    args = parseArgs(process.argv.slice(2), { flags: ['compare', 'fresh', 'summary', 'keep', 'json'], opts: ['base', 'plan', 'scratch', 'only'] });
  } catch (e) { usageExit(e.message, USAGE); }
  const ctx = getContext();
  const stateFile = path.join(ctx.stateDir, 'base-health.json');
  const log = (s) => { if (!args.json) console.log(s); };

  if (args.summary) {
    if (!fs.existsSync(stateFile)) { console.log(`[base-health] no ${path.relative(ctx.root, stateFile).split(path.sep).join('/')} — run \`node scripts/base-health.mjs\` first so the plan can record whether the base is red or green.`); return; }
    const rec = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (args.json) { console.log(JSON.stringify(rec)); return; }
    for (const l of summarise(rec)) console.log(l);
    if (args.plan && isRed(rec.checks)) {
      const text = fs.existsSync(args.plan) ? fs.readFileSync(args.plan, 'utf8') : '';
      if (!/base is red/i.test(text)) console.log(`WARNING: the base is red but ${args.plan} has no "base is red" note — record the base-health verdict in the plan before the build loop starts.`);
    }
    return;
  }

  const checks = ctx.config.gates.baseHealth?.checks ?? [];
  if (!checks.length) {
    log('[base-health] gates.baseHealth.checks is empty — nothing to measure (add { "name", "command" } entries to ralph.config.json)');
    if (args.json) console.log(JSON.stringify({ checks: {}, configured: false }));
    return;
  }
  const bad = checks.find((c) => !c || typeof c.name !== 'string' || !c.command);
  if (bad) usageExit(`base-health: every gates.baseHealth.checks entry needs "name" and "command" (got ${JSON.stringify(bad)})`, USAGE);

  let base;
  try { base = resolveBase(ctx.root, ctx.config.project.baseBranch, args.base); } catch (e) { usageExit(`base-health: ${e.message}`, USAGE); }
  const only = args.only ? args.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const scratch = path.resolve(args.scratch ?? path.join(ctx.root, '.claude-temp', 'base-health'));

  let record = null;
  if (!args.fresh && fs.existsSync(stateFile)) {
    try { const prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (prev.base === base.sha && !only) record = prev; } catch { record = null; }
  }
  if (record) log(`[base-health] base ${base.sha.slice(0, 7)} already measured at ${record.at} (pass --fresh to re-measure)`);
  else {
    log(`[base-health] measuring base ${base.sha.slice(0, 7)} (merge-base of ${base.ref} and HEAD) in a temporary worktree under ${scratch}`);
    const wt = baseWorktree(ctx.root, base.sha, scratch);
    const links = linkDirs(ctx.root, wt.dir, ctx.config.gates.baseHealth.link ?? ['node_modules']);
    let measured;
    try {
      measured = runChecks(checks, wt.dir, { only, log });
    } finally {
      if (args.keep) { log(`[base-health] --keep: worktree left at ${wt.dir}`); }
      else { removeWorktree(ctx.root, wt.dir, links); log('[base-health] worktree removed (links verified gone first)'); }
    }
    record = { base: base.sha, base_ref: `merge-base of ${base.ref} and HEAD`, at: new Date().toISOString(), checks: measured };
    if (!only) { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, `${JSON.stringify(record, null, 2)}\n`); }
  }

  if (!args.compare) {
    if (args.json) console.log(JSON.stringify(record));
    else for (const l of summarise(record)) console.log(l);
    return;
  }

  log(`[base-health] measuring HEAD (${git(['rev-parse', '--short', 'HEAD'], ctx.root)}) in the working tree`);
  const head = runChecks(checks, ctx.root, { only: only ?? Object.keys(record.checks), log });
  const { rows, regressed } = compareTable(record.checks, head);
  const out = { ...record, compare: { at: new Date().toISOString(), head: git(['rev-parse', 'HEAD'], ctx.root), checks: head, rows, regressed } };
  if (!only) fs.writeFileSync(stateFile, `${JSON.stringify(out, null, 2)}\n`);
  if (args.json) console.log(JSON.stringify(out));
  else {
    console.log('');
    printTable(rows);
    console.log('');
    console.log(regressed
      ? `[base-health] ${regressed} check(s) regressed vs base ${base.sha.slice(0, 7)} — fix them; the Exit Gate does not certify a regression.`
      : `[base-health] no regression vs base ${base.sha.slice(0, 7)}${isRed(record.checks) ? ' (the base is red; the head is no redder)' : ''}.`);
  }
  process.exit(regressed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[base-health] ${e.message}`); process.exit(2); }
}

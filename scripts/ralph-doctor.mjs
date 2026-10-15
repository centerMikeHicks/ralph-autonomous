#!/usr/bin/env node
/**
 * ralph-doctor — is this checkout ready to run the loops?
 *
 *   node scripts/ralph-doctor.mjs [--json] [--root DIR]
 *
 * Prints a pass / warn / fail table. Exit 1 when any check fails (warnings do not fail).
 * Checks: node >= 20, git repository, agent CLI reachable (PATH or RALPH_AGENT_CMD),
 * ralph.config.json parses and validates, specs/state directories, git hooks installed,
 * ledger present, tracker configuration sane, state directories writable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, usageExit } from './lib/args.mjs';
import { CONFIG_FILE, DEFAULTS, findRoot, loadConfig } from './lib/config.mjs';

/** Resolve an executable name against PATH (honouring PATHEXT on Windows); null when absent. */
export function which(cmd, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const candidates = path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\') ? [cmd] : dirs.map((d) => path.join(d, cmd));
  for (const base of candidates) {
    for (const ext of ['', ...exts]) {
      const p = base + ext;
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

/** The executable named at the start of a command line: a quoted string, else up to the first space. */
export function firstToken(line) {
  const t = String(line).trim();
  const q = /^(["'])(.*?)\1/.exec(t);
  return q ? q[2] : t.split(/\s+/)[0];
}

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe);
    return true;
  } catch { return false; }
}

/** Run all checks; returns [{ name, status: 'pass'|'warn'|'fail', detail }]. */
export function diagnose(root, { env = process.env } = {}) {
  const results = [];
  const add = (name, status, detail) => results.push({ name, status, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node >= 20', major >= 20 ? 'pass' : 'fail', `node ${process.versions.node}`);

  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  const isRepo = git.status === 0;
  add('git repository', isRepo ? 'pass' : 'fail', isRepo ? root : (git.error ? 'git is not installed or not on PATH' : `${root} is not inside a git work tree`));

  let config = null;
  const configPath = path.join(root, CONFIG_FILE);
  try {
    config = loadConfig(root);
    add(`${CONFIG_FILE} parses`, fs.existsSync(configPath) ? 'pass' : 'warn', fs.existsSync(configPath) ? configPath : 'not found - built-in defaults are in use (copy templates/config.example.json)');
  } catch (e) {
    add(`${CONFIG_FILE} parses`, 'fail', e.message.split('\n').join(' '));
    config = JSON.parse(JSON.stringify(DEFAULTS));
  }

  const override = env.RALPH_AGENT_CMD;
  if (override) {
    const first = firstToken(override);
    const found = which(override.trim(), env) ?? which(first, env);
    add('agent CLI', found ? 'pass' : 'fail', found ? `RALPH_AGENT_CMD -> ${found}` : `RALPH_AGENT_CMD names "${first}", which is not an executable file or on PATH`);
  } else {
    const cmd = config.agent.command;
    const found = which(cmd, env);
    add('agent CLI', found ? 'pass' : 'fail', found ? `${cmd} -> ${found}` : `"${cmd}" is not on PATH (set agent.command or RALPH_AGENT_CMD)`);
  }

  const specsDir = path.resolve(root, config.project.specsDir);
  const stateDir = path.resolve(root, config.project.stateDir);
  add('specs directory', fs.existsSync(specsDir) ? 'pass' : 'warn', fs.existsSync(specsDir) ? specsDir : `${specsDir} does not exist yet (the design command creates it)`);
  add('state directory', fs.existsSync(stateDir) ? 'pass' : 'warn', fs.existsSync(stateDir) ? stateDir : `${stateDir} does not exist yet (created on first run)`);

  if (isRepo) {
    const hp = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const hookFile = path.join(root, '.githooks', 'pre-commit');
    if (hp === '.githooks' && fs.existsSync(hookFile)) add('git hooks installed', 'pass', 'core.hooksPath = .githooks');
    else add('git hooks installed', 'warn', hp ? `core.hooksPath is "${hp}", expected ".githooks"` : 'run: node scripts/install-hooks.mjs');
  } else add('git hooks installed', 'warn', 'no git repository');

  const ledger = path.join(stateDir, 'SPECS_LEDGER.md');
  add('ledger present', fs.existsSync(ledger) ? 'pass' : 'warn', fs.existsSync(ledger) ? ledger : `missing - copy templates/ledger.md to ${path.relative(root, ledger).split(path.sep).join('/')}`);

  if (config.tracker.provider === 'jira') {
    const j = config.tracker.jira ?? {};
    const problems = [];
    if (!j.project || j.project === 'PROJ') problems.push('tracker.jira.project is unset (still the placeholder "PROJ")');
    if (!j.site && !j.cloudId) problems.push('neither tracker.jira.site nor tracker.jira.cloudId is set');
    for (const k of ['buildStarted', 'exitGate', 'designFinalized']) if (!j.transitions?.[k]) problems.push(`tracker.jira.transitions.${k} is empty`);
    add('tracker config', problems.length ? 'fail' : 'pass', problems.length ? problems.join('; ') : `jira project ${j.project}`);
  } else add('tracker config', 'pass', 'tracker.provider = none');

  const dirs = [stateDir, path.join(root, '.claude-temp', 'ralph-queue')];
  const bad = dirs.filter((d) => !writable(d));
  add('state dirs writable', bad.length ? 'fail' : 'pass', bad.length ? `cannot write to ${bad.join(', ')}` : dirs.map((d) => path.relative(root, d).split(path.sep).join('/')).join(', '));

  return results;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2), { flags: ['json'], opts: ['root'] }); } catch (e) { usageExit(e.message, 'ralph-doctor.mjs [--json] [--root DIR]'); }
  const root = args.root ? path.resolve(args.root) : findRoot(process.cwd(), { kitDir: path.dirname(fileURLToPath(import.meta.url)) });
  const results = diagnose(root);
  const failed = results.filter((r) => r.status === 'fail').length;
  if (args.json) {
    console.log(JSON.stringify({ root, ok: failed === 0, platform: `${os.platform()} ${os.arch()}`, checks: results }, null, 2));
  } else {
    const w = Math.max(...results.map((r) => r.name.length));
    const label = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
    for (const r of results) console.log(`${label[r.status]}  ${r.name.padEnd(w)}  ${r.detail}`);
    console.log(failed ? `\n${failed} check(s) failed.` : `\nReady${results.some((r) => r.status === 'warn') ? ' (with warnings)' : ''}.`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

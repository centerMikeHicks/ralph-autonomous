#!/usr/bin/env node
/**
 * Point git at the kit's hooks: `git config core.hooksPath .githooks`, and make the hook files
 * executable on POSIX. Idempotent — running it twice changes nothing the second time.
 *
 * It will not silently switch off hooks you already have: if core.hooksPath points somewhere else
 * (husky, lefthook, your own folder) or `.git/hooks/pre-commit` is a real hook, it stops and says how
 * to keep them (call them from `hooks.preCommit`), unless you pass --force.
 *
 *   node scripts/install-hooks.mjs [--root DIR] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, usageExit } from './lib/args.mjs';
import { findRoot } from './lib/config.mjs';

export const HOOKS_DIR = '.githooks';

/**
 * Hooks that installing would disable: a different core.hooksPath, or a non-sample pre-commit in git's
 * own hooks directory. Returns a list of human-readable descriptions (empty when nothing is in the way).
 */
export function existingHooks(root) {
  const found = [];
  const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  if (current && current !== HOOKS_DIR) found.push(`core.hooksPath is already "${current}"`);
  if (!current) {
    const gitHooks = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const preCommit = gitHooks && path.resolve(root, gitHooks, 'pre-commit');
    if (preCommit && fs.existsSync(preCommit)) found.push(`${path.relative(root, preCommit).split(path.sep).join('/')} exists`);
  }
  return found;
}

/** Install into `root`; returns { changed, hooksPath, chmodded }. Throws when `root` is not a git work tree. */
export function installHooks(root, { force = false } = {}) {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (inside.status !== 0) throw new Error(`${root} is not inside a git work tree`);
  const dir = path.join(root, HOOKS_DIR);
  if (!fs.existsSync(dir)) throw new Error(`${HOOKS_DIR}/ not found in ${root}`);
  const existing = existingHooks(root);
  if (existing.length && !force) {
    throw new Error(`installing would disable your existing hooks (${existing.join('; ')}). `
      + 'Keep them by listing them in ralph.config.json "hooks.preCommit" (for example "hooks": { "preCommit": ["sh .husky/pre-commit"] }), '
      + 'which .githooks/pre-commit runs after its own gate, then re-run with --force.');
  }
  const current = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  let changed = false;
  if (current !== HOOKS_DIR) {
    const set = spawnSync('git', ['config', '--local', 'core.hooksPath', HOOKS_DIR], { cwd: root, encoding: 'utf8' });
    if (set.status !== 0) throw new Error(`git config failed: ${set.stderr.trim()}`);
    changed = true;
  }
  const chmodded = [];
  if (process.platform !== 'win32') {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (!fs.statSync(p).isFile()) continue;
      const mode = fs.statSync(p).mode;
      if ((mode & 0o111) !== 0o111) { fs.chmodSync(p, mode | 0o755); chmodded.push(f); changed = true; }
    }
  }
  return { changed, hooksPath: HOOKS_DIR, chmodded };
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2), { flags: ['force'], opts: ['root'] }); } catch (e) { usageExit(e.message, 'install-hooks.mjs [--root DIR] [--force]'); }
  const root = args.root ? path.resolve(args.root) : findRoot();
  try {
    const r = installHooks(root, { force: Boolean(args.force) });
    console.log(r.changed
      ? `[install-hooks] core.hooksPath -> ${r.hooksPath}${r.chmodded.length ? `; made executable: ${r.chmodded.join(', ')}` : ''}`
      : `[install-hooks] already installed (core.hooksPath = ${r.hooksPath})`);
  } catch (e) {
    console.error(`[install-hooks] ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

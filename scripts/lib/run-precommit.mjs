#!/usr/bin/env node
/**
 * Runs the project's own pre-commit commands from ralph.config.json `hooks.preCommit`.
 * Called by .githooks/pre-commit after the tracker-sync gate.
 *
 *   "hooks": { "preCommit": ["npm run lint --silent", ["node", "scripts/check.js"]] }
 *
 * Each entry is a shell string (run through the shell) or an argv array (run without one).
 * They run in order from the project root and the first failure stops the commit (exit 1).
 * An absent or empty list is a pass. Env RALPH_PRECOMMIT=1 is set for the commands.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getContext } from './context.mjs';

/** Run `entries` in `cwd`; returns the failing entry's status (1 when it had none), or 0. */
export function runPreCommit(entries, cwd, { log = console.log } = {}) {
  for (const entry of entries) {
    const display = Array.isArray(entry) ? entry.join(' ') : String(entry);
    log(`[pre-commit] ${display}`);
    const env = { ...process.env, RALPH_PRECOMMIT: '1' };
    const r = Array.isArray(entry)
      ? spawnSync(entry[0], entry.slice(1), { cwd, stdio: 'inherit', shell: false, env })
      : spawnSync(String(entry), { cwd, stdio: 'inherit', shell: true, env });
    if (r.error || r.status !== 0) {
      log(`[pre-commit] BLOCKED: \`${display}\` ${r.error ? `could not run (${r.error.message})` : `exited ${r.status}`}`);
      return r.status || 1;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ctx = getContext();
  const list = ctx.config.hooks?.preCommit;
  const entries = Array.isArray(list) ? list.filter((e) => (typeof e === 'string' && e.trim()) || (Array.isArray(e) && e.length)) : [];
  process.exit(runPreCommit(entries, ctx.root) ? 1 : 0);
}

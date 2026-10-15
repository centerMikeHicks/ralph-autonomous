#!/usr/bin/env node
/**
 * new-lane — create a parallel lane: a sibling git worktree on its own branch, with its own
 * queue file, so a second loop can work specs while the first keeps running.
 *
 *   node scripts/new-lane.mjs --name X [--base BRANCH] [--root DIR] [--dry-run]
 *   node scripts/new-lane.mjs X ...            (the name may be positional)
 *
 * What it does (and nothing else):
 *   git worktree add -b <base>-lane-<name> ../<project-dir>-lane-<name> <base>
 *   copies ralph.config.json into the lane when the checkout did not bring it (untracked)
 *   creates <lane>/.claude-temp/ralph-queue/QUEUE.md (from templates/queue.md)
 *   prints the exact next steps
 * It never deletes, resets or overwrites anything; an existing branch or directory is a refusal.
 * --dry-run prints the plan and changes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, usageExit } from './lib/args.mjs';
import { CONFIG_FILE, findRoot } from './lib/config.mjs';

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const toPosix = (p) => p.split(path.sep).join('/');

const DEFAULT_QUEUE = `# Ralph queue (lane)

One spec per line. The runner rewrites the marker in place.

<!-- add entries below, one per line: - [ ] specs/your-spec.md -->
`;

/**
 * Compute (and unless dryRun, perform) the lane creation.
 * @returns {{ name, base, branch, laneDir, queueFile, steps: string[], nextSteps: string[], dryRun: boolean }}
 */
export function createLane({ root, name, base = null, dryRun = false }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name ?? '')) throw new Error('lane name must be lowercase letters, digits and dashes (e.g. "backend")');
  if (git(['rev-parse', '--is-inside-work-tree'], root).status !== 0) throw new Error(`${root} is not inside a git work tree`);
  const top = path.resolve(git(['rev-parse', '--show-toplevel'], root).stdout.trim());
  let baseBranch = base;
  if (!baseBranch) {
    baseBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], top).stdout.trim();
    if (!baseBranch || baseBranch === 'HEAD') throw new Error('HEAD is detached; pass --base BRANCH');
  }
  if (git(['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`], top).status !== 0) throw new Error(`base "${baseBranch}" does not exist`);
  const branch = `${baseBranch}-lane-${name}`;
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], top).status === 0) throw new Error(`branch "${branch}" already exists; pick another --name`);
  const laneDir = path.resolve(top, '..', `${path.basename(top)}-lane-${name}`);
  if (fs.existsSync(laneDir)) throw new Error(`${laneDir} already exists; nothing was changed`);

  const queueFile = path.join(laneDir, '.claude-temp', 'ralph-queue', 'QUEUE.md');
  const hasConfig = fs.existsSync(path.join(top, CONFIG_FILE));
  const steps = [
    `git worktree add -b ${branch} ${laneDir} ${baseBranch}`,
    ...(hasConfig ? [`copy ${CONFIG_FILE} into the lane if the checkout did not bring it`] : []),
    `create ${queueFile}`,
  ];
  const nextSteps = [
    `cd ${laneDir}`,
    'install the project dependencies there (the lane is a separate checkout)',
    'node scripts/ralph-doctor.mjs                      # hooks are shared: core.hooksPath lives in the common git config',
    `edit ${toPosix(path.relative(laneDir, queueFile))}  # list the specs this lane owns, one "- [ ] specs/x.md" per line`,
    'node scripts/ralph-queue.cjs start                   # detached runner for this lane',
    'node scripts/ralph-queue.cjs watch                   # block until the runner logs an event or exits',
    `in the main checkout's queue, mark each moved spec:  - [!] specs/<name>.md — MOVED to lane ${name}`,
    `when a lane spec is reviewed: node scripts/lane-merge-notes.mjs --lane ${branch} --base ${baseBranch}`,
  ];
  const result = { name, base: baseBranch, branch, laneDir, queueFile, steps, nextSteps, dryRun };
  if (dryRun) return result;

  const add = git(['worktree', 'add', '-b', branch, laneDir, baseBranch], top);
  if (add.status !== 0) throw new Error(`git worktree add failed: ${(add.stderr || add.stdout).trim()}`);
  if (hasConfig && !fs.existsSync(path.join(laneDir, CONFIG_FILE))) fs.copyFileSync(path.join(top, CONFIG_FILE), path.join(laneDir, CONFIG_FILE));
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });
  const template = path.join(KIT_DIR, 'templates', 'queue.md');
  if (!fs.existsSync(queueFile)) fs.writeFileSync(queueFile, fs.existsSync(template) ? fs.readFileSync(template, 'utf8') : DEFAULT_QUEUE);
  return result;
}

function main() {
  const USAGE = 'new-lane.mjs --name X [--base BRANCH] [--root DIR] [--dry-run]';
  let args;
  try { args = parseArgs(process.argv.slice(2), { flags: ['dry-run'], opts: ['name', 'base', 'root'] }); } catch (e) { usageExit(e.message, USAGE); }
  const name = args.name ?? args._[0];
  if (!name) usageExit('new-lane: a lane name is required', USAGE);
  const root = args.root ? path.resolve(args.root) : findRoot(process.cwd());
  try {
    const r = createLane({ root, name, base: args.base ?? null, dryRun: Boolean(args['dry-run']) });
    console.log(`${r.dryRun ? '[dry-run] would create' : 'Created'} lane "${r.name}": branch ${r.branch}, directory ${r.laneDir}`);
    for (const s of r.steps) console.log(`  ${r.dryRun ? 'would run' : 'ran'}: ${s}`);
    console.log('\nNext steps:');
    r.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  } catch (e) {
    console.error(`[new-lane] ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

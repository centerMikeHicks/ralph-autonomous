// Progress fingerprint and eject decisions.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256File, toPosix } from './fsutil.mjs';

// Files the loop and the agent rewrite every iteration as bookkeeping; they are not work.
const VOLATILE = [
  /(^|\/)ITERATION_STATUS\.json$/,
  /(^|\/)iterations\.jsonl$/,
  /(^|\/)loop-events(\.pending)?\.jsonl$/,
  /(^|\/)USAGE_LOG\.md$/,
  /(^|\/)ITERATION_LOG\.md$/,
  /(^|\/)\.loop-heartbeat$/,
  /(^|\/)\.last-iteration-end$/,
  /(^|\/)PREFLIGHT_FAILURE\.md$/,
  /(^|\/)\.ralph\/logs\//,
];

/** Drop bookkeeping paths from `git status --porcelain` text. */
export function filterPorcelain(text, stateDir = '.ralph') {
  const state = toPosix(stateDir).replace(/^\.\//, '').replace(/\/$/, '');
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return false;
      const file = toPosix(line.slice(3)).replace(/^"|"$/g, '');
      const inState = file === state || file.startsWith(`${state}/`);
      return !(inState && VOLATILE.some((re) => re.test(`/${file}`)));
    })
    .join('\n');
}

export function gitText(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false });
  return r.status === 0 ? r.stdout : '';
}

/**
 * Everything an iteration could plausibly have changed, as one string: the plan file hash
 * (the plan is gitignored, so phase bookkeeping never moves HEAD) and the working-tree status.
 * HEAD alone is too narrow: it would eject iterations that did real, uncommitted work.
 */
export function progressFingerprint({ root, planFile, stateDir = '.ralph' }) {
  const plan = sha256File(planFile);
  const tree = filterPorcelain(gitText(root, ['status', '--porcelain', '--untracked-files=all']), stateDir);
  return `${plan}|${tree}`;
}

/**
 * Decide whether to stop after an iteration.
 *   blocked : the agent reported outcome "blocked" (a person must decide)
 *   stalled : two consecutive iterations left the fingerprint and HEAD unchanged
 * @returns {{stop: ''|'blocked'|'stalled', stalled: number}}
 */
export function ejectDecision({ outcome, fingerprintBefore, fingerprintAfter, headBefore, headAfter, stalled = 0, limit = 2 }) {
  const headMoved = headAfter !== headBefore;
  const workChanged = fingerprintBefore !== fingerprintAfter;
  let count = stalled;
  let stop = outcome === 'blocked' ? 'blocked' : '';
  if (!headMoved && !workChanged) {
    count += 1;
    if (!stop && count >= limit) stop = 'stalled';
  } else {
    count = 0;
  }
  return { stop, stalled: count };
}

export function resolveStateDir(root, cfg) {
  return path.resolve(root, (cfg && cfg.project && cfg.project.stateDir) || '.ralph');
}

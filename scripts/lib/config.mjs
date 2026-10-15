/**
 * Project configuration for the kit: `ralph.config.json` merged over DEFAULTS.
 *
 *   import { loadConfig, findRoot, getCommand } from './config.mjs';
 *   const config = loadConfig();                    // root found from the cwd
 *   const test = getCommand(config, 'test');        // null when not configured
 *
 * Every key is optional. Objects are merged key by key, arrays and scalars in the
 * file replace the default wholesale, and keys the kit does not know are kept so a
 * project can carry its own settings in the same file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = 'ralph.config.json';

export const DEFAULTS = Object.freeze({
  project: { name: 'my-project', baseBranch: 'main', specsDir: 'specs', stateDir: '.ralph' },
  agent: {
    command: 'claude',
    args: ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'],
    modelFlag: '--model',
    effortFlag: '--effort',
    subagentModelEnv: 'CLAUDE_CODE_SUBAGENT_MODEL',
  },
  models: {
    planning: 'opus',
    execution: 'sonnet',
    mechanical: 'haiku',
    review: 'opus',
    efforts: { planning: 'high', execution: 'medium', mechanical: 'low', exitGate: 'high' },
  },
  commands: { test: null, lint: null, typecheck: null, build: null, affectedTest: null, format: null },
  tests: { globs: ['**/*.test.*', '**/*.spec.*'], ignore: ['**/node_modules/**'] },
  gates: {
    exitGate: ['lint', 'typecheck', 'build', 'test'],
    baseHealth: { checks: [] },
    requireAcceptanceBindings: true,
    reviewSubagent: 'code-review',
  },
  tracker: {
    provider: 'none',
    jira: {
      project: 'PROJ',
      site: null,
      cloudId: null,
      transitions: { buildStarted: 'In Progress', exitGate: 'Review Required', designFinalized: 'Ready For Development' },
    },
  },
  queue: { buildChunk: 3, maxBuild: 40, maxReview: 8, minFreeGb: 4, maxRetries: 3, watchTimeoutMin: 45 },
  // ownerProcessNames: process names (without .exe) that count as an agent session when a
  // detached service looks for the session that owns it. See scripts/lib/sweep.cjs findOwner.
  sweep: { timeoutMin: 180, stallMin: 20, ownerProcessNames: ['claude'] },
  review: { scopeAuditAfterPasses: 5 },
  drift: { warnCommits: 50 },
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Merge `over` onto `base` without mutating either; arrays and scalars in `over` replace. */
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return clone(over);
  const out = clone(base);
  for (const [key, value] of Object.entries(over)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

const T = {
  string: (v) => typeof v === 'string',
  nonEmptyString: (v) => typeof v === 'string' && v.length > 0,
  boolean: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  stringArray: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  command: (v) => v === null || (typeof v === 'string' && v.trim() !== '') || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')),
};

/** [dotted path, predicate, human description]; only keys present in the merged config are checked. */
const RULES = [
  ['project.name', T.nonEmptyString, 'a non-empty string'],
  ['project.baseBranch', T.nonEmptyString, 'a non-empty string'],
  ['project.specsDir', T.nonEmptyString, 'a non-empty string'],
  ['project.stateDir', T.nonEmptyString, 'a non-empty string'],
  ['agent.command', T.nonEmptyString, 'a non-empty string'],
  ['agent.args', T.stringArray, 'an array of strings'],
  ['agent.modelFlag', T.string, 'a string'],
  ['agent.effortFlag', T.string, 'a string'],
  ['agent.subagentModelEnv', T.string, 'a string'],
  ['models.planning', T.nonEmptyString, 'a non-empty string'],
  ['models.execution', T.nonEmptyString, 'a non-empty string'],
  ['models.mechanical', T.nonEmptyString, 'a non-empty string'],
  ['models.review', T.nonEmptyString, 'a non-empty string'],
  ['tests.globs', T.stringArray, 'an array of strings'],
  ['tests.ignore', T.stringArray, 'an array of strings'],
  ['gates.exitGate', T.stringArray, 'an array of gate names'],
  ['gates.baseHealth.checks', (v) => Array.isArray(v), 'an array'],
  ['gates.requireAcceptanceBindings', T.boolean, 'true or false'],
  ['gates.reviewSubagent', T.string, 'a string'],
  ['tracker.provider', (v) => v === 'none' || v === 'jira', '"none" or "jira"'],
  ['queue.buildChunk', T.number, 'a non-negative number'],
  ['queue.maxBuild', T.number, 'a non-negative number'],
  ['queue.maxReview', T.number, 'a non-negative number'],
  ['queue.minFreeGb', T.number, 'a non-negative number'],
  ['queue.maxRetries', T.number, 'a non-negative number'],
  ['queue.watchTimeoutMin', T.number, 'a non-negative number'],
  ['sweep.timeoutMin', T.number, 'a non-negative number of minutes'],
  ['sweep.stallMin', T.number, 'a non-negative number of minutes'],
  ['sweep.ownerProcessNames', T.stringArray, 'an array of process names'],
  ['review.scopeAuditAfterPasses', T.number, 'a non-negative number'],
  ['drift.warnCommits', T.number, 'a non-negative number'],
];

const SECTIONS = ['project', 'agent', 'models', 'commands', 'tests', 'gates', 'tracker', 'queue', 'sweep', 'review', 'drift'];

const getPath = (obj, dotted) => dotted.split('.').reduce((acc, k) => (isPlainObject(acc) ? acc[k] : undefined), obj);

/** Throw one error naming every invalid key, so a bad file is fixed in one pass. */
export function validateConfig(config, source = CONFIG_FILE) {
  const problems = [];
  for (const section of SECTIONS) {
    if (!isPlainObject(config[section])) problems.push(`"${section}" must be an object`);
  }
  for (const [dotted, ok, want] of RULES) {
    const value = getPath(config, dotted);
    if (value !== undefined && !ok(value)) problems.push(`"${dotted}" must be ${want}, got ${JSON.stringify(value)}`);
  }
  if (isPlainObject(config.commands)) {
    for (const [name, value] of Object.entries(config.commands)) {
      if (!T.command(value)) problems.push(`"commands.${name}" must be null, a command string or a non-empty array of strings, got ${JSON.stringify(value)}`);
    }
  }
  if (isPlainObject(config.models?.efforts)) {
    for (const [name, value] of Object.entries(config.models.efforts)) {
      if (typeof value !== 'string') problems.push(`"models.efforts.${name}" must be a string, got ${JSON.stringify(value)}`);
    }
  }
  if (problems.length) throw new Error(`${source}: invalid configuration\n  - ${problems.join('\n  - ')}`);
  return config;
}

/**
 * The project root: the nearest directory at or above `start` holding ralph.config.json;
 * else (when `kitDir` is given) the nearest one above the kit's own directory; else the
 * nearest directory holding `.git`; else `start`.
 */
export function findRoot(start = process.cwd(), { kitDir = null } = {}) {
  const walk = (from, marker) => {
    let dir = path.resolve(from);
    for (;;) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };
  return walk(start, CONFIG_FILE)
    ?? (kitDir ? walk(kitDir, CONFIG_FILE) : null)
    ?? walk(start, '.git')
    ?? path.resolve(start);
}

/** The root for a script living one level below the kit root: RALPH_ROOT, else findRoot. */
export function resolveRoot(importMetaUrl, { env = process.env } = {}) {
  if (env.RALPH_ROOT) return path.resolve(env.RALPH_ROOT);
  const kitDir = importMetaUrl ? path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..') : null;
  return findRoot(process.cwd(), { kitDir });
}

/** Read, BOM-tolerantly, `<root>/ralph.config.json`; null when absent. */
function readConfigFile(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err.message})`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${file}: the top level must be a JSON object`);
  return parsed;
}

/** DEFAULTS merged with `<root>/ralph.config.json` (root defaults to findRoot()). Validated. */
export function loadConfig(root = findRoot()) {
  const abs = path.resolve(root);
  const merged = deepMerge(DEFAULTS, readConfigFile(abs) ?? {});
  validateConfig(merged, path.join(abs, CONFIG_FILE));
  return merged;
}

/**
 * The configured command `name` (a key of `commands`), normalised, or null when it is
 * missing or not configured:
 *   { kind: 'shell', command: 'npm test', args: [], display }    a string, run through a shell
 *   { kind: 'argv',  command: 'node', args: ['t.js'], display }  an array, run without one
 */
export function getCommand(config, name) {
  const value = config?.commands?.[name];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.trim() === '' ? null : { kind: 'shell', command: value, args: [], display: value };
  }
  if (Array.isArray(value) && value.length > 0) {
    return { kind: 'argv', command: value[0], args: value.slice(1), display: value.join(' ') };
  }
  throw new Error(`commands.${name} must be null, a command string or an array of strings`);
}

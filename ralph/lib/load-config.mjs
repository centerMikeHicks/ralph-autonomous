// Loads ralph.config.json through scripts/lib/config.mjs when the kit ships it, and falls back
// to a built-in merge of the documented defaults so the loop still runs without it.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './fsutil.mjs';

export const FALLBACK_DEFAULTS = {
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
  gates: { exitGate: ['lint', 'typecheck', 'build', 'test'] },
  tracker: { provider: 'none', jira: { project: 'PROJ', site: null, cloudId: null } },
  sweep: { timeoutMin: 180, stallMin: 20 },
};

export function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over === undefined ? base : over;
  if (base && typeof base === 'object' && over && typeof over === 'object') {
    const out = { ...base };
    for (const key of Object.keys(over)) out[key] = deepMerge(base[key], over[key]);
    return out;
  }
  return over === undefined ? base : over;
}

export async function loadProjectConfig(root) {
  const shared = path.join(root, 'scripts', 'lib', 'config.mjs');
  if (fs.existsSync(shared)) {
    try {
      const mod = await import(pathToFileURL(shared).href);
      if (typeof mod.loadConfig === 'function') return await mod.loadConfig(root);
    } catch {
      // fall through to the built-in merge
    }
  }
  return deepMerge(FALLBACK_DEFAULTS, readJson(path.join(root, 'ralph.config.json'), {}) || {});
}

/**
 * What every verifier script needs first: the project root, its configuration, and the
 * conventional paths (active spec, live plan). Root resolution is `resolveRoot` from config.mjs
 * (RALPH_ROOT, else the nearest ralph.config.json / git root).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveRoot } from './config.mjs';

export function getContext() {
  const root = resolveRoot(import.meta.url);
  const config = loadConfig(root);
  const stateDir = path.resolve(root, config.project.stateDir);
  const specsDir = path.resolve(root, config.project.specsDir);
  return {
    root,
    config,
    stateDir,
    specsDir,
    planPath: path.join(stateDir, 'IMPLEMENTATION_PLAN.md'),
    /** A user-supplied path: relative to the cwd if it exists there, else to the project root. */
    resolve(p) {
      const fromCwd = path.resolve(process.cwd(), p);
      return fs.existsSync(fromCwd) ? fromCwd : path.resolve(root, p);
    },
    /** The spec path in `.ralph/ACTIVE_SPEC`, or null. */
    activeSpec() {
      const file = path.join(stateDir, 'ACTIVE_SPEC');
      if (!fs.existsSync(file)) return null;
      const v = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/)[0]?.trim();
      return v || null;
    },
  };
}

export const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

/** Spec name as the kit keys it everywhere: the file's basename without `.md`. */
export const specName = (specPath) => path.basename(specPath).replace(/\.md$/i, '');

#!/usr/bin/env node
/**
 * Runs the kit's own suites: every `test/*.test.mjs` (not recursive, so the worked-example project
 * under test/fixtures is never collected). Listing the files here keeps `npm test` identical on
 * every OS and Node version, since glob expansion in `node --test` differs between them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.join(root, 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('test', f));
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);

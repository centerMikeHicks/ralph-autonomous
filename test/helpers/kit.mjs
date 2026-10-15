// Shared helpers for the verifier/tooling suites: temp projects, script runners, a throwaway git repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE = path.join(KIT, 'test', 'fixtures', 'example-project');

export function tmpDir(prefix = 'kit-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Write `files` ({ relPath: text }) under `dir`, creating directories. */
export function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}

/** A fresh copy of the worked-example project in a temp dir. */
export function copyFixture() {
  const dir = tmpDir('kit-example-');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Run `scripts/<script>` with RALPH_ROOT pinned to `cwd`. */
export function runScript(script, args, { cwd, env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [path.join(KIT, 'scripts', script), ...args], {
    cwd, encoding: 'utf8', input, env: { ...process.env, RALPH_ROOT: cwd, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** `git init` with a committer identity and one commit on branch `main`. */
export function initRepo(dir, files = { 'README.md': 'x\n' }) {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'kit@example.com']);
  git(dir, ['config', 'user.name', 'Kit Test']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  writeFiles(dir, files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
}

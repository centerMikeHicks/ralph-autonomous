/**
 * Tiny glob support (no dependencies): `**`, `*`, `?` and `{a,b}` over forward-slash paths,
 * plus a directory walk that honours an ignore list. Enough for `tests.globs` and `tests.layers`.
 */
import fs from 'node:fs';
import path from 'node:path';

const toPosix = (p) => String(p).split('\\').join('/');

/** Compile one glob to a RegExp over a repo-relative, forward-slash path. */
export function globToRegExp(glob) {
  const g = toPosix(glob);
  let re = '';
  let braceDepth = 0;
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches anything.
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { braceDepth += 1; re += '(?:'; }
    else if (c === '}' && braceDepth > 0) { braceDepth -= 1; re += ')'; }
    else if (c === ',' && braceDepth > 0) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function compileGlobs(globs) {
  const res = (globs ?? []).map(globToRegExp);
  return (p) => res.some((r) => r.test(toPosix(p)));
}

/** Every file under `root` (repo-relative, forward slashes) not matched by `ignore`; `.git` is always skipped. */
export function walkFiles(root, ignore = []) {
  const isIgnored = compileGlobs(ignore);
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        // An ignore glob such as `**/node_modules/**` is tested against a probe file inside the directory.
        if (isIgnored(`${rel}/x`)) continue;
        walk(full);
      } else if (!isIgnored(rel)) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

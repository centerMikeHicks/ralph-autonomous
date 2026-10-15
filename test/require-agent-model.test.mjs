import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hooks', 'require-agent-model.cjs');
const { decide, frontmatterModel } = require(HOOK);

/** A throwaway project dir with the given agent files (name -> markdown). */
function project(agents = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ram-'));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  for (const [name, text] of Object.entries(agents)) {
    writeFileSync(join(dir, '.claude', 'agents', `${name}.md`), text);
  }
  return dir;
}

const call = (input) => ({ tool_name: 'Agent', tool_input: input });

test('allows a call that names a model', () => {
  const dir = project();
  try {
    assert.equal(decide(call({ subagent_type: 'Explore', model: 'haiku' }), dir).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blocks a call with no model and an unpinned type', () => {
  const dir = project();
  try {
    const v = decide(call({ subagent_type: 'general-purpose' }), dir);
    assert.equal(v.allow, false);
    assert.match(v.message, /explicit `model`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blocks a blank model string', () => {
  const dir = project();
  try {
    assert.equal(decide(call({ subagent_type: 'Explore', model: '  ' }), dir).allow, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allows a fork without a model', () => {
  const dir = project();
  try {
    assert.equal(decide(call({ subagent_type: 'fork' }), dir).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allows a project agent that pins a model', () => {
  const dir = project({ 'code-review': '---\nname: code-review\nmodel: opus\n---\nbody\n' });
  try {
    assert.equal(decide(call({ subagent_type: 'code-review' }), dir).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blocks a project agent whose model is inherit or absent', () => {
  const dir = project({
    inheriting: '---\nname: inheriting\nmodel: inherit\n---\n',
    unpinned: '---\nname: unpinned\n---\n',
    nofm: 'no front matter here\n',
  });
  try {
    for (const t of ['inheriting', 'unpinned', 'nofm']) {
      assert.equal(decide(call({ subagent_type: t }), dir).allow, false, t);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reads CRLF and BOM front matter, strips quotes', () => {
  assert.equal(frontmatterModel('﻿---\r\nname: x\r\nmodel: "sonnet"\r\n---\r\n'), 'sonnet');
  assert.equal(frontmatterModel('---\nname: x\n---\n'), null);
});

test('rejects path-traversal agent names', () => {
  const dir = project({ x: '---\nmodel: opus\n---\n' });
  try {
    assert.equal(decide(call({ subagent_type: '../agents/x' }), dir).allow, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runHook(stdin, dir) {
  return spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    shell: false,
  });
}

test('process: exit 2 with a message on block, exit 0 on allow', () => {
  const dir = project();
  try {
    const blocked = runHook(JSON.stringify(call({ subagent_type: 'Plan' })), dir);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /Agent call blocked/);
    const allowed = runHook(JSON.stringify(call({ subagent_type: 'Plan', model: 'sonnet' })), dir);
    assert.equal(allowed.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('process: unparseable stdin never blocks', () => {
  const dir = project();
  try {
    assert.equal(runHook('not json', dir).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

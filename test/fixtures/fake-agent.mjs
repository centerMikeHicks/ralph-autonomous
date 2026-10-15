#!/usr/bin/env node
// A scripted stand-in for the agent CLI, used by the loop's tests via RALPH_AGENT_CMD.
//
//   RALPH_AGENT_CMD="node /abs/path/test/fixtures/fake-agent.mjs"
//   FAKE_AGENT_SCENARIO=<path to JSON file | inline JSON>
//   FAKE_AGENT_LOG=<file>         optional: one JSON line per invocation {n, args, prompt_bytes}
//   FAKE_AGENT_PROMPT_DIR=<dir>   optional: writes prompt-<n>.txt for each invocation
//
// Scenario: { "iterations": [ step, ... ], "repeat": false }  (default step when exhausted:
// the last step if "repeat", otherwise { outcome: "progressed" }). A step may set:
//   outcome   committed | progressed | blocked | failed | waiting | aborted   (default progressed)
//   writes    [{ path, content }]       files to create/overwrite (relative to cwd)
//   commit    true | "message"          git add the written files and commit them
//   tickTask  true                      tick the first unchecked task in .ralph/IMPLEMENTATION_PLAN.md
//   tickAll   true                      tick every unchecked box in the plan (finishes the run)
//   noStatus  true                      do not write ITERATION_STATUS.json
//   status    { ... }                   extra/override fields for ITERATION_STATUS.json
//   rateLimit { resetsAt?: epoch seconds | epoch ms | "+<seconds>", text?: string }
//   exitCode  number                    process exit code (default 0)
//   sleepMs   number                    delay before finishing
// The invocation counter lives in <cwd>/.ralph/.fake-agent-count.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function loadScenario() {
  const raw = process.env.FAKE_AGENT_SCENARIO;
  if (!raw) return { iterations: [] };
  const text = raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8').replace(/^﻿/, '');
  return JSON.parse(text);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const git = (...args) => spawnSync('git', ['-c', 'user.name=fake', '-c', 'user.email=fake@example.invalid', ...args], { encoding: 'utf8' });

const prompt = readStdin();
const cwd = process.cwd();
const stateDir = path.join(cwd, '.ralph');
fs.mkdirSync(stateDir, { recursive: true });
const counterFile = path.join(stateDir, '.fake-agent-count');
const n = (Number(fs.existsSync(counterFile) ? fs.readFileSync(counterFile, 'utf8') : 0) || 0) + 1;
fs.writeFileSync(counterFile, String(n));

if (process.env.FAKE_AGENT_LOG) {
  fs.appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ n, args: process.argv.slice(2), prompt_bytes: prompt.length })}\n`);
}
if (process.env.FAKE_AGENT_PROMPT_DIR) {
  fs.mkdirSync(process.env.FAKE_AGENT_PROMPT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.FAKE_AGENT_PROMPT_DIR, `prompt-${n}.txt`), prompt);
}

const scenario = loadScenario();
const list = scenario.iterations || [];
const step = list[n - 1] || (scenario.repeat && list.length ? list[list.length - 1] : { outcome: 'progressed' });

const t0 = Date.now();
emit({ type: 'system', subtype: 'init', session_id: `fake-${n}`, model: 'fake' });
emit({ type: 'assistant', message: { content: [{ type: 'text', text: `fake iteration ${n}` }, { type: 'tool_use', id: `t${n}a`, name: 'Bash', input: { command: 'node --test test/' } }] } });
emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${n}a`, content: 'ok' }] } });

if (step.rateLimit) {
  let resets = step.rateLimit.resetsAt;
  if (typeof resets === 'string' && resets.startsWith('+')) resets = Math.floor(Date.now() / 1000) + Number(resets.slice(1));
  const info = { status: 'rejected', ...(resets !== undefined ? { resetsAt: resets } : {}) };
  emit({ type: 'rate_limit_event', rate_limit_info: info });
  emit({ type: 'result', subtype: 'success', is_error: true, result: step.rateLimit.text || "You've hit your session limit", duration_ms: 50, duration_api_ms: 10, num_turns: 1 });
  process.exit(step.exitCode ?? 1);
}

for (const w of step.writes || []) {
  const target = path.join(cwd, w.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, w.content ?? `iteration ${n}\n`);
}

const planFile = path.join(stateDir, 'IMPLEMENTATION_PLAN.md');
if ((step.tickTask || step.tickAll) && fs.existsSync(planFile)) {
  let plan = fs.readFileSync(planFile, 'utf8');
  if (step.tickAll) plan = plan.replace(/\[ \]/g, '[x]').replace(/\s*(←|<-)\s*NEXT/g, '');
  else plan = plan.replace(/^(\s+- )\[ \]/m, '$1[x]');
  fs.writeFileSync(planFile, plan);
}

let sha = '';
if (step.commit) {
  const files = (step.writes || []).map((w) => w.path);
  git('-C', cwd, 'add', '--', ...(files.length ? files : ['.']));
  const r = git('-C', cwd, 'commit', '-m', typeof step.commit === 'string' ? step.commit : `fake iteration ${n}`);
  if (r.status === 0) sha = git('-C', cwd, 'rev-parse', '--short', 'HEAD').stdout.trim();
}

if (!step.noStatus) {
  const outcome = step.outcome || (step.commit ? 'committed' : 'progressed');
  fs.writeFileSync(
    path.join(stateDir, 'ITERATION_STATUS.json'),
    JSON.stringify({
      spec: 'demo', phase: 'Phase 1', mode: 'build', outcome,
      did: `fake work ${n}`, result: `fake result ${n}`, next: outcome === 'blocked' ? 'a person must decide' : 'continue',
      committed: Boolean(sha), sha, ...(step.status || {}),
    }),
  );
}

const finish = () => {
  const elapsed = Date.now() - t0;
  emit({
    type: 'result', subtype: 'success', is_error: false, result: 'done',
    duration_ms: Math.max(elapsed, 1000), duration_api_ms: 400, num_turns: 2, total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 },
  });
  process.exit(step.exitCode ?? 0);
};
if (step.sleepMs) setTimeout(finish, step.sleepMs);
else finish();

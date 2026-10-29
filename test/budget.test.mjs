// Spend caps and the kill switch (ralph/lib/budget.mjs): the pure parts, the CLI flag, and the whole loop with the
// fake agent, which reports $0.0123 an iteration and, here, never finishes its plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { anyCap, budgetDecision, budgetSettings, killSwitchPath, spentOn, today } from '../ralph/lib/budget.mjs';
import { buildAgentArgs, resolveAgent } from '../ralph/lib/agent.mjs';
import { readJsonl } from '../ralph/lib/telemetry.mjs';
import { validateConfig, DEFAULTS, deepMerge } from '../scripts/lib/config.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(KIT, 'test', 'fixtures', 'fake-agent.mjs');

test('settings: the config, the environment over it, and nothing set by default', () => {
  assert.deepEqual(budgetSettings({}, {}), { iterationUsd: null, runUsd: null, dayUsd: null });
  assert.equal(anyCap(budgetSettings({}, {})), false);
  const s = budgetSettings({ budget: { iterationUsd: 2, runUsd: 20, dayUsd: null } }, { RALPH_BUDGET_DAY_USD: '50', RALPH_BUDGET_RUN_USD: '' });
  assert.deepEqual(s, { iterationUsd: 2, runUsd: null, dayUsd: 50 });
  assert.equal(budgetSettings({ budget: { runUsd: -1 } }, {}).runUsd, null);
});

test('config: budget is a section of null or positive amounts', () => {
  assert.doesNotThrow(() => validateConfig(deepMerge(DEFAULTS, { budget: { runUsd: 10 } })));
  assert.throws(() => validateConfig(deepMerge(DEFAULTS, { budget: { runUsd: 0 } })), /budget.runUsd/);
  assert.throws(() => validateConfig(deepMerge(DEFAULTS, { budget: { dayUsd: '5' } })), /budget.dayUsd/);
});

test('spend: a day is summed from its rows, and a cap stops at or over it', () => {
  const rows = [{ ts: '2026-10-29T10:00:00Z', cost_usd: 1.25 }, { ts: '2026-10-29T23:59:00Z', cost_usd: 0.75 }, { ts: '2026-10-28T12:00:00Z', cost_usd: 9 }, { ts: 'x' }];
  assert.equal(spentOn(rows, '2026-10-29'), 2);
  assert.equal(today(Date.parse('2026-10-29T05:00:00Z')), '2026-10-29');
  const settings = { iterationUsd: null, runUsd: 1, dayUsd: 5 };
  assert.equal(budgetDecision({ settings, runSpent: 0.99, daySpent: 4 }).stop, null);
  assert.equal(budgetDecision({ settings, runSpent: 1, daySpent: 4 }).stop, 'budget_run');
  assert.equal(budgetDecision({ settings, runSpent: 0, daySpent: 5.1 }).stop, 'budget_day');
  assert.equal(killSwitchPath('/s', {}), path.join('/s', 'STOP'));
  assert.equal(killSwitchPath('/s', { RALPH_KILL_SWITCH: '/k' }), '/k');
});

test('the claude CLI gets --max-budget-usd only when a per-iteration budget is set', () => {
  const cfg = { agent: { command: 'claude', args: ['-p'], modelFlag: '--model' } };
  const agent = resolveAgent(cfg, {});
  const withCap = buildAgentArgs({ agent, cfg, model: 'm', root: os.tmpdir(), budgetUsd: 2.5 });
  assert.equal(withCap[withCap.indexOf('--max-budget-usd') + 1], '2.5');
  assert.equal(buildAgentArgs({ agent, cfg, model: 'm', root: os.tmpdir() }).includes('--max-budget-usd'), false);
});

function git(dir, ...args) {
  return spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
}

/** A project whose plan outlasts any test here: twenty tasks, one ticked per iteration, so each iteration is progress. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-budget-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.cpSync(path.join(KIT, 'ralph'), path.join(dir, 'ralph'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'));
  fs.writeFileSync(path.join(dir, 'specs', 'demo.md'), '# Demo spec\n');
  fs.mkdirSync(path.join(dir, '.ralph'));
  fs.writeFileSync(path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md'), `# Implementation Plan\n## Status: planned\n## Phases\n- [ ] **Phase 1: Long** <- NEXT\n${Array.from({ length: 20 }, (_, i) => `  - [ ] task ${i + 1}\n`).join('')}- [ ] **Exit Gate**\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.ralph/\n.claude-temp/\n');
  fs.writeFileSync(path.join(dir, 'ralph.config.json'), JSON.stringify({ project: { name: 'budget' } }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

function run(dir, env) {
  const scenario = { iterations: [{ tickTask: true }], repeat: true };
  const r = spawnSync(process.execPath, [path.join(dir, 'ralph', 'lib', 'run-loop.mjs'), 'build', '20', 'specs/demo.md'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, RALPH_AGENT_CMD: `node "${FAKE}"`, FAKE_AGENT_SCENARIO: JSON.stringify(scenario), RALPH_PAUSE_S: '0', RALPH_MODEL: '', ...env },
  });
  return { r, out: r.stdout + r.stderr, rows: readJsonl(path.join(dir, '.ralph', 'iterations.jsonl')), events: readJsonl(path.join(dir, '.ralph', 'loop-events.jsonl')) };
}

const stopOf = (events) => events.filter((e) => e.event === 'loop_stop').pop()?.reason;

test('a run that never finishes stops at its cap, and says so', () => {
  const dir = project();
  try {
    const { out, rows, events } = run(dir, { RALPH_BUDGET_RUN_USD: '0.03' });
    assert.equal(rows.length, 3, out);
    assert.equal(stopOf(events), 'budget_run');
    assert.match(out, /SPEND CAP - This run has spent \$0\.04, at or over its cap of \$0\.03/);
    assert.deepEqual(events.filter((e) => e.event === 'spend').map((e) => e.run_usd), [0.0123, 0.0246, 0.0369]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with no cap, the run warns at the start and reports its spend after every iteration', () => {
  const dir = project();
  try {
    const { out, rows } = run(dir, { RALPH_BUDGET_RUN_USD: '', RALPH_BUDGET_DAY_USD: '', RALPH_BUDGET_ITERATION_USD: ''  });
    assert.ok(rows.length >= 1, out);
    assert.match(out, /No spend cap is set .* watch this run/);
    assert.match(out, /spend: {2}\$0\.0123 this iteration, \$0\.01 this run, .* today \(no cap set: watch this run\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("today's spend across runs stops a run before it starts", () => {
  const dir = project();
  try {
    fs.writeFileSync(path.join(dir, '.ralph', 'iterations.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), cost_usd: 1 })}\n`);
    const { out, rows, events } = run(dir, { RALPH_BUDGET_DAY_USD: '0.5' });
    assert.equal(rows.length, 1, 'only the seeded row');
    assert.equal(stopOf(events), 'budget_day');
    assert.match(out, /Today has spent \$1\.00, at or over the daily cap of \$0\.50/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the kill switch stops every start while it is there', () => {
  const dir = project();
  try {
    fs.writeFileSync(path.join(dir, '.ralph', 'STOP'), '');
    const { out, rows, events } = run(dir, {});
    assert.equal(rows.length, 0);
    assert.equal(stopOf(events), 'kill_switch');
    assert.match(out, /KILL SWITCH/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

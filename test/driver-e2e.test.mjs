// End-to-end: a real temp git repo, the kit's ralph/ and scripts/ copied in, the whole loop run
// through ralph/lib/run-loop.mjs with the fake agent standing in for the agent CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJsonl } from '../ralph/lib/telemetry.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(KIT, 'test', 'fixtures', 'fake-agent.mjs');

const PLAN = `# Implementation Plan
## Status: planned
## Active Spec
\`specs/demo.md\`
## Phases
- [ ] **Phase 1: Demo** <- NEXT
  - [ ] task one [haiku]
  - [ ] task two
- [ ] **Exit Gate**
`;

function git(dir, ...args) {
  return spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
}

/** A fresh project: git repo, spec, plan, config, the kit's ralph/ and scripts/ copied in. */
function makeProject({ remote = false, plan = PLAN } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-e2e-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.cpSync(path.join(KIT, 'ralph'), path.join(dir, 'ralph'), { recursive: true });
  if (fs.existsSync(path.join(KIT, 'scripts'))) {
    fs.cpSync(path.join(KIT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
    // Only the loop's own helpers are under test; drop the process owner so a concurrent
    // build of the kit cannot make these runs wait on a sweep.
    fs.rmSync(path.join(dir, 'scripts', 'sweep.mjs'), { force: true });
    fs.rmSync(path.join(dir, 'scripts', 'verify-plan-ticks.mjs'), { force: true });
  }
  for (const mode of ['plan', 'build', 'review']) {
    const f = path.join(dir, 'ralph', `PROMPT_${mode}.md`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, `# ${mode} prompt (test stub)\n`);
  }
  fs.mkdirSync(path.join(dir, 'specs'));
  fs.writeFileSync(path.join(dir, 'specs', 'demo.md'), '# Demo spec\n');
  fs.mkdirSync(path.join(dir, '.ralph'));
  fs.writeFileSync(path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md'), plan);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.ralph/\n.claude-temp/\n');
  fs.writeFileSync(path.join(dir, 'ralph.config.json'), JSON.stringify({ project: { name: 'e2e' } }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  let bare = '';
  if (remote) {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-e2e-remote-'));
    git(bare, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', bare);
  }
  // Fake-agent logs live outside the repository so they never look like work in the tree.
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-e2e-aux-'));
  return { dir, bare, aux, cleanup: () => { for (const d of [dir, aux, bare]) if (d) fs.rmSync(d, { recursive: true, force: true }); } };
}

function runLoop(project, args, scenario, extraEnv = {}) {
  const agentLog = path.join(project.aux, 'agent-calls.jsonl');
  const r = spawnSync(process.execPath, [path.join(project.dir, 'ralph', 'lib', 'run-loop.mjs'), ...args], {
    cwd: project.dir,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      RALPH_AGENT_CMD: `node "${FAKE}"`,
      FAKE_AGENT_SCENARIO: JSON.stringify(scenario),
      FAKE_AGENT_LOG: agentLog,
      FAKE_AGENT_PROMPT_DIR: path.join(project.aux, 'prompts'),
      RALPH_PAUSE_S: '0',
      RALPH_MODEL: '',
      ...extraEnv,
    },
  });
  const state = path.join(project.dir, '.ralph');
  return {
    r,
    rows: readJsonl(path.join(state, 'iterations.jsonl')),
    events: readJsonl(path.join(state, 'loop-events.jsonl')),
    calls: readJsonl(agentLog),
  };
}

const commitStep = (n) => ({ writes: [{ path: `src/f${n}.txt`, content: `v${n}\n` }], commit: `work ${n}`, tickTask: true });

test('build: rows, events, model selection, prompt content, push, and eject on blocked', () => {
  const p = makeProject({ remote: true });
  try {
    const { r, rows, events, calls } = runLoop(p, ['build', '10', 'specs/demo.md'], {
      iterations: [commitStep(1), commitStep(2), { outcome: 'blocked' }],
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);

    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((x) => x.outcome), ['committed', 'committed', 'blocked']);
    assert.deepEqual(rows.map((x) => x.committed), [true, true, false]);
    assert.ok(rows[0].head_before && rows[0].head_after && rows[0].head_before !== rows[0].head_after);
    assert.equal(rows[2].head_before, rows[2].head_after);
    for (const row of rows) {
      assert.equal(row.spec, 'demo');
      assert.equal(row.mode, 'build');
      assert.equal(row.branch, 'main');
      assert.equal(row.status_fresh, true);
      assert.ok(row.dur_s >= 0 && row.api_s === 0.4 && row.tool_s >= 0 && row.overhead_s >= 0 && row.gap_s >= 0);
    }
    assert.ok(fs.existsSync(path.join(p.dir, rows[0].transcript)), 'stamped transcript kept');
    assert.match(rows[0].transcript, /\.ralph\/logs\/demo\/\d{8}-\d{6}-iter001\.jsonl$/);

    // Model selection reached the agent command line: [haiku]-tagged task, then routine, then routine.
    const modelOf = (c) => c.args[c.args.indexOf('--model') + 1];
    assert.equal(modelOf(calls[0]), 'haiku');
    assert.equal(rows[0].model, 'haiku (low)');
    assert.equal(modelOf(calls[1]), 'sonnet');
    assert.equal(calls[1].args[calls[1].args.indexOf('--effort') + 1], 'medium');

    const names = events.map((e) => e.event);
    assert.equal(names[0], 'loop_start');
    assert.equal(names.filter((n) => n === 'iteration_start').length, 3);
    assert.equal(names.filter((n) => n === 'iteration_end').length, 3);
    assert.equal(names.filter((n) => n === 'push').length, 2);
    assert.ok(events.filter((e) => e.event === 'push').every((e) => e.ok === true));
    const stop = events[events.length - 1];
    assert.equal(stop.event, 'loop_stop');
    assert.equal(stop.reason, 'blocked');
    assert.equal(stop.iterations, 3);
    assert.equal(new Set(events.map((e) => e.run)).size, 1);

    // The remote received the commits; no force push involved.
    assert.match(git(p.bare, 'log', '--oneline', 'main').stdout, /work 2/);

    // Prompt assembly: spec block first, mode prompt last, previous hand-off present from iteration 2.
    const prompt2 = fs.readFileSync(path.join(p.aux, 'prompts', 'prompt-2.txt'), 'utf8');
    assert.match(prompt2, /specs\/demo\.md/);
    assert.match(prompt2, /The plan, cut to this iteration/);
    assert.match(prompt2, /previous iteration's hand-off/);
    assert.match(prompt2, /Where the last iteration worked/);
    assert.match(prompt2, /src\/f1\.txt:1/);
    assert.doesNotMatch(prompt2, /Tracker Ticket/);

    // Bookkeeping files: BOM-free, heartbeat gone, USAGE_LOG has a row per iteration.
    const state = path.join(p.dir, '.ralph');
    assert.equal(fs.existsSync(path.join(state, '.loop-heartbeat')), false);
    for (const f of ['iterations.jsonl', 'loop-events.jsonl', 'USAGE_LOG.md']) {
      assert.notEqual(fs.readFileSync(path.join(state, f))[0], 0xef);
    }
    assert.equal(fs.readFileSync(path.join(state, 'USAGE_LOG.md'), 'utf8').split('\n').filter((l) => /^\| 20\d\d-/.test(l)).length, 3);
    assert.equal(fs.readFileSync(path.join(state, 'ACTIVE_SPEC'), 'utf8'), 'specs/demo.md');
  } finally {
    p.cleanup();
  }
});

test('build: two consecutive iterations that change nothing eject as stalled', () => {
  const p = makeProject();
  try {
    const { rows, events, r } = runLoop(p, ['build', '10', 'specs/demo.md'], { iterations: [{}, {}, {}, {}] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((x) => x.outcome), ['progressed', 'progressed']);
    assert.equal(events[events.length - 1].reason, 'stalled');
    assert.equal(events.filter((e) => e.event === 'push').length, 0, 'no commit, no push');
  } finally {
    p.cleanup();
  }
});

test('build: an iteration that only edits the plan is progress, so a no-change lap in between resets the count', () => {
  const p = makeProject();
  try {
    const { rows, events } = runLoop(p, ['build', '10', 'specs/demo.md'], {
      iterations: [{}, { tickTask: true }, {}, {}],
    });
    assert.equal(rows.length, 4);
    assert.equal(events[events.length - 1].reason, 'stalled');
  } finally {
    p.cleanup();
  }
});

test('max iterations stops the loop with reason max_iterations', () => {
  const p = makeProject();
  try {
    const { rows, events } = runLoop(p, ['build', '2', 'specs/demo.md'], { iterations: [commitStep(1), commitStep(2), commitStep(3)] });
    assert.equal(rows.length, 2);
    assert.equal(events[events.length - 1].reason, 'max_iterations');
    assert.equal(events.filter((e) => e.event === 'push').length, 0, 'no remote configured, so nothing to push');
  } finally {
    p.cleanup();
  }
});

test('build: completes when every phase is ticked', () => {
  const p = makeProject();
  try {
    const { rows, events } = runLoop(p, ['build', '10', 'specs/demo.md'], { iterations: [{ ...commitStep(1), tickAll: true }, commitStep(2)] });
    assert.equal(rows.length, 1);
    assert.equal(events[events.length - 1].reason, 'completed');
  } finally {
    p.cleanup();
  }
});

test('usage limit: waits, does not count the iteration, and resumes', () => {
  const p = makeProject();
  try {
    const { rows, events, calls } = runLoop(
      p,
      ['build', '1', 'specs/demo.md'],
      { iterations: [{ rateLimit: { resetsAt: '+1' } }, commitStep(1)] },
      { RALPH_USAGE_LIMIT_BUFFER_S: '0', RALPH_USAGE_LIMIT_MIN_WAIT_S: '0' },
    );
    assert.equal(calls.length, 2);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].iter, 1);
    const wait = events.find((e) => e.event === 'usage_limit_wait');
    assert.ok(wait, 'usage_limit_wait event');
    assert.ok(wait.wait_s >= 0 && wait.wait_s <= 3);
    assert.equal(events[events.length - 1].reason, 'max_iterations');
  } finally {
    p.cleanup();
  }
});

test('plan mode clamps to one iteration, uses the planning model and sets ACTIVE_SPEC', () => {
  const p = makeProject();
  try {
    const { rows, calls, events } = runLoop(p, ['plan', '5', 'specs/demo.md'], { iterations: [{}, {}] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mode, 'plan');
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'opus');
    assert.equal(events[events.length - 1].reason, 'max_iterations');
  } finally {
    p.cleanup();
  }
});

test('--model forces the model with no effort flag; --no-transcripts keeps none', () => {
  const p = makeProject();
  try {
    const { rows, calls } = runLoop(p, ['review', '1', 'specs/demo.md', '--model', 'custom-x', '--no-transcripts'], { iterations: [{}] });
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'custom-x');
    assert.equal(calls[0].args.includes('--effort'), false);
    assert.equal(rows[0].transcript, '');
    assert.equal(fs.existsSync(path.join(p.dir, '.ralph', 'logs')), false);
  } finally {
    p.cleanup();
  }
});

test('tracker: provider jira injects the tracker block; --skip-tracker omits it', () => {
  const p = makeProject();
  try {
    fs.writeFileSync(path.join(p.dir, 'ralph.config.json'), JSON.stringify({ tracker: { provider: 'jira', jira: { project: 'PROJ' } } }));
    fs.writeFileSync(path.join(p.dir, 'ralph', 'TRACKER_jira.md'), 'TRACKER RULES HERE\n');
    // Not claude, so the connectivity probe is skipped with a warning and the block is injected.
    const withTracker = runLoop(p, ['build', '1', 'specs/demo.md', '--issue', 'PROJ-9'], { iterations: [{}] });
    const prompt = fs.readFileSync(path.join(p.aux, 'prompts', 'prompt-1.txt'), 'utf8');
    assert.match(prompt, /PROJ-9/);
    assert.match(prompt, /TRACKER RULES HERE/);
    assert.match(fs.readFileSync(path.join(p.dir, 'specs', 'demo.md'), 'utf8'), /tracker_issue: PROJ-9/);
    assert.equal(withTracker.rows.length, 1);

    fs.rmSync(path.join(p.aux, 'prompts'), { recursive: true });
    fs.rmSync(path.join(p.dir, '.ralph', '.fake-agent-count'));
    const skipped = runLoop(p, ['build', '1', 'specs/demo.md', '--skip-tracker'], { iterations: [{}] });
    assert.match(skipped.r.stdout, /--skip-tracker set/);
    assert.doesNotMatch(fs.readFileSync(path.join(p.aux, 'prompts', 'prompt-1.txt'), 'utf8'), /TRACKER RULES HERE/);

    // Missing binding without --issue refuses to start.
    fs.writeFileSync(path.join(p.dir, 'specs', 'demo.md'), '# Demo\n');
    const refused = runLoop(p, ['build', '1', 'specs/demo.md'], { iterations: [{}] });
    assert.equal(refused.r.status, 1);
    assert.match(refused.r.stderr, /no tracker_issue/);
  } finally {
    p.cleanup();
  }
});

test('errors: unknown spec and missing spec in plan mode exit 1 without events', () => {
  const p = makeProject();
  try {
    const missing = runLoop(p, ['build', '1', 'specs/nope.md'], { iterations: [] });
    assert.equal(missing.r.status, 1);
    assert.match(missing.r.stderr, /spec file not found/);
    fs.rmSync(path.join(p.dir, '.ralph', 'ACTIVE_SPEC'), { force: true });
    const noSpec = runLoop(p, ['plan', '1'], { iterations: [] });
    assert.equal(noSpec.r.status, 1);
    assert.equal(noSpec.events.length, 0);
  } finally {
    p.cleanup();
  }
});

test('status prints the active spec, plan head and last iteration', () => {
  const p = makeProject();
  try {
    runLoop(p, ['build', '1', 'specs/demo.md'], { iterations: [commitStep(1)] });
    const r = spawnSync(process.execPath, [path.join(p.dir, 'ralph', 'lib', 'driver.mjs'), 'status'], { cwd: p.dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Active Spec: specs\/demo\.md/);
    assert.match(r.stdout, /Last iter:\s+#1 build committed/);
    assert.match(r.stdout, /Loop:\s+not running/);
  } finally {
    p.cleanup();
  }
});

test('the PowerShell launcher forwards flags to the same entry point (Windows only)', { skip: process.platform !== 'win32' }, () => {
  const p = makeProject();
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(p.dir, 'ralph', 'loop.ps1'),
      'build', '1', 'specs/demo.md', '-Model', 'ps-model', '-NoTranscripts'], {
      cwd: p.dir, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, RALPH_AGENT_CMD: `node "${FAKE}"`, FAKE_AGENT_SCENARIO: '{"iterations":[{}]}', FAKE_AGENT_LOG: path.join(p.aux, 'calls.jsonl'), RALPH_PAUSE_S: '0' },
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const rows = readJsonl(path.join(p.dir, '.ralph', 'iterations.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, 'ps-model');
    assert.equal(rows[0].transcript, '');
  } finally {
    p.cleanup();
  }
});

test('the POSIX launcher forwards arguments (skipped when bash is unavailable)', { skip: spawnSync('bash', ['-c', 'exit 0']).status !== 0 }, () => {
  const p = makeProject();
  try {
    const r = spawnSync('bash', [path.join(p.dir, 'ralph', 'loop.sh'), 'status'], { cwd: p.dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Ralph Loop Status/);
  } finally {
    p.cleanup();
  }
});

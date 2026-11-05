// The Kairos tracker: the pure parts, the client's retries, and the whole loop against a stand-in Kairos over real HTTP,
// with the fake agent standing in for the agent CLI. The loop is spawned without blocking, so the server here can answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { answersBlock, capsWithKairos, createKairos, fileOutbox, isWorkFile, kairosProblem, kairosSettings, planForKairos, planIsWritten, productQuestions, scopeFromCommits, stopReasonFor, withTicks } from '../ralph/lib/kairos.mjs';
import { buildAgentEnv } from '../ralph/lib/agent.mjs';
import { resolveTracker } from '../ralph/lib/spec-tracker.mjs';
import { readJsonl } from '../ralph/lib/telemetry.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(KIT, 'test', 'fixtures', 'fake-agent.mjs');
const KEY = 'kr_test';
const none = { iterationUsd: null, runUsd: null, dayUsd: null };

test('settings come from the environment first, and say what is missing', () => {
  assert.deepEqual(kairosSettings({ tracker: { kairos: { url: 'https://k.example/' } } }, {}), { url: 'https://k.example', token: '' });
  assert.equal(kairosSettings({ tracker: { kairos: { url: 'https://a' } } }, { KAIROS_URL: 'https://b' }).url, 'https://b');
  assert.match(kairosProblem({ url: '', token: 'x' }), /KAIROS_URL/);
  assert.match(kairosProblem({ url: 'nope', token: 'x' }), /not an address/);
  assert.match(kairosProblem({ url: 'https://k', token: '' }), /Build tab/);
  assert.equal(kairosProblem({ url: 'https://k', token: 'x' }), null);
});

test('Kairos can only lower the caps, and an iteration spends no more than the item has left', () => {
  const ours = { iterationUsd: 2, runUsd: 10, dayUsd: 25 };
  assert.deepEqual(capsWithKairos(ours, null), ours);
  assert.deepEqual(capsWithKairos(ours, { iterationUsd: 5, runUsd: 50, remainingUsd: 100 }), ours);
  assert.deepEqual(capsWithKairos(ours, { iterationUsd: 1, runUsd: 3, remainingUsd: 100 }), { iterationUsd: 1, runUsd: 3, dayUsd: 25 });
  assert.equal(capsWithKairos(ours, { iterationUsd: null, runUsd: null, remainingUsd: 0.5 }).iterationUsd, 0.5);
  assert.deepEqual(capsWithKairos(none, { iterationUsd: null, runUsd: 4, remainingUsd: null }), { iterationUsd: null, runUsd: 4, dayUsd: null });
});

test('the words for stopping, questions and answers', () => {
  assert.equal(stopReasonFor('over-cap'), 'budget_item');
  assert.equal(stopReasonFor('paused'), 'kairos_stop');
  assert.deepEqual(productQuestions('## Phases\n- [ ] **P**\n## Open Questions / Blocked\n- [ ] `[product]` Which?\n- [x] `[product]` Done\n- [ ] `[tooling]` Mine\n- [ ] Untagged\n## Next\n- [ ] no'), ['- `[product]` Which?', '- Untagged']);
  assert.equal(answersBlock([]), '');
  assert.equal(answersBlock([{ question: 'Which?', choice: 'A', note: 'Because' }]), '- **Which?** A (Because)');
});

test('the agent never gets the key', () => {
  assert.equal(buildAgentEnv({ isClaude: true }, { KAIROS_RUN_TOKEN: 'secret', OTHER: 'x' }).KAIROS_RUN_TOKEN, undefined);
  assert.equal(buildAgentEnv({ isClaude: false }, { KAIROS_RUN_TOKEN: 'secret', OTHER: 'x' }).OTHER, 'x');
});

test('a spec binds to its item as it does on Jira', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-bind-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '---\ntracker_issue: CEN-60\n---\n# A\n');
  const cfg = { tracker: { provider: 'kairos' } };
  assert.deepEqual(resolveTracker({ cfg, root: dir, spec: 'a.md' }), { enabled: true, issue: 'CEN-60', project: '' });
  assert.equal(resolveTracker({ cfg, root: dir, spec: 'a.md', skip: true }).enabled, false);
  fs.writeFileSync(path.join(dir, 'b.md'), '# B\n');
  assert.match(resolveTracker({ cfg, root: dir, spec: 'b.md' }).error, /tracker_issue/);
  fs.rmSync(dir, { recursive: true, force: true });
});

const answer = (status, body, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body });

test('the client retries what is worth retrying, waits as asked, and gives up on the rest', async () => {
  const waits = [];
  let calls = 0;
  const flaky = createKairos({ url: 'https://k', token: 't', item: 'CEN-1', wait: async (ms) => waits.push(ms), fetchImpl: async () => (++calls < 3 ? answer(503, { message: 'waking' }, { 'retry-after': '30' }) : answer(200, { go: true })) });
  assert.deepEqual(await flaky.controls('build'), { ok: true, status: 200, data: { go: true } });
  assert.deepEqual(waits, [30000, 30000]);

  calls = 0;
  const refused = createKairos({ url: 'https://k', token: 't', item: 'CEN-1', wait: async () => {}, fetchImpl: async () => (calls++, answer(401, { message: 'This key has ended' })) });
  assert.deepEqual(await refused.controls('build'), { ok: false, status: 401, retry: false, message: 'This key has ended' });
  assert.equal(calls, 1);

  const down = createKairos({ url: 'https://k', token: 't', item: 'CEN-1', wait: async () => {}, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const r = await down.controls('build');
  assert.equal(r.ok, false);
  assert.equal(r.retry, true);
  assert.match(r.message, /ECONNREFUSED/);
});

test('a report that cannot be sent waits for the next, in order, and one refused is dropped', async () => {
  const sent = [];
  let up = false;
  const lost = [];
  const k = createKairos({ url: 'https://k', token: 't', item: 'CEN-1', wait: async () => {}, onLost: (_q, r) => lost.push(r.message), fetchImpl: async (_u, init) => {
    if (!up) throw new Error('down');
    const body = JSON.parse(init.body);
    if (body.event === 'bad') return answer(400, { message: 'Not an event' });
    sent.push(body.event);
    return answer(200, { controls: { go: true } });
  } });
  assert.ok((await k.report({ event: 'one' })).failed);
  assert.equal(k.pending(), 1);
  up = true;
  await k.report({ event: 'bad' });
  const { failed, sent: last } = await k.report({ event: 'two' });
  assert.equal(failed, null);
  assert.deepEqual(last, { controls: { go: true } });
  assert.deepEqual(sent, ['one', 'two']);
  assert.deepEqual(lost, ['Not an event']);
  assert.equal(k.pending(), 0);
});

test('reports that cannot be sent outlive the run, one file per item, and go in order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-outbox-'));
  const down = createKairos({ url: 'https://k', token: 't', item: 'CEN-1', wait: async () => {}, outbox: fileOutbox(dir, 'CEN-1'), fetchImpl: async () => { throw new Error('down'); } });
  await down.report({ event: 'one' });
  await down.report({ event: 'two' });
  assert.deepEqual(fileOutbox(dir, 'CEN-2').load(), [], 'another item never sends them');
  const sent = [];
  const up = createKairos({ url: 'https://k', token: 't', item: 'CEN-1', wait: async () => {}, outbox: fileOutbox(dir, 'CEN-1'), fetchImpl: async (_u, init) => {
    sent.push(JSON.parse(init.body).event);
    return answer(200, {});
  } });
  assert.equal(up.pending(), 2);
  await up.flush();
  assert.deepEqual(sent, ['one', 'two']);
  assert.equal(up.pending(), 0);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing is left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

const WRITTEN = `# Implementation Plan
## Status: Ready for Build - Demo
## Gap analysis
1. **The helper is elsewhere.** Build must use it.
- [ ] not a phase: it is not under Phases
## Phases
- [x] **Phase 1: The record** (abc1234)
- [ ] **Phase 2: The screen** <- NEXT
  gate: \`npm test\`
  - [x] Add the list [sonnet] (def5678)
    Files: a.ts
    Tests: the list shows, when empty
  - [ ] Add the filter [haiku]
    Files: b.ts
  - [ ] \`[unit]\` filterWorks - Given a list, When filtered, Then fewer
- [ ] **Exit Gate**
## Decisions
- D1 - Keep the names, by the spec
## Open Questions / Blocked
- [ ] \`[product]\` Which filter first?
- [ ] \`[tooling]\` Mine
`;

test('the plan goes to Kairos as phases, tasks, tests, decisions and questions', () => {
  const { phases, decisions, questions } = planForKairos(WRITTEN);
  assert.deepEqual(phases.map((p) => [p.id, p.title, p.done, p.commit]), [['phase-1', 'Phase 1: The record', true, 'abc1234'], ['phase-2', 'Phase 2: The screen', false, null], ['exit-gate', 'Exit Gate', false, null]]);
  assert.deepEqual(phases[1].tasks, [{ text: 'Add the list', done: true, commit: 'def5678' }, { text: 'Add the filter', done: false, commit: null }]);
  assert.deepEqual(phases[1].tests, ['the list shows, when empty', '`[unit]` filterWorks - Given a list, When filtered, Then fewer']);
  assert.deepEqual(decisions, ['D1 - Keep the names, by the spec']);
  assert.deepEqual(questions, ['`[product]` Which filter first?']);
  assert.equal(planIsWritten(WRITTEN), true);
  assert.equal(planIsWritten('## Phases\n\n_The planning iteration writes this section._\n'), false);
  assert.equal(planIsWritten(''), false);
});

test('the plan sent to Kairos stays within what it holds: no empty phase or task, and no more phases or tasks than it takes', () => {
  const many = (n, line) => Array.from({ length: n }, (_, i) => line(i + 1)).join('\n');
  const plan = `## Phases
- [ ] **Phase 1: The record**
  - [ ] [sonnet]
${many(120, (i) => `  - [ ] Task ${i}`)}
- [ ] <- NEXT
  - [ ] Under a phase with no words
${many(210, (i) => `- [ ] **Phase ${i + 1}: More**`)}
`;
  const { phases } = planForKairos(plan);
  assert.equal(phases.length, 200, 'no more phases than Kairos takes');
  assert.equal(phases[0].tasks.length, 100, 'no more tasks in a phase than Kairos takes');
  assert.equal(phases[0].tasks[0].text, 'Task 1', 'a task with no words is left out');
  assert.ok(phases.every((p) => p.title && p.tasks.every((t) => t.text)), 'every phase and task has words');
  assert.ok(!phases.some((p) => p.tasks.some((t) => t.text === 'Under a phase with no words')), 'nor are the tasks under a phase with none');
});

test('what a build found outside its spec goes to Kairos as rows, and a deferred finding is not a question', () => {
  const plan = `## Phases
- [ ] **Phase 1: The screen** <- NEXT
  - [ ] Add the list
    Files: src/a.ts, \`src/b.ts\` (makeB, makeC), src/lib/
## Scope changes
- S1 included - The helper throws on empty input. Blocks: flagIsRead. Evidence: it fails with "undefined", on empty. Commits: abc1234, def5678.
- S2 filed bug - The export has no paging. Route: platform-fix. Evidence: src/audit.ts:41.
- S3 blocking request - No key for the flag service. Blocks: o1. Evidence: no such setting. Area: who can see what.
- not a row
## Open Questions / Blocked
- [ ] \`[product]\` Which filter first?
- [ ] \`[product]\` CANDIDATE-SPEC: audit export has no paging (outside, pre-existing)
`;
  const { phases, scope, questions } = planForKairos(plan);
  assert.deepEqual(phases[0].files, ['src/a.ts', 'src/b.ts', 'src/lib/']);
  assert.deepEqual(questions, ['`[product]` Which filter first?']);
  assert.deepEqual(scope[0], { id: 'S1', kind: 'included', what: 'The helper throws on empty input', blocks: 'flagIsRead', evidence: 'it fails with "undefined", on empty', commits: ['abc1234', 'def5678'] });
  assert.deepEqual(scope[1], { id: 'S2', kind: 'filed', what: 'The export has no paging', itemKind: 'bug', evidence: 'src/audit.ts:41', route: 'platform-fix' });
  assert.deepEqual(scope[2], { id: 'S3', kind: 'blocking', what: 'No key for the flag service', itemKind: 'request', blocks: 'o1', evidence: 'no such setting', riskArea: 'who can see what' });
  assert.equal(scope[3].kind, 'filed');
  assert.match(scope[3].id, /^C-[0-9a-f]{8}$/);
  assert.equal(scope[3].what, 'audit export has no paging (outside, pre-existing)');
  assert.equal(planForKairos(plan).scope[3].id, scope[3].id, 'the same finding keeps its id');
});

test('commits say which scope change they belong to, and one marked but unnamed is reported anyway', () => {
  const { named, unnamed } = scopeFromCommits([
    { sha: 'a'.repeat(40), message: 'KAI-1 fix the helper\n\n[REVIEW: SCOPE] S1 blocks flagIsRead' },
    { sha: 'b'.repeat(40), message: 'KAI-1 more of S1' },
    { sha: 'c'.repeat(40), message: 'KAI-1 widen the query [REVIEW: SCOPE]\n\nIt could not wait' },
    { sha: 'd'.repeat(40), message: 'KAI-1 nothing to see' },
  ]);
  assert.deepEqual(named.get('S1'), ['a'.repeat(40), 'b'.repeat(40)]);
  assert.deepEqual(unnamed, [{ id: 'C-cccccccc', kind: 'included', what: 'KAI-1 widen the query [REVIEW: SCOPE]', commits: ['c'.repeat(12)] }]);
  assert.equal(isWorkFile('src/a.ts'), true);
  assert.equal(isWorkFile('.ralph/SPECS_LEDGER.md'), false);
  assert.equal(isWorkFile('records/runs/x.json'), false);
});

test('a person\'s version of the plan keeps the ticks this copy and Kairos know of, and their words', () => {
  const theirs = '## Phases\n- [ ] **Phase 1: The record**\n  - [ ] Add the table\n  - [ ] Add a thing they added\n- [ ] **Phase 2: The screen** <- NEXT\n';
  const local = '- [x] **Phase 1: The record** (abc1234)\n';
  const out = withTicks(theirs, local, [{ title: 'Phase 9', done: false, tasks: [{ text: 'Add the table', done: true }] }]);
  assert.equal(out, '## Phases\n- [x] **Phase 1: The record**\n  - [x] Add the table\n  - [ ] Add a thing they added\n- [ ] **Phase 2: The screen** <- NEXT\n');
});

test('planForKairosSendsTaskIds', () => {
  const { phases } = planForKairos('## Phases\n- [ ] **Phase 1: A** <- NEXT\n  - [ ] P1.T1 Add the list [sonnet]\n  - [x] EG.T2 Run the gate (abc1234)\n');
  assert.deepEqual(phases[0].tasks, [{ id: 'P1.T1', text: 'Add the list', done: false, commit: null }, { id: 'EG.T2', text: 'Run the gate', done: true, commit: 'abc1234' }]);
});

test('planForKairosOmitsIdWhenNone', () => {
  const { phases } = planForKairos('## Phases\n- [ ] **Phase 1: A**\n  - [ ] Add the list\n');
  assert.equal('id' in phases[0].tasks[0], false);
  assert.equal(phases[0].tasks[0].text, 'Add the list');
});

const ticks = (theirs, local, tasks = []) => withTicks(theirs, local, [{ title: 'Phase 1: A', done: false, tasks }]);

test('rewordedTaskKeepsItsTick', () => {
  const out = ticks('  - [ ] P1.T1 Add the whole list\n', '  - [x] P1.T1 Add the list (abc1234)\n');
  assert.equal(out, '  - [x] P1.T1 Add the whole list\n');
});

test('kairosTaskIdTicksRewordedLine', () => {
  const out = ticks('  - [ ] P1.T1 Add the whole list\n', '', [{ id: 'P1.T1', text: 'Add the list', done: true }]);
  assert.equal(out, '  - [x] P1.T1 Add the whole list\n');
});

test('sameWordsUnderAnotherIdStayOpen', () => {
  const out = ticks('  - [ ] P1.T2 Add the list\n', '  - [x] P1.T1 Add the list\n', [{ id: 'P1.T1', text: 'Add the list', done: true }]);
  assert.equal(out, '  - [ ] P1.T2 Add the list\n');
});

test('unnumberedDoneTaskTicksLineWithId', () => {
  const out = ticks('  - [ ] P1.T1 Add the list\n', '  - [x] Add the list\n');
  assert.equal(out, '  - [x] P1.T1 Add the list\n');
});

// ---- the whole loop ---------------------------------------------------------------------------------------------------

const PLAN = `# Implementation Plan
## Status: planned
## Active Spec
\`specs/demo.md\`
## Phases
- [ ] **Phase 1: Demo** <- NEXT
  - [ ] task one
  - [ ] task two
- [ ] **Exit Gate**
## Open Questions / Blocked
- [ ] \`[product]\` Should a stopped agent keep its grants?
`;
const git = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });

function project({ tracker = { provider: 'kairos' }, spec = '---\ntracker_issue: CEN-60\n---\n# Demo\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-kairos-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.cpSync(path.join(KIT, 'ralph'), path.join(dir, 'ralph'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'));
  fs.writeFileSync(path.join(dir, 'specs', 'demo.md'), spec);
  fs.mkdirSync(path.join(dir, '.ralph'));
  fs.writeFileSync(path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md'), PLAN);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.ralph/\n.claude-temp/\n');
  fs.writeFileSync(path.join(dir, 'ralph.config.json'), JSON.stringify({ project: { name: 'e2e' }, tracker, budget: { iterationUsd: 2, runUsd: 10, dayUsd: 25 } }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

/** A stand-in Kairos: answers the controls from `controls(n)` and writes down everything it is told. */
async function standIn(controls, plan = () => ({ version: null, markdown: null, phases: [], byPerson: false })) {
  const seen = { reads: [], events: [], keys: new Set(), planReads: 0 };
  const base = { item: 'cen-60', key: 'CEN-60', title: 'T', stage: 'spec', go: true, code: null, why: null, caps: { itemUsd: 25, runUsd: null, iterationUsd: null, remainingUsd: 25 }, spentUsd: 0, answers: [], until: 'x' };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.keys.add(req.headers.authorization);
      const reply = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url.startsWith('/run/controls')) {
        seen.reads.push(req.url);
        const c = controls(seen.reads.length);
        return c.status ? reply(c.status, c) : reply(200, { ...base, ...c });
      }
      if (req.url.startsWith('/run/plan')) {
        seen.planReads += 1;
        return reply(200, plan());
      }
      const event = JSON.parse(body);
      seen.events.push(event);
      return reply(200, { controls: base, ...(event.event === 'build_started' ? { moved: true } : {}) });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function loop(dir, args, scenario, env) {
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-kairos-aux-'));
  const log = path.join(aux, 'calls.jsonl');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'ralph', 'lib', 'run-loop.mjs'), ...args], {
      cwd: dir,
      env: { ...process.env, RALPH_AGENT_CMD: `node "${FAKE}"`, FAKE_AGENT_SCENARIO: JSON.stringify(scenario), FAKE_AGENT_LOG: log, FAKE_AGENT_PROMPT_DIR: path.join(aux, 'prompts'), RALPH_PAUSE_S: '0', RALPH_MODEL: '', RALPH_SPEND_LOG: path.join(aux, 'spend.jsonl'), KAIROS_RUN_TOKEN: KEY, ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      const prompt = (n) => { try { return fs.readFileSync(path.join(aux, 'prompts', `prompt-${n}.txt`), 'utf8'); } catch { return ''; } };
      resolve({ code, out, calls: readJsonl(log), rows: readJsonl(path.join(dir, '.ralph', 'iterations.jsonl')), events: readJsonl(path.join(dir, '.ralph', 'loop-events.jsonl')), prompt });
    });
  });
}
const commit = (n) => ({ writes: [{ path: `src/f${n}.txt`, content: `v${n}\n` }], commit: `work ${n}`, tickTask: true });
const names = (seen) => seen.events.map((e) => e.event);

test('a build reports what it does, the driver holds the key, and the agent is told to leave Kairos alone', { timeout: 60000 }, async () => {
  const dir = project();
  const k = await standIn(() => ({}));
  try {
    const r = await loop(dir, ['build', '10', 'specs/demo.md'], { iterations: [commit(1), { ...commit(2), tickAll: true }] }, { KAIROS_URL: k.url });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(names(k.seen).filter((n) => n !== 'plan'), ['run_started', 'build_started', 'iteration', 'iteration', 'review_required', 'run_ended']);
    assert.ok(k.seen.reads[0].includes('item=CEN-60') && k.seen.reads[0].includes('mode=build'));
    assert.deepEqual([...k.seen.keys], [`Bearer ${KEY}`]);
    assert.equal(r.calls.every((c) => c.saw_run_token === false), true, 'the agent must not get the key');
    const end = k.seen.events.at(-1);
    assert.equal(end.stopReason, 'completed');
    assert.equal(end.commits, 2);
    assert.equal(end.iter, 2);
    assert.ok(end.runUsd > 0);
    assert.equal(new Set(k.seen.events.map((e) => e.run)).size, 1);
    assert.match(r.prompt(1), /Tracker: Kairos/);
    assert.doesNotMatch(r.prompt(1), /Coordination state file/);
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pause placed in Kairos stops the run before its next iteration', { timeout: 60000 }, async () => {
  const dir = project();
  const k = await standIn((n) => (n >= 3 ? { go: false, code: 'paused', why: 'It is paused: Enough.' } : {}));
  try {
    const r = await loop(dir, ['build', '10', 'specs/demo.md'], { iterations: [commit(1), commit(2), commit(3)], repeat: false }, { KAIROS_URL: k.url });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.rows.length, 1, 'read 1 is the preflight, read 2 lets iteration 1 go, read 3 says stop');
    assert.match(r.out, /KAIROS - It is paused: Enough\./);
    assert.equal(k.seen.events.at(-1).stopReason, 'kairos_stop');
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the item’s cap stops the run, and a cap for a run from Kairos holds too', { timeout: 60000 }, async () => {
  const dir = project();
  const k = await standIn((n) => (n >= 3 ? { go: false, code: 'over-cap', why: 'It has spent $25.00, at its cap of $25.00.' } : {}));
  const small = await standIn(() => ({ caps: { itemUsd: 25, runUsd: 0.01, iterationUsd: null, remainingUsd: 25 } }));
  try {
    const r = await loop(dir, ['build', '10', 'specs/demo.md'], { iterations: [commit(1), commit(2)] }, { KAIROS_URL: k.url });
    assert.equal(r.code, 0, r.out);
    assert.equal(k.seen.events.at(-1).stopReason, 'budget_item');
    fs.rmSync(path.join(dir, '.ralph', '.fake-agent-count'), { force: true });
    const capped = await loop(dir, ['build', '10', 'specs/demo.md'], { iterations: [commit(3), commit(4)] }, { KAIROS_URL: small.url });
    assert.equal(capped.code, 0, capped.out);
    assert.equal(small.seen.events.at(-1).stopReason, 'budget_run', 'the fake agent spends $0.0123 an iteration');
  } finally {
    await small.close();
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a question goes to the owner with what they need, and the next run reads the answer', { timeout: 60000 }, async () => {
  const dir = project();
  let k = await standIn(() => ({}));
  try {
    const r = await loop(dir, ['build', '10', 'specs/demo.md'], { iterations: [{ outcome: 'blocked', status: { next: 'Should a stopped agent keep its grants?', result: 'The spec does not say' } }] }, { KAIROS_URL: k.url });
    assert.equal(r.code, 0, r.out);
    const parked = k.seen.events.find((e) => e.event === 'parked');
    assert.equal(parked.text, 'Should a stopped agent keep its grants?');
    assert.match(parked.context, /The spec does not say/);
    assert.match(parked.context, /`\[product\]` Should a stopped agent keep its grants\?/);
    assert.equal(k.seen.events.at(-1).stopReason, 'blocked');
    await k.close();

    k = await standIn(() => ({ answers: [{ question: 'Should a stopped agent keep its grants?', choice: 'Yes', note: 'Until they end', at: 'x' }] }));
    fs.rmSync(path.join(dir, '.ralph', '.fake-agent-count'), { force: true });
    const again = await loop(dir, ['build', '1', 'specs/demo.md'], { iterations: [commit(1)] }, { KAIROS_URL: k.url });
    assert.match(again.prompt(1), /A person answered/);
    assert.match(again.prompt(1), /\*\*Should a stopped agent keep its grants\?\*\* Yes \(Until they end\)/);
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('it will not start if Kairos says no, cannot be read, or has no key', { timeout: 60000 }, async () => {
  const dir = project();
  const no = await standIn(() => ({ go: false, code: 'held', why: 'The validation plan still needs: the test plan.' }));
  const refused = await standIn(() => ({ status: 401, message: 'This key has ended.' }));
  try {
    const held = await loop(dir, ['build', '5', 'specs/demo.md'], { iterations: [commit(1)] }, { KAIROS_URL: no.url });
    assert.equal(held.code, 1);
    assert.match(held.out, /the test plan/);
    assert.equal(held.calls.length, 0);
    assert.equal(no.seen.events.length, 0);

    const ended = await loop(dir, ['build', '5', 'specs/demo.md'], { iterations: [commit(1)] }, { KAIROS_URL: refused.url });
    assert.equal(ended.code, 1);
    assert.match(ended.out, /This key has ended/);
    assert.equal(ended.calls.length, 0);

    const noKey = await loop(dir, ['build', '5', 'specs/demo.md'], { iterations: [commit(1)] }, { KAIROS_URL: no.url, KAIROS_RUN_TOKEN: '' });
    assert.equal(noKey.code, 1);
    assert.match(noKey.out, /KAIROS_RUN_TOKEN/);
    assert.equal(noKey.calls.length, 0);
  } finally {
    await no.close();
    await refused.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a spec with no item will not run, and --skip-tracker runs without Kairos and says so', { timeout: 60000 }, async () => {
  const dir = project({ spec: '# No front matter\n' });
  const k = await standIn(() => ({}));
  try {
    const none = await loop(dir, ['build', '5', 'specs/demo.md'], { iterations: [commit(1)] }, { KAIROS_URL: k.url });
    assert.equal(none.code, 1);
    assert.match(none.out, /tracker_issue/);
    const skip = await loop(dir, ['build', '1', 'specs/demo.md', '--skip-tracker'], { iterations: [commit(1)] }, { KAIROS_URL: k.url });
    assert.equal(skip.code, 0, skip.out);
    assert.match(skip.out, /Nothing in Kairos can stop or limit it/);
    assert.equal(k.seen.reads.length, 0);
    assert.equal(k.seen.events.length, 0);
    assert.doesNotMatch(skip.prompt(1), /Tracker: Kairos/);
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('whoever starts the loop can insist on Kairos, whatever the branch\'s config says', { timeout: 60000 }, async () => {
  const dir = project({ tracker: { provider: 'none' } });
  const k = await standIn(() => ({}));
  try {
    const off = await loop(dir, ['build', '1', 'specs/demo.md'], { iterations: [commit(1)] }, { KAIROS_URL: k.url });
    assert.equal(off.code, 0, off.out);
    assert.equal(k.seen.reads.length, 0, 'the branch says none, and nobody insisted');
    fs.rmSync(path.join(dir, '.ralph', '.fake-agent-count'), { force: true });
    const on = await loop(dir, ['build', '1', 'specs/demo.md'], { iterations: [commit(2)] }, { KAIROS_URL: k.url, RALPH_TRACKER_PROVIDER: 'kairos' });
    assert.equal(on.code, 0, on.out);
    assert.ok(k.seen.reads.length > 0);
    assert.equal(k.seen.events.at(-1).event, 'run_ended');
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a review pass reports what it found, without a started event', { timeout: 60000 }, async () => {
  const dir = project();
  const k = await standIn(() => ({}));
  try {
    const r = await loop(dir, ['review', '1', 'specs/demo.md'], { iterations: [{ outcome: 'progressed', status: { result: 'Two findings fixed' } }] }, { KAIROS_URL: k.url });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(names(k.seen).filter((n) => n !== 'plan'), ['run_started', 'review_run', 'run_ended']);
    assert.equal(k.seen.events[1].text, 'Two findings fixed');
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run nobody is watching stops once Kairos has been down too long; until then it goes on', { timeout: 60000 }, async () => {
  const dir = project();
  const answers = { n: 0 };
  /* Each read is retried five times inside the client, so the two good answers are the preflight and the first loop read. */
  const k = await standIn(() => {
    answers.n += 1;
    return answers.n <= 2 ? {} : { status: 500, message: 'Down' };
  });
  try {
    const r = await loop(dir, ['build', '3', 'specs/demo.md'], { iterations: [commit(1)], repeat: true }, { KAIROS_URL: k.url, RALPH_KAIROS_RETRY_MS: '1' });
    assert.equal(r.rows.length, 3, 'it goes on through a short outage');
    assert.match(r.out, /Going on with the last answer/);
    assert.equal(k.seen.events.at(-1).stopReason, 'max_iterations');
    fs.rmSync(path.join(dir, '.ralph', '.fake-agent-count'), { force: true });
    answers.n = 0;
    const stopped = await loop(dir, ['build', '5', 'specs/demo.md'], { iterations: [commit(9)], repeat: true }, { KAIROS_URL: k.url, RALPH_KAIROS_RETRY_MS: '1', RALPH_KAIROS_OUTAGE_MIN: '0' });
    assert.equal(k.seen.events.at(-1).stopReason, 'kairos_unreachable', stopped.out);
    assert.match(stopped.out, /a stop placed there would not be seen/);
    assert.equal(stopped.rows.length - r.rows.length, 1, 'the first failed read after the first iteration stops it');
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run someone is watching keeps going however long Kairos is down', { timeout: 60000 }, async () => {
  const dir = project();
  const answers = { n: 0 };
  const k = await standIn(() => {
    answers.n += 1;
    return answers.n <= 2 ? {} : { status: 500, message: 'Down' };
  });
  try {
    const r = await loop(dir, ['build', '3', 'specs/demo.md'], { iterations: [commit(1)], repeat: true }, { KAIROS_URL: k.url, RALPH_KAIROS_RETRY_MS: '1', RALPH_KAIROS_OUTAGE_MIN: '0', RALPH_KAIROS_ATTENDED: '1' });
    assert.equal(r.rows.length, 3, r.out);
    assert.equal(k.seen.events.at(-1).stopReason, 'max_iterations');
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a plan run goes ahead with Kairos down, and its plan reaches Kairos with the next run', { timeout: 60000 }, async () => {
  const dir = project();
  /* A server that refuses everything, then one that answers: the same address is not needed, as the kept reports are in a file. */
  const down = await standIn(() => ({ status: 503, message: 'Waking' }));
  const closedUrl = down.url;
  await down.close();
  const k = await standIn(() => ({}));
  try {
    const planned = await loop(dir, ['plan', '1', 'specs/demo.md'], { iterations: [{ writes: [{ path: 'src/p.txt', content: 'p\n' }], commit: 'plan' }] }, { KAIROS_URL: closedUrl, RALPH_KAIROS_RETRY_MS: '1' });
    assert.equal(planned.code, 0, planned.out);
    assert.match(planned.out, /Writing the plan anyway/);
    assert.equal(planned.rows.length, 1);
    assert.match(planned.out, /They are kept, and go with the next run/);
    const refused = await loop(dir, ['build', '1', 'specs/demo.md'], { iterations: [commit(1)] }, { KAIROS_URL: closedUrl, RALPH_KAIROS_RETRY_MS: '1' });
    assert.equal(refused.code, 1, 'a build does not start while Kairos cannot be read');
    assert.equal(refused.rows.length, 1);
    await loop(dir, ['plan', '1', 'specs/demo.md'], { iterations: [{ writes: [{ path: 'src/q.txt', content: 'q\n' }], commit: 'plan again' }] }, { KAIROS_URL: k.url, RALPH_KAIROS_RETRY_MS: '1' });
    const told = names(k.seen);
    assert.ok(told.indexOf('plan') >= 0);
    assert.equal(told[0], 'run_started', 'what was kept goes first');
    assert.ok(k.seen.events.filter((e) => e.event === 'plan').length >= 2, told.join());
    assert.deepEqual(fs.readdirSync(path.join(dir, '.ralph')).filter((f) => f.startsWith('kairos-outbox')), []);
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the plan goes to Kairos after each iteration, as checked, and a person\'s version comes back with its ticks', { timeout: 60000 }, async () => {
  const dir = project();
  let version = null;
  let byPerson = false;
  const theirs = '## Status: x\n## Active Spec\n`specs/demo.md`\n## Phases\n- [ ] **Phase 1: Demo** <- NEXT\n  - [ ] task one\n  - [ ] a task they added\n- [ ] **Exit Gate**\n';
  const k = await standIn(
    (n) => {
      if (n >= 3) {
        version = 2;
        byPerson = true;
      }
      return { agency: 'hands-off', plan: { state: 'approved', version, comments: null } };
    },
    () => ({ version, markdown: theirs, phases: [{ id: 'phase-1', title: 'Phase 1: Demo', done: false, tasks: [] }], byPerson })
  );
  try {
    const r = await loop(dir, ['build', '2', 'specs/demo.md'], { iterations: [commit(1), commit(2)] }, { KAIROS_URL: k.url });
    assert.equal(r.code, 0, r.out);
    const plans = k.seen.events.filter((e) => e.event === 'plan');
    assert.equal(plans.length, 2);
    assert.ok(plans[0].plan.markdown.includes('# Implementation Plan'));
    assert.deepEqual(plans[0].plan.phases.map((p) => p.id), ['phase-1', 'exit-gate']);
    assert.equal(plans[0].plan.basedOn, null);
    assert.equal(plans[0].plan.complete, false, 'no check in this project, so it is not called complete');
    assert.deepEqual(plans[0].plan.questions, ['`[product]` Should a stopped agent keep its grants?']);
    assert.match(plans[0].plan.commit, /^[0-9a-f]{12}$/);
    assert.equal(plans[1].plan.basedOn, 2);
    assert.match(r.out, /Took version 2 of the plan from Kairos, changed by a person/);
    const after = fs.readFileSync(path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md'), 'utf8');
    assert.match(after, /a task they added/);
    assert.match(after, /- \[x\] task one/, 'the tick the run earned before survives');
    assert.match(r.prompt(1), /may do on its own: hands-off/);
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('personsRewordKeepsTickThroughTheLoop', { timeout: 60000 }, async () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md'), PLAN.replace('  - [ ] task one', '  - [ ] P1.T1 task one').replace('  - [ ] task two', '  - [ ] P1.T2 task two'));
  let version = null;
  let byPerson = false;
  const theirs = '## Status: x\n## Active Spec\n`specs/demo.md`\n## Phases\n- [ ] **Phase 1: Demo** <- NEXT\n  - [ ] P1.T1 task one, said another way\n  - [ ] P1.T2 task two\n- [ ] **Exit Gate**\n';
  const k = await standIn(
    (n) => {
      if (n >= 3) {
        version = 2;
        byPerson = true;
      }
      return { agency: 'hands-off', plan: { state: 'approved', version, comments: null } };
    },
    () => ({ version, markdown: theirs, phases: [], byPerson })
  );
  try {
    const r = await loop(dir, ['build', '2', 'specs/demo.md'], { iterations: [commit(1), commit(2)] }, { KAIROS_URL: k.url });
    assert.equal(r.code, 0, r.out);
    const plans = k.seen.events.filter((e) => e.event === 'plan');
    assert.deepEqual(plans[0].plan.phases[0].tasks.map((t) => [t.id, t.text, t.done]).slice(0, 1), [['P1.T1', 'task one', true]]);
    const after = fs.readFileSync(path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md'), 'utf8');
    assert.match(after, /- \[x\] P1\.T1 task one, said another way/);
    assert.equal(plans[1].plan.phases[0].tasks[0].id, 'P1.T1');
    assert.equal(plans[1].plan.phases[0].tasks[0].text, 'task one, said another way');
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the driver sends what was found, what it cost, and every file changed, seen from the branch', { timeout: 60000 }, async () => {
  const dir = project();
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.appendFileSync(path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md'), '## Scope changes\n- S1 included - The helper throws. Blocks: Demo. Evidence: it fails.\n');
  const k = await standIn(() => ({ agency: 'hands-off' }));
  try {
    const r = await loop(dir, ['build', '2', 'specs/demo.md'], { iterations: [
      { writes: [{ path: 'src/h.txt', content: 'h\n' }], commit: 'KAI-1 fix the helper, S1' },
      { writes: [{ path: 'src/w.txt', content: 'w\n' }], commit: 'KAI-1 widen it [REVIEW: SCOPE]' },
    ] }, { KAIROS_URL: k.url });
    assert.equal(r.code, 0, r.out);
    const plans = k.seen.events.filter((e) => e.event === 'plan');
    const first = plans[0].plan.scope.find((s) => s.id === 'S1');
    assert.equal(first.blocksInSpec, true, 'the spec has the word it names');
    assert.ok(first.costUsd > 0, 'the iteration whose commit names it is counted');
    assert.equal(first.commits.length, 1);
    const last = plans.at(-1).plan;
    assert.equal(last.scope.find((s) => s.id === 'S1').costUsd, first.costUsd, 'an iteration that names another adds nothing');
    assert.ok(last.scope.some((s) => s.kind === 'included' && /widen it/.test(s.what)), 'the one left out of the plan is still reported');
    assert.deepEqual(last.changedFiles.sort(), ['src/h.txt', 'src/w.txt']);
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the next run is told what a person rejected, and what the owner answered', { timeout: 60000 }, async () => {
  const dir = project();
  const k = await standIn(() => ({ rejected: [{ id: 'S1', what: 'The helper', why: 'Not this way' }], answers: [{ question: 'S3?', choice: 'Wait for the new item', note: null }] }));
  try {
    const r = await loop(dir, ['build', '1', 'specs/demo.md'], { iterations: [commit(1)] }, { KAIROS_URL: k.url });
    assert.equal(r.code, 0, r.out);
    assert.match(r.prompt(1), /A person rejected S1\.\*\* The helper\. Why: Not this way\. Take it out/);
    assert.match(r.prompt(1), /Wait for the new item/);
    assert.match(r.prompt(1), /What you find outside the spec/);
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new copy takes what Kairos holds, and the next plan run reads the person\'s words', { timeout: 60000 }, async () => {
  const dir = project();
  const k = await standIn(
    () => ({ plan: { state: 'returned', version: 1, comments: 'Split the phase' } }),
    () => ({ version: 1, markdown: '## Phases\n- [ ] **Phase 1: From Kairos** <- NEXT\n- [ ] **Exit Gate**\n', phases: [], byPerson: false })
  );
  try {
    const r = await loop(dir, ['plan', '1', 'specs/demo.md'], { iterations: [{}] }, { KAIROS_URL: k.url });
    assert.equal(r.code, 0, r.out);
    assert.match(r.prompt(1), /The plan was sent back\.\*\* Split the phase/);
    assert.match(fs.readFileSync(path.join(dir, '.ralph', 'IMPLEMENTATION_PLAN.md'), 'utf8'), /Phase 1: From Kairos/);
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a build stops at once if Kairos says its plan needs approving', { timeout: 60000 }, async () => {
  const dir = project();
  const k = await standIn((n) => (n >= 2 ? { go: false, code: 'plan-unapproved', why: 'Its plan, version 2, is waiting to be approved.', plan: { state: 'waiting', version: 2, comments: null } } : {}));
  try {
    const r = await loop(dir, ['build', '5', 'specs/demo.md'], { iterations: [commit(1)], repeat: true }, { KAIROS_URL: k.url });
    assert.equal(r.rows.length, 0, 'it never reaches an iteration');
    assert.match(r.out, /waiting to be approved/);
    assert.equal(k.seen.events.at(-1).stopReason, 'kairos_stop');
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

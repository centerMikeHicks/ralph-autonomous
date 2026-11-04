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
import { answersBlock, capsWithKairos, createKairos, kairosProblem, kairosSettings, productQuestions, stopReasonFor } from '../ralph/lib/kairos.mjs';
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
async function standIn(controls) {
  const seen = { reads: [], events: [], keys: new Set() };
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
    assert.deepEqual(names(k.seen), ['run_started', 'build_started', 'iteration', 'iteration', 'review_required', 'run_ended']);
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
    assert.deepEqual(names(k.seen), ['run_started', 'review_run', 'run_ended']);
    assert.equal(k.seen.events[1].text, 'Two findings fixed');
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('three failed reads in a row end the run; until then the last answer stands', { timeout: 60000 }, async () => {
  const dir = project();
  const answers = { n: 0 };
  /* Each read is retried five times inside the client, so the two good answers are the preflight and the first loop read. */
  const k = await standIn(() => {
    answers.n += 1;
    return answers.n <= 2 ? {} : { status: 500, message: 'Down' };
  });
  try {
    const r = await loop(dir, ['build', '10', 'specs/demo.md'], { iterations: [commit(1)], repeat: true }, { KAIROS_URL: k.url, RALPH_KAIROS_RETRY_MS: '1' });
    assert.equal(k.seen.events.at(-1).stopReason, 'kairos_unreachable', r.out);
    assert.match(r.out, /a stop placed there would not be seen/);
    assert.equal(r.rows.length, 3, 'iterations go on through two failed reads');
  } finally {
    await k.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

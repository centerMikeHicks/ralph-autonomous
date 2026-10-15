import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir, rmDir, initRepo, git, writeFiles, runScript } from './helpers/kit.mjs';
import { fromSpec, fromPlan, fromTalk, fromQueue, render } from '../scripts/ralph-decisions.mjs';

const SPEC = `---
title: X
---

# X

## Open Questions

- [x] \`[product]\` Q1 — resolved (product owner, 2026-10-01): seven days.
- [x] \`[product]\` \`[REVIEW]\` Q2 — decided by the supervising agent from standards/authz.md: 404 for non-members.
- [x] \`[product]\` \`[REVIEWED]\` Q3 — decided by the supervising agent; accepted 2026-10-03.
- [ ] \`[product]\` Q4 — open, blocks no phase: restrict by domain?
- [ ] \`[tooling]\` Q5 — the harness clock is not frozen in SQL.
  It only affects expiry tests.

## References
`;

const PLAN = `# Implementation Plan
## Active Spec
\`specs/x.md\`
## Decisions
- D7 - put the sweep in the existing scheduler (standards/jobs.md)
- D8 - reuse the mail outbox [REVIEWED]
## Waivers
## Open Questions / Blocked
- [ ] \`[product]\` CANDIDATE-SPEC: audit export has no paging (outside, pre-existing)
- [ ] \`[product]\` REVIEW: src/a.ts:10 - token compare is not constant-time (outside-ship-blocking)
- [ ] \`[tooling]\` verifier mis-parses tables
- [x] \`[product]\` answered already
`;

const TALK = `# Run log
## Decisions
- [REVIEW] 2026-10-15T21:40 specs/x.md — returned 404 to non-members. Rule: standards/authz.md. Recorded: spec Q2. Undo: change D6.
- [REVIEW: SCOPE] 2026-10-15T23:05 specs/x.md — fixed missing index the new query needs. Why now: the spec's own query times out.
- [REVIEWED] 2026-10-14 specs/y.md — merged the base into the branch.
- [ASK] specs/z.md — should --verbose include timings?
- plain note, not a decision
`;

const QUEUE = `- [x] specs/y.md — reviewed
- [!] specs/z.md — blocked in build: [product] timings?
- [!] specs/w.md — MOVED to lane backend
- [ ] specs/v.md
`;

test('fromSpec: open product questions need you; [REVIEW] calls are decided for you; [REVIEWED] and tooling drop out', () => {
  const items = fromSpec(SPEC, 'specs/x.md');
  const open = items.filter((i) => !i.reviewed);
  assert.deepEqual(open.map((i) => [i.group, i.kind]), [['decided', 'agent call'], ['needs', 'question']]);
  assert.match(open[0].text, /Q2/);
  assert.match(open[1].text, /Q4/);
  assert.equal(items.find((i) => i.reviewed).line, 11);
});

test('fromPlan: decisions, candidate specs and findings, with the active spec attached', () => {
  const items = fromPlan(PLAN, '.ralph/IMPLEMENTATION_PLAN.md');
  const kinds = items.map((i) => `${i.group}:${i.kind}${i.reviewed ? ':reviewed' : ''}`);
  assert.deepEqual(kinds, ['decided:plan decision', 'decided:plan decision:reviewed', 'deferred:candidate', 'needs:finding']);
  assert.ok(items.every((i) => i.spec === 'specs/x.md'));
});

test('fromTalk: [REVIEW], [REVIEW: SCOPE], [ASK] and [REVIEWED] entries; plain notes are ignored', () => {
  const items = fromTalk(TALK, '.claude-temp/run/TALK.md');
  assert.deepEqual(items.map((i) => `${i.kind}${i.reviewed ? ':reviewed' : ''}`), ['supervisor', 'scope', 'supervisor:reviewed', 'ask']);
  assert.equal(items[0].line, 3);
});

test('fromQueue: parked lines, not lines moved to a lane', () => {
  const items = fromQueue(QUEUE, 'QUEUE.md');
  assert.equal(items.length, 1);
  assert.equal(items[0].spec, 'specs/z.md');
  assert.match(items[0].text, /timings/);
});

test('render groups needs-you first and names where each entry lives', () => {
  const out = render([...fromQueue(QUEUE, 'Q.md'), ...fromTalk(TALK, 'T.md').filter((i) => !i.reviewed)]);
  assert.ok(out.indexOf('NEEDS YOU (2)') < out.indexOf('DECIDED FOR YOU (2)'));
  assert.match(out, /parked\s+specs\/z\.md .* Q\.md:2/);
  assert.match(out, /DEFERRED \(0\)/);
});

test('the CLI gathers specs, plans, talk logs, the queue and Tooling / scope commits on the branch', () => {
  const dir = tmpDir('kit-decisions-');
  try {
    initRepo(dir, { 'ralph.config.json': '{ "project": { "baseBranch": "main" } }\n' });
    git(dir, ['switch', '-q', '-c', 'feature']);
    writeFiles(dir, {
      'specs/x.md': SPEC,
      '.ralph/IMPLEMENTATION_PLAN.md': PLAN,
      '.claude-temp/run/TALK.md': TALK,
      '.claude-temp/ralph-queue/QUEUE.md': QUEUE,
    });
    git(dir, ['add', 'specs', '.ralph']);
    git(dir, ['commit', '-q', '-m', 'x Tooling: fix the verifier table parser']);
    writeFiles(dir, { 'a.txt': '1\n' });
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-q', '-m', 'x review: add index', '-m', '- [REVIEW: SCOPE] the query times out without it']);
    writeFiles(dir, { 'b.txt': '1\n' });
    git(dir, ['add', 'b.txt']);
    git(dir, ['commit', '-q', '-m', 'x Phase 2: ordinary work']);

    const r = runScript('ralph-decisions.mjs', ['--json'], { cwd: dir });
    assert.equal(r.status, 0, r.out);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.needsYou.map((i) => i.kind).sort(), ['ask', 'finding', 'parked', 'question']);
    assert.ok(j.decided.some((i) => i.kind === 'tooling' && /Tooling: fix/.test(i.text)));
    assert.ok(j.decided.some((i) => i.kind === 'scope' && /add index/.test(i.text)));
    assert.ok(!j.decided.some((i) => /ordinary work/.test(i.text)));
    assert.ok(!j.decided.some((i) => i.reviewed));
    assert.equal(j.deferred.length, 1);

    const all = JSON.parse(runScript('ralph-decisions.mjs', ['--json', '--all'], { cwd: dir }).stdout);
    assert.ok(all.decided.some((i) => i.reviewed));

    const one = JSON.parse(runScript('ralph-decisions.mjs', ['--json', '--spec', 'z'], { cwd: dir }).stdout);
    assert.deepEqual(one.needsYou.map((i) => i.kind).sort(), ['ask', 'parked']);

    assert.equal(runScript('ralph-decisions.mjs', ['--bogus'], { cwd: dir }).status, 2);
  } finally { rmDir(dir); }
});

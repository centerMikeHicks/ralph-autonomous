import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assemblePrompt, parseDiffAnchors } from '../ralph/lib/prompt-assemble.mjs';
import {
  atlassianConnected, frontMatterValue, resolveSpec, resolveTracker, setFrontMatterValue, archiveOutgoingPlan,
} from '../ralph/lib/spec-tracker.mjs';
import { parseArgs } from '../ralph/lib/run-loop.mjs';
import { buildAgentArgs, resolveAgent, splitCommand } from '../ralph/lib/agent.mjs';

const PLAN = '## Status: x\n- [ ] **Phase 1** <- NEXT\n  - [ ] do it\n- [ ] **Exit Gate**\n';

test('prompt: blocks appear in order and the mode prompt comes last, verbatim', () => {
  const out = assemblePrompt({
    mode: 'build', spec: 'specs/demo.md', planText: PLAN, promptText: 'PROMPT BODY',
    prevStatus: { spec: 'demo', phase: 'P1', outcome: 'progressed', did: 'd', result: 'r', next: 'n', stale: false },
    anchors: ['src/a.js:10-12'],
    tracker: { enabled: true, issue: 'PROJ-7', project: 'PROJ', state: '.ralph/tracker/demo.json', text: 'TRACKER RULES' },
    gate: { ticks: 'ok', exitGate: 'pending' }, preflightFailure: '',
  });
  const order = ['Active Spec File', 'The plan, cut', 'Where the last iteration worked', 'previous iteration', 'Tracker Ticket', 'Last verification verdict', 'PROMPT BODY'];
  let at = -1;
  for (const marker of order) {
    const idx = out.indexOf(marker);
    assert.ok(idx > at, `${marker} out of order`);
    at = idx;
  }
  assert.match(out, /PROJ-7/);
  assert.match(out, /TRACKER RULES/);
  assert.ok(out.endsWith('PROMPT BODY'));
});

test('prompt: no tracker block unless enabled, no plan view outside build, STALE flag shows', () => {
  const out = assemblePrompt({
    mode: 'plan', spec: 'specs/demo.md', planText: PLAN, promptText: 'P',
    prevStatus: { outcome: 'x', stale: true }, anchors: [], tracker: { enabled: false, issue: '' }, gate: null, preflightFailure: '',
  });
  assert.doesNotMatch(out, /Tracker/i);
  assert.doesNotMatch(out, /Jira/i);
  assert.doesNotMatch(out, /The plan, cut/);
  assert.match(out, /STALE/);
});

test('parseDiffAnchors extracts file:line ranges and ignores pure deletions', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js',
    '@@ -1,2 +10,3 @@', '@@ -20 +30 @@', '@@ -40,2 +0,0 @@',
    '+++ b/docs/x.md', '@@ -0,0 +1,5 @@',
  ].join('\n');
  assert.deepEqual(parseDiffAnchors(diff), ['src/a.js:10-12', 'src/a.js:30', 'docs/x.md:1-5']);
});

test('front matter get/set keeps the body and is CRLF safe', () => {
  const spec = '---\r\ntitle: T\r\n---\r\n# Body\r\n';
  assert.equal(frontMatterValue(spec, 'tracker_issue'), '');
  const set = setFrontMatterValue(spec, 'tracker_issue', 'AB-1');
  assert.equal(frontMatterValue(set, 'tracker_issue'), 'AB-1');
  assert.match(set, /# Body/);
  assert.equal(frontMatterValue(setFrontMatterValue(set, 'tracker_issue', 'AB-2'), 'tracker_issue'), 'AB-2');
  assert.match(setFrontMatterValue('# no fm\n', 'tracker_issue', 'AB-3'), /^---\ntracker_issue: AB-3\n---/);
});

function tmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-sp-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveSpec: arg is recorded without BOM; recorded value is read BOM-tolerantly; missing flagged', () => tmp((root) => {
  const stateDir = path.join(root, '.ralph');
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'specs', 'a.md'), '# a');
  assert.deepEqual(resolveSpec({ root, stateDir, specArg: '' }), { spec: '', source: 'none', missing: false });
  const set = resolveSpec({ root, stateDir, specArg: 'specs\\a.md' });
  assert.equal(set.spec, 'specs/a.md');
  assert.equal(fs.readFileSync(path.join(stateDir, 'ACTIVE_SPEC'))[0], 0x73);
  fs.writeFileSync(path.join(stateDir, 'ACTIVE_SPEC'), '\uFEFFspecs/a.md\r\n');
  assert.equal(resolveSpec({ root, stateDir, specArg: '' }).spec, 'specs/a.md');
  assert.equal(resolveSpec({ root, stateDir, specArg: 'specs/zzz.md' }).missing, true);
}));

test('resolveTracker: off unless provider is jira; needs a bound issue; --issue writes it; skip disables', () => tmp((root) => {
  fs.mkdirSync(path.join(root, 'specs'));
  const specFile = path.join(root, 'specs', 'a.md');
  fs.writeFileSync(specFile, '# a\n');
  const jira = { tracker: { provider: 'jira', jira: { project: 'PROJ' } } };
  assert.equal(resolveTracker({ cfg: { tracker: { provider: 'none' } }, root, spec: 'specs/a.md' }).enabled, false);
  assert.equal(resolveTracker({ cfg: jira, root, spec: 'specs/a.md', skip: true }).enabled, false);
  assert.match(resolveTracker({ cfg: jira, root, spec: 'specs/a.md' }).error, /no tracker_issue/);
  assert.match(resolveTracker({ cfg: jira, root, spec: 'specs/a.md', issueArg: 'bad' }).error, /not a ticket key/);
  const bound = resolveTracker({ cfg: jira, root, spec: 'specs/a.md', issueArg: 'PROJ-5' });
  assert.equal(bound.issue, 'PROJ-5');
  assert.equal(frontMatterValue(fs.readFileSync(specFile, 'utf8'), 'tracker_issue'), 'PROJ-5');
  assert.equal(resolveTracker({ cfg: jira, root, spec: 'specs/a.md' }).issue, 'PROJ-5');
}));

test('atlassianConnected reads a server table', () => {
  assert.equal(atlassianConnected('atlassian: https://x - \u2713 Connected\nother: y - Failed'), true);
  assert.equal(atlassianConnected('atlassian: https://x - Needs authentication'), false);
  assert.equal(atlassianConnected('atlassian: x - Not connected'), false);
  assert.equal(atlassianConnected(''), false);
});

test('archiveOutgoingPlan keeps a plan that belongs to another spec, once', () => tmp((root) => {
  const stateDir = path.join(root, '.ralph');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, 'IMPLEMENTATION_PLAN.md'), '# P\n## Active Spec\n`specs/old.md`\n## Phases\n- [x] **P1**\n');
  assert.equal(archiveOutgoingPlan({ stateDir, newSpec: 'specs/old.md' }), '');
  const dest = archiveOutgoingPlan({ stateDir, newSpec: 'specs/new.md' });
  assert.match(dest, /IMPLEMENTATION_PLAN\.old\.md$/);
  assert.equal(archiveOutgoingPlan({ stateDir, newSpec: 'specs/new.md' }), '');
}));

test('parseArgs: positional and option forms of the command-line surface', () => {
  assert.deepEqual(parseArgs([]), { mode: 'build', max: 0, spec: '', model: '', issue: '', skipTracker: false, noTranscripts: false, error: '' });
  const p = parseArgs(['plan', '3', 'specs/a.md', '--model', 'opus', '--issue=AB-1', '--skip-tracker', '--no-transcripts']);
  assert.deepEqual([p.mode, p.max, p.spec, p.model, p.issue, p.skipTracker, p.noTranscripts], ['plan', 3, 'specs/a.md', 'opus', 'AB-1', true, true]);
  assert.equal(parseArgs(['build', 'specs/a.md']).spec, 'specs/a.md');
  assert.match(parseArgs(['nope']).error, /unknown mode/);
  assert.match(parseArgs(['build', '--wat']).error, /unknown option/);
});

test('agent command: RALPH_AGENT_CMD overrides config, quotes are honoured, flags are appended', () => {
  assert.deepEqual(splitCommand('node "C:\\my dir\\fake.mjs" --x'), ['node', 'C:\\my dir\\fake.mjs', '--x']);
  const cfg = { agent: { command: 'claude', args: ['-p'], modelFlag: '--model', effortFlag: '--effort' } };
  const real = resolveAgent(cfg, {});
  assert.equal(real.isClaude, true);
  const args = buildAgentArgs({ agent: real, cfg, model: 'm', effort: 'high', root: os.tmpdir() });
  assert.deepEqual(args.slice(0, 5), ['-p', '--model', 'm', '--effort', 'high']);
  const fake = resolveAgent(cfg, { RALPH_AGENT_CMD: 'node /x/fake.mjs' });
  assert.deepEqual([fake.command, fake.isClaude, fake.baseArgs.slice(0, 2)], ['node', false, ['/x/fake.mjs', '-p']]);
  assert.deepEqual(buildAgentArgs({ agent: fake, cfg, model: 'm', effort: '', root: os.tmpdir() }), ['/x/fake.mjs', '-p', '--model', 'm']);
});

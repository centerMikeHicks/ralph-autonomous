---
name: autonomous
description: Work unattended through a queue of specs with the Ralph loop (plan, build, review) while the user is away - overnight, in a meeting, "keep going without me", "work autonomously through the specs", "run the queue". Sets up the queue, starts the detached queue runner, keeps a wake-up source alive so the session never silently stops, decides blockers that the project's standards can decide, and logs every call for the user. Use whenever the user asks for autonomous or unattended spec work, not for a single interactive loop run.
---

# Autonomous spec work

**The queue must keep moving whether or not this session is awake.** The classic failure: a loop is
killed (memory pressure, a reboot), the session logs it, ends its turn with nothing left running to
wake it, and hours of loop time are lost. Everything below exists so that cannot happen.

## 0. Why there are two parts

- **`scripts/ralph-queue.cjs`: the mechanism.** A detached runner (started through
  `scripts/sweep.mjs --service`, so it is not a background shell of this session and survives its exit)
  carries each queued spec through `ralph/loop` plan, build, review, retries interrupted invocations
  after free memory recovers, keeps the machine awake while it has work, and parks a spec only on a real
  blocker.
- **This skill: the judgement.** Building the queue, deciding blockers that the standards can decide,
  re-queueing, reporting.

Fixing something properly is not the same question as fixing it **here**. A real finding inside the
spec's stated boundary gets the complete fix, now. A real finding outside it is handled properly by
being scoped out (a new spec or ticket, a waiver by a person, or a documented residual risk), not by being
built inline because deferring feels like a shortcut. Deferring correctly is not deferring correctness.

## 1. Pre-flight

1. **`git status`: the index must hold nothing that is not yours to commit.** A loop commits what it
   stages by path, but a stray staged change from another session can ride along. If another session has
   staged work, save it (`git diff --cached --binary > .claude-temp/commits/<name>.patch`), unstage it,
   and note how to restore it in the talk log.
2. **No other loop is running in this worktree:** `node scripts/ralph-queue.cjs status`, the tail of
   `.ralph/iterations.jsonl`, and any background task you started. Never start the runner while a loop
   you launched by hand is still going.
3. **Know where decisions live.** The user's recorded decisions (for example
   `.claude-temp/<topic>/DECISIONS.md`) and the **talk log** you write your own calls to (for example
   `.claude-temp/<topic>/TALK.md`). Create both if missing; ask the user for any decision you need.
4. **Draft pull request.** If the branch has an open PR, make it a draft before starting (with GitHub:
   `gh pr view --json isDraft`, `gh pr ready --undo <n>`). Every push to a ready-for-review PR starts the
   project's full CI. Log the conversion; leave marking it ready to the user.
5. **Environment health:** `node scripts/ralph-doctor.mjs`. Fix what it reports before queuing work.
6. **Drift check against the base.** `git fetch origin <baseBranch>` then
   `git rev-list --count HEAD..origin/<baseBranch>` (`project.baseBranch` in `ralph.config.json`). A long-
   lived branch stops being a textual merge problem and becomes a semantic one: a spec can build a
   complete, tested feature against infrastructure the base has already replaced, and it merges clean
   because nothing looked. Fewer than `drift.warnCommits` (default 50) behind: nothing to do. At or above
   it, or any base commit touching a system an active spec's plan depends on (search the base's log for
   the module path, not just the count): **stop before queuing new build work and raise it with the
   user.** It is a decision, not a park reason to verify past.

## 2. Build the queue

Write `.claude-temp/ralph-queue/QUEUE.md`, one spec per line in run order:

```
- [ ] specs/first.md
- [ ] specs/second.md
```

**Keep the queue short: about five specs of real size per worktree.** A long queue does not finish
more work; it starts more. One team that queued 17 large specs at once got hundreds of commits out of
it and only 3 specs reviewed. Specs that are planned and half built but never reviewed
are worth less than specs that were never started: they hold decisions nobody has checked and drift
further from the base every day. Finish specs before starting new ones.

Order: specs already mid-flight first (the runner reads each spec's ledger state, so a half-done spec
resumes where it stopped); then security fixes; then specs other specs depend on; then the rest.
**Leave out** specs that need a person before they can finish: one whose lint (`node scripts/lint-spec.mjs
--spec S --strict`) fails, one waiting on a waiver or product decision, one that collides with work on
another branch or lane. List each omitted spec and why in the talk log.

## 3. Start the runner

```bash
node scripts/ralph-queue.cjs start      # detached; returns immediately
node scripts/ralph-queue.cjs status     # queue markers, current spec + mode, recent events
```

Flags (defaults from `queue` in config): `--build-chunk 3` build iterations per invocation, `--max-build
40` per spec, `--max-review 8` review passes per spec, `--min-free-gb 4` free memory before each invocation, `--max-retries 3`, `--timeout-min 45`
for `watch`. Lower `--max-build` for small specs: a blocked loop left running re-reads its whole context
for no progress. `node scripts/ralph-queue.cjs stop` ends the run after the current invocation; use it
when the user asks or before changing branches. `run` is the foreground form.

## 4. Never end a turn without a wake source

After starting the runner, and at the end of **every** turn while the queue has work, launch a waiter as
a background command so this session is re-invoked when something happens:

```bash
node scripts/ralph-queue.cjs watch --timeout-min 45     # run_in_background: true
```

It returns when the runner logs an event (a loop starts or ends, a spec is done or parked, the queue
empties) or at the timeout. On each wake: run `status`, act on what changed (section 5), then launch the
next `watch`. If the watcher is killed the runner is unaffected: relaunch it; do not stop.

An interruption is never a reason to stop. If a loop or the runner was killed, check free memory and run
`start` again (it resumes from the ledger). If memory is short, wait with a `watch` running rather than
ending the turn.

**Re-check drift on every wake**, not only at start: re-run the `rev-list --count` check after `status`.
The gap that matters opens during a multi-day run. Raising it once at hour zero and never again is how
hundreds of commits accumulate unnoticed.

## 5. When a spec is parked (`[!]`)

Read the reason on the queue line and the plan's open items (`.ralph/IMPLEMENTATION_PLAN.md`).

**Verify the park reason against primary evidence before acting on it.** The reason is the loop's
diagnosis, written by an agent that could only see its own iteration. Read the log, run the failing
check yourself, look at the process or service it blames. A loop that says "the database is warming up"
or "the service is throttling" may be looking at a dependency that has been wedged for hours, and every
re-queue on the wrong diagnosis spends another iteration learning nothing. If the evidence disagrees
with the reason, record what you found next to the queue line before re-queuing.

### The scope gate (before any finding becomes build work)

Place the finding against the spec's own stated boundary (Problem Statement, Scope, Success Criteria):

1. **Inside the boundary:** go to "decide or ask" below.
2. **Outside, and ship-blocking** (this spec's deliverable would be unsafe or wrong without it, typically
   because something this spec built created the gap): fix it, and log it `[REVIEW: SCOPE]` with one line
   on why it could not wait.
3. **Outside, and pre-existing** (true before the spec touched anything): do **not** build it inline.
   Record it as a candidate spec or ticket, document the residual risk, move the review on. Build it now
   only if you can state why it truly cannot wait, and log that the same way.

### Decide or ask

**You can decide it** when the answer follows from the project's `standards/`, the user's recorded
decisions or an existing pattern, **and** it is a proper fix rather than a shortcut. Record the decision
where the loop will read it (the plan item, or a spec amendment through `/design --bind` done by a
subagent with an explicit `model`), log it in the talk log flagged `[REVIEW]` if it is a judgement call,
set the queue line back to `- [ ]`, and let the runner pick it up.

**It needs the user**, always, when it involves: an **approval or waiver** (it needs their identity),
a product call, **data changes outside the worktree**, a **shared environment** (dev/test/prod
databases, indexes, cloud resources: reported, never "fixed" from here), or any **outward-facing action**
(publishing, sending, spending, deleting, changing access, force push, infrastructure apply). Leave the
line `[!]`, log the question, and move on; the runner already has.

### Review passes that do not converge

A spec in review that keeps finding new work is not automatically converging. Verify each park reason,
and watch the shape of the whole tail. **At `review.scopeAuditAfterPasses` (default 5) review passes on
one spec, stop auto-requeuing and do a scope audit:** list every finding from passes 1 to 5, bucket each
by the scope gate, and surface it as one batched decision, not "still finding real things, requeuing
again." A pass that only fixes warnings the previous pass's own fix introduced means the spec has stopped
being about its own boundary.

### Deferred findings must be tracked durably

A finding deferred as outside-and-pre-existing is only safely deferred if something durable holds it.
With a tracker configured, that is the spec's issue (its `review_run` comment) or a new linked candidate
issue. If the tracker is unreachable or the call fails, do not treat the finding as filed. Write it to
the talk log **and** to the spec's plan (`.ralph/IMPLEMENTATION_PLAN.md`, an Open Questions row tagged
`[product]`) before moving the review on. Without a tracker, the plan row plus the talk log is the record.

## 6. Reporting

Keep the talk log current: each spec done (commits, cost from `.ralph/USAGE_LOG.md`), each decision you
made (`[REVIEW]`), each question only the user can answer, and anything a loop found outside its spec.
When the user returns, lead with what needs them, then what shipped.

- Tag any `[REVIEW]` entry that added build scope beyond the spec's boundary `[REVIEW: SCOPE]` with the
  one-line reason it could not be deferred. "Where did the time go" is then answerable from the log.
- Report **infrastructure and tooling specs** (anything whose output is "the loop can now do X") separately
  from **product specs**: they compete for the same slots and hours, and one combined report hides how
  much time went to meta-work.
- `node ralph/report.mjs [--spec S] [--since DATE]` gives iteration counts, durations and gaps.

## 7. Lanes: specs in parallel

One worktree runs one loop at a time: loops there share the git index and the live plan. To parallelise,
give each **lane** its own worktree, branch and runner. **Parallelise specs, never phases of one spec.**
One spec is one lane.

- **Create:** `node scripts/new-lane.mjs --name <x> --base <integration-branch> [--root DIR]` adds a sibling
  worktree and branch, copies the kit config, and prints the queue and runner steps for it.
- **Split by the files specs touch** so merges rarely conflict; two or three lanes is typical. Each lane
  has its own `.claude-temp/ralph-queue/QUEUE.md`, runner and `watch`. Mark specs moved to a lane
  `[!] MOVED to lane <x>` in the integration queue so its runner never picks them up.
- **Merge back** when a lane's spec is `reviewed`: `node scripts/lane-merge-notes.mjs` (run in the lane)
  prints the checklist and ledger-row diff. In the integration worktree merge the lane branch (ask the
  user first), keep the integration plan, make sure the lane's plan is archived as
  `.ralph/IMPLEMENTATION_PLAN.<spec>.md`, merge `SPECS_LEDGER.md` row by row, push, then have the other
  lanes pull.

## Guardrails

- Subagents always get an explicit `model` (the `require-agent-model` hook enforces it): `haiku` for
  lookups, `sonnet` for amendments and investigations, `opus` only for new spec design or security review.
- Never run infrastructure apply, never push anywhere but the branch the loops push to, never skip hooks,
  never force push, never sign a waiver or approval, never touch a shared environment, never commit
  secrets or machine-local config.
- Commit only on the user's standing instruction to run the loop (loops commit their own slices); do not
  make extra commits of your own beyond queue and talk-log housekeeping the user agreed to.
- If anything is unclear about whether an action is yours to take, it is the user's. Park and ask.

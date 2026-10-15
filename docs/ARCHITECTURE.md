# Architecture

How the kit is put together, why, and what each piece guards against. For usage see
[../GETTING_STARTED.md](../GETTING_STARTED.md); for the loop prompts and rules see
[../ralph/CONVENTIONS.md](../ralph/CONVENTIONS.md); for the runtime internals see [RUNTIME.md](RUNTIME.md) and
[DRIVERS.md](DRIVERS.md).

## Design in one page

An agent that remembers nothing cannot drift, so every run is a fresh process that re-reads its state from
disk. The price is that the state files must be right, so the kit keeps them few, plain and machine-checked.
Second principle: **an agent's claim is not evidence.** Every claim that matters ("the plan covers the spec",
"this phase is done", "this test proves the criterion", "the base was already red") has a script that
checks it against the files, the tests or git.

## Layers

```
 supervision      .claude/skills/autonomous      scope calls, parked specs, reporting, lanes
                  scripts/ralph-queue.cjs         detached runner: spec -> plan -> build chunks -> review
 ----------------------------------------------------------------------------------------------
 loop             ralph/loop.sh | loop.ps1       thin launchers (no policy)
                  ralph/lib/*.mjs                all policy: mode, model choice, status, telemetry, retries
                  ralph/PROMPT_*.md, CONVENTIONS the agent's instructions, one per mode
 ----------------------------------------------------------------------------------------------
 gates            scripts/lint-spec.mjs                  spec structure
                  scripts/verify-plan-completeness.mjs   spec -> plan coverage
                  scripts/verify-plan-ticks.mjs          did a tick earn itself
                  scripts/verify-acceptance-bindings.mjs row -> real test
                  scripts/base-health.mjs                base branch vs HEAD
                  scripts/verify-jira-sync.mjs           tracker sync (jira only)
                  .githooks/pre-commit                   the commit-time gate
 ----------------------------------------------------------------------------------------------
 process/runtime  scripts/sweep.mjs + lib/sweep.cjs       the only process owner (start, bound, kill trees)
                  scripts/lib/keep-awake.cjs              keeps the machine awake during a run
                  scripts/lib/config.mjs                 ralph.config.json + defaults + validation
 ----------------------------------------------------------------------------------------------
 state            specs/*.md, .ralph/*, git
```

Drivers hold no decisions. They translate flags and start `ralph/lib/run-loop.mjs`, so Windows and POSIX
cannot diverge. Gates take their configuration from `ralph.config.json` and read the project root from
`RALPH_ROOT`, else the nearest `ralph.config.json`, else the git root (`scripts/lib/config.mjs`).

## State, and who writes it

| File | Written by | Meaning |
|------|-----------|---------|
| `specs/<name>.md` | `/design` (a person confirms) | The contract. Front matter may carry `tracker_issue`. |
| `.ralph/SPECS_LEDGER.md` | `/design` (adds `drafted`), plan/build/review (advance), a person (`shipped`) | One row per spec, four sections. |
| `.ralph/ACTIVE_SPEC` | the driver/queue | Path of the spec the loop works on. |
| `.ralph/IMPLEMENTATION_PLAN.md` | plan mode, then build (ticks, collapses) | The live plan; archived per spec when done. |
| `.ralph/ITERATION_STATUS.json` | the agent, every iteration | `spec, phase, mode, outcome, did, result, next, committed, sha`. |
| `.ralph/PROGRESS.md` | the agent | Narrative between iterations; carries the `JIRA DEGRADED` marker. |
| `.ralph/iterations.jsonl`, `USAGE_LOG.md`, `loop-events.jsonl`, `.loop-heartbeat`, `logs/` | the driver | Telemetry and transcripts; the agent never writes these. |
| `.ralph/base-health.json` | `scripts/base-health.mjs` | Base vs HEAD measurements. |
| `.ralph/tracker/<spec>.json` | the agent (jira only) | Idempotent tracker event log. |
| `.claude-temp/ralph-queue/` | the queue runner | `QUEUE.md` (input and status board), `state.json`, `events.jsonl`, `STOP`. |
| `.claude-temp/<topic>/TALK.md` | the `autonomous` skill | Its `[REVIEW]`, `[REVIEW: SCOPE]` and `[ASK]` entries; an index of decisions also recorded in the spec or plan. `scripts/ralph-decisions.mjs` reads it with the spec, plan, queue and git log ([DECISIONS.md](DECISIONS.md)). |

## The ledger as a state machine

```
 drafted --plan--> planned --build (Exit Gate)--> built --review (clean pass)--> reviewed --a person--> shipped
    \________________________ paused | superseded (a person, or the queue parks it) ________________/
```

| State | Set by | Queue runner starts the spec at |
|-------|--------|---------------------------------|
| `drafted` | `/design` | plan |
| `planned` | plan mode | build (re-plans first if `ACTIVE_SPEC` names another spec) |
| `built` | build mode at the Exit Gate | review |
| `reviewed` | review mode on a clean pass | done |
| `shipped` | a person, when the change lands | done |
| `paused`, `superseded` | a person | parked |

Ledger columns are fixed: `| Spec | Title | Created | Last updated | State | Active? | Commits | Notes |`, in the sections
Active, Recently shipped, Superseded / paused and Backlog (not started) (`templates/ledger.md`).
`scripts/lane-merge-notes.mjs` parses them to diff two ledgers.

## Data flow of one spec

1. `/design` writes `specs/x.md` and a `drafted` row. `lint-spec` checks the structure: front matter, the ten
   sections, every phase has an Acceptance Tests block with tagged, named rows in `Given/When/Then` form, every
   Success Criterion is cited by a row, open questions are tagged, no bare TODO, no duplicate decision ids.
2. Plan mode reads the spec and `standards/`, measures the base (`base-health`), writes the plan. The plan
   check parses the spec's inventory (Data Model and Service Changes rows, named acceptance tests, in-scope
   decisions) and requires each to appear in a plan task that carries `Files:`.
3. Build mode takes the first open task of the `<- NEXT` phase, writes the failing tests first, implements,
   runs the inner-loop checks and commits. When it ticks a phase, `verify-plan-ticks` compares the plan
   before and after: every task done, any `gate:` command exits 0, and every acceptance row of that phase
   bound by `verify-acceptance-bindings` (the named test exists in a file matching `tests.globs`, is not
   skipped, calls something assertion-shaped, and sits at the tagged layer when `tests.layers` is set).
4. The Exit Gate runs `gates.exitGate` (the commands you configured), the bindings for every phase, the
   review subagent once, and, on a red base, `base-health --compare`, which fails only on a *regression* in a
   check's findings relative to the merge-base.
5. Review mode reads the diff once, fixes in slices, buckets findings and, after
   `review.scopeAuditAfterPasses` passes, stops fixing and audits scope.
6. A person ships.

At every commit `.githooks/pre-commit` runs `verify-jira-sync` (a no-op unless `tracker.provider` is `jira`)
and then your `hooks.preCommit` commands.

## Failure modes the design guards against

| Failure | Guard |
|---------|-------|
| The agent ticks a phase it did not finish | `verify-plan-ticks` reverts it (`--fix`) with the reason. |
| A test is named in the spec but is missing, skipped, empty of assertions or at the wrong layer | `verify-acceptance-bindings`; the Exit Gate re-runs it for every phase. |
| A requirement the spec states never reaches the plan | `verify-plan-completeness` (`--strict` fails on it). |
| A red base makes every full run fail for reasons the spec never touched | `base-health` measures the base in a temporary worktree and compares per check. |
| A spec contradicts itself or is structurally incomplete | `lint-spec`, before any planning cost is spent. |
| Tracker writes fail silently mid-run | `JIRA DEGRADED` marker plus the commit-time block. |
| A long job hangs, or its children outlive it | `sweep.mjs` bounds every detached job by time, output stall and optionally memory, kills the whole tree, and writes the verdict into the job log. |
| The machine sleeps mid-run | `lib/keep-awake.cjs`. |
| The supervising session ends and nobody notices | The runner is detached; the skill keeps a `watch` waiter alive and treats a dead runner as something to verify and resume. |
| An unattended agent widens scope | Out-of-scope work is recorded, not done; the five-pass scope audit; `[product]` questions park the spec instead of being guessed. |
| Two loops fight over one index and one plan | One worktree runs one loop; parallel work uses lanes. |
| A subagent runs on an oversized model | `scripts/hooks/require-agent-model.cjs` (a PreToolUse hook) requires an explicit model. |
| The two shells drift apart | All policy is in `ralph/lib/*.mjs`; the shells only launch. |
| A tool works on one OS only | Node everywhere; `spawn` with argv arrays; no `taskkill`/`pkill`. |

## Scope discipline

A spec's Scope section is a boundary the loops respect. Build and review do not widen it. A finding is
bucketed **inside** the spec's scope (fix it), **outside and ship-blocking** (fix it and tag it `[REVIEW: SCOPE]`
with the reason, so the extra scope is visible to a person), or **outside and pre-existing** (record it durably
as a candidate spec, do not fix it here). Only a person widens a spec. [DECISIONS.md](DECISIONS.md) has the
full rules and where each is recorded. The `autonomous` skill applies the scope gate when
a spec parks, and after `review.scopeAuditAfterPasses` review passes on one spec it stops fixing and
produces an audit instead, because a spec that keeps producing findings is usually a spec that has outgrown its
contract. Infrastructure and tooling specs are reported apart from product specs, since they compete for the
same time and a combined report hides how much went to meta-work.

## What is human-only

The kit automates the loop, not the judgement that sits above it.

- **Plan content is not a manual gate.** There is no "approve the plan" step; a plan advances if it covers
  the spec (`verify-plan-completeness`) and each tick is earned (`verify-plan-ticks`). You may read and edit
  it, but nothing waits on you.
- **Approvals and waivers are human-only.** They carry a person's identity, so the prompts forbid the agent
  from signing them and a `[product]` question that needs one parks the spec.
- **Product decisions** (`[product]` open questions) are answered by a person or, where the standards already
  decide, by the supervising skill, which logs the call.
- **Shipping** (merge, release, the ledger's `shipped`) is a person's act.
- **Anything outward-facing or destructive:** infrastructure apply, force push, changes to shared
  environments, skipping hooks. Forbidden in the prompts; enforce with credentials and branch protection too.

## Lanes

The full operating guide is [LANES.md](LANES.md).


A lane is a sibling git worktree on branch `<base>-lane-<name>` with its own queue and runner, created by
`scripts/new-lane.mjs` (`--dry-run` shows the plan). Parallelise specs, never phases of one spec. Each lane needs
its own runtime environment too (ports, databases, test services), not only its own worktree. Merge-back is
manual and checklist-driven (`scripts/lane-merge-notes.mjs`): the lane's plan must already be archived, the
integration plan is kept, ledger rows are merged one by one, and the merge itself needs a person's go-ahead.
Neither script deletes anything.

## Extending the kit

- **A new check:** a script under `scripts/` that exits 0 / 1 / 2 (pass / findings / cannot run), supports
  `--json`, reads its settings from `ralph.config.json`, and has a `test/<script>.test.mjs`. Add it to
  `gates.exitGate` through a `commands` entry, or to `gates.baseHealth.checks` if it should be compared with
  the base.
- **A new rule for the agent:** a file in `standards/` (see `standards/README.md`), not another paragraph in a
  prompt.
- **A different agent:** `agent.command`, `agent.args`, `agent.modelFlag`, `agent.effortFlag`.

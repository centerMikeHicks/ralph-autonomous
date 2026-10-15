# Ralph Conventions

The authoritative reference for the loop: phase sizing, verification tiers, model policy, file
formats, state maps and blocker tags. The three prompts cite this file and do not repeat it. If a
prompt and this file disagree, this file wins.

## 1. The loop in one paragraph

Each iteration is a fresh agent process with no memory. State lives on disk (`.ralph/`, `specs/`) and in
git. One iteration does **one task** (build) or **one planning/review session**, commits, writes
`.ralph/ITERATION_STATUS.json`, and exits. The driver (`ralph/loop.sh` / `loop.ps1`) restarts it.

## 2. Phase sizing

- A spec becomes **3-6 phases**, grouped by concern, not by file. 9+ phases is over-sliced; collapse any
  "two files and a test" phase into a sibling.
- A phase is one reviewable commit's worth of work: one component, route, module or migration plus its
  tests. A task that names two unrelated new units is two tasks; a task that is a single assertion or a
  single string is a fragment - fold it into its unit.
- The **last phase is always the Exit Gate**. It adds no features.
- Acceptance criteria per phase: 3-5 outcome bullets, never invocation detail
  (`Unit tests pass`, not `<runner> --maxWorkers=2`).
- Plan size cap about 150 lines. Completed phases collapse to one line with the commit SHA; detail
  belongs in commit messages.

## 3. Verification tiers

| Tier | When | What runs |
|------|------|-----------|
| Inner loop | every phase except the Exit Gate | only what proves this phase's diff: the phase's tests, plus `commands.affectedTest` (or `commands.test` scoped to the changed files) and a file-level lint/type check when concerned |
| Exit Gate | final phase only | every command named in `gates.exitGate` (default `lint`, `typecheck`, `build`, `test`), the acceptance-binding check, the review subagent once on the full diff |

Rules:

- Never run the full sweep or the review subagent per phase. It multiplies cost and teaches nothing the
  Exit Gate would not.
- A `commands.*` key that is `null` is reported as **not configured**, never as passed. Say so in the
  commit message and `result`.
- Pipe long output through `tail`; report the summary line and failures only.
- A check expected to outlive about 8 minutes runs **detached** through the shared process owner:
  `node scripts/sweep.mjs run --dir .ralph/verify/<name> -- <cmd>` then end the iteration with
  `outcome: "waiting"` naming that `run.log`. Never rely on an in-session background task; it dies with
  the iteration. Never kill a process any other way (`node scripts/sweep.mjs kill`).
- **Red base.** The plan's `## Base health` section records whether the branch the spec forked from
  already fails the gates (`node scripts/base-health.mjs`). If it does, the Exit Gate certifies
  **no regression vs base**: `node scripts/base-health.mjs --compare` is the whole scope. Never
  hand-write a scope ("ignore these failures"). `null` in the table means not measured, not zero.
- Acceptance binding: `node scripts/verify-acceptance-bindings.mjs --spec <S>` must pass before any phase
  ticks and again at the Exit Gate. A row is bound only at the layer its tag names (section 5).
- Plan completeness: `node scripts/verify-plan-completeness.mjs --spec <S> --strict` must pass before
  the plan is marked ready.

## 4. Model policy

Subagents and tasks get the **smallest model that can do the job**; escalate on purpose. Names are the
aliases in `ralph.config.json` `models`.

| Work | Model key | Typical alias |
|------|-----------|---------------|
| Find/list files, simple greps, run a command and report pass/fail, regenerate a table, rename, doc sync to existing code | `mechanical` | haiku |
| Read and reason over code: research, diagnose failures, build a patch, apply a known change, the Exit Gate | `execution` | sonnet |
| New spec design with open trade-offs, root-causing a subtle bug, security review, the final review pass | `planning` / `review` | opus |

The build loop chooses its model from the first unchecked task under the `<- NEXT` phase: a `[haiku]`
(or `[mechanical]`) tag selects the mechanical model, anything else the execution model. Untagged tasks
that start with regenerate / re-run / rename / reformat / sync docs are treated as mechanical; add
`[sonnet]` to opt one out. A task mixing both kinds is two tasks.

Every subagent launch names its `model` (the `require-agent-model` hook blocks a launch that does not,
unless the agent file pins one).

## 5. Formats

### Plan (`.ralph/IMPLEMENTATION_PLAN.md`)

```markdown
# Implementation Plan
## Status: Ready for Build - <spec title>
## Active Spec
`specs/<name>.md`
## Base health
Base `<sha>` (measured <date>) is **GREEN**.     <!-- or: **Base is red.** ... -->
## Standards
- standards/<file>.md           (listed once, referenced by name below)
## Phases
- [ ] **Phase 1: <title>** <- NEXT
  gate: <optional clause>
  - [ ] <task text> [sonnet]
    Files: path/a.ext, path/b.ext (symbols)
    Tests: <acceptance test names copied verbatim from the spec>
- [ ] **Exit Gate**
## Decisions
- D1 - <what was decided, by whom/what rule>
## Waivers
## Open Questions / Blocked
- [ ] `[product]` <question a person must answer>
- [ ] `[tooling]` <defect in the loop's own tooling the build loop fixes>
```

- Phases are `- [ ] **...**` at column 0; tasks are indented `- [ ]`. `<- NEXT` (or the arrow form)
  marks the current phase; exactly one phase carries it.
- Every task carries `Files:` (the planner already did the gap analysis; the builder should not
  re-grep) and `Tests:` (verbatim from the spec, or `[visual-only]` as in the spec).
- `gate: <clause>` on a phase line is an optional machine-checkable definition of done that a
  project-specific verifier may evaluate when the phase is ticked. A phase without a clause is never
  reverted for it.
- A completed phase collapses to one line: `- [x] **Phase 2: <title>** (abc1234)`.
- Decision ids are `D<n>`, minted by incrementing the highest in the spec and plan; never reused.

### Spec acceptance rows

```
- [ ] `[unit|integration|e2e|visual-only]` testName - Given X, When Y, Then Z
```

Bound only at the layer the tag names: `[unit]` any test file; `[integration]` a test that exercises the
real route/page/module boundary the Then describes (not a helper beneath it); `[e2e]` an end-to-end
suite. A test name from the spec must appear verbatim as a test title, un-skipped, with an assertion.
Never weaken an assertion to match what the code produced; if the spec's Then is wrong, record it under
Open Questions with evidence and leave the test failing.

### `ITERATION_STATUS.json`

```json
{ "spec": "<basename>", "phase": "<phase or ->", "mode": "plan|build|review",
  "outcome": "committed|progressed|blocked|failed|waiting|aborted",
  "did": "<one line>", "result": "<one concrete line>", "next": "<one line>",
  "committed": false, "sha": null }
```

One line per string, about 300 characters at most. `committed`/`sha` are cross-checked against HEAD.

### Commit messages

```
<KEY> <imperative summary>

- what changed and why (bullets)

Co-Authored-By: <agent name> <noreply@anthropic.com>
```

`<KEY>` is the bound tracker issue (front matter `tracker_issue`) or, with no tracker, the spec basename.
Tooling fixes use `<KEY> Tooling: <summary>`. Stage by path; never `git add -A`.

## 6. Ledger states vs tracker states

| Ledger state | Set by | Trigger | Jira status (provider `jira`), by name from `tracker.jira.transitions` |
|--------------|--------|---------|------------------------------------------------------------------------|
| `drafted` | `/design` | spec saved | design finalized -> `designFinalized` ("Ready For Development") |
| `planned` | plan | plan ready for build | none |
| `built` | build | Exit Gate committed | exit gate -> `exitGate` ("Review Required") |
| `reviewed` | review | a clean review pass | none |
| `shipped` | **a person** | PR merged / released | a person closes the issue |
| `paused`, `superseded` | a person or `/design` | explicit | none |

The first build iteration transitions to `buildStarted` ("In Progress"). Status names are resolved at call
time; ids are never hard-coded. Only the Exit Gate flips `built`; only a clean review flips `reviewed`;
the row stays in the Active table until a person ships it.

## 7. Blocker tags and what the loop does with them

| Tag | Meaning | Who acts |
|-----|---------|----------|
| `[product]` | What the feature does, a waiver, an approval, a scope or data decision | A person (or the supervising skill if standards decide it). Parks the spec when nothing else is workable. |
| `[tooling]` | A defect in `scripts/`, `ralph/`, the verifiers or the project's own check commands | The build loop fixes it in a dedicated `<KEY> Tooling:` commit with a test, then continues. Never parked, never `outcome: blocked`. |

An untagged open question is treated as `[product]`. Hitting the same blocker twice is the signal for a
person to step in; say "same blocker as last iteration" in `result`.

## 8. Review findings: scope buckets

Every review finding is placed against the spec's own stated boundary (Problem Statement and Scope):

1. **Inside** the boundary: fix it properly now.
2. **Outside and ship-blocking** (the deliverable would be unsafe or wrong without it, typically because
   this spec created the gap): fix it and tag it `[REVIEW: SCOPE]` with one line on why it could not wait.
3. **Outside and pre-existing** (true before this spec touched anything): do not build it inline. Record a
   candidate spec or ticket, state the residual risk, and move the review on.

After `review.scopeAuditAfterPasses` (default 5) review passes on one spec, stop fixing and produce a
scope audit: every finding from all passes bucketed as above, surfaced as one batched decision.

## 9. Things an agent never does

Sign approvals or waivers (they need a person's identity); run infrastructure apply/destroy; force
push or rewrite shared history; touch shared environments or data outside the worktree; skip hooks
(`--no-verify`); commit secrets; widen the spec's scope; discard changes it did not make
(`checkout --`, `restore`, `stash`, `reset --hard` on paths it did not edit).

## 10. Plan and spec hygiene

- Standards are listed once at plan level. Decisions the loop makes are recorded under `## Decisions`
  with a `D<n>` id so a reviewer can find them.
- Documentation tasks are tagged `[DOC]`, scheduled after the code they document, and mechanical by default.
- Tests are required for new exported functions, routes, hooks and non-trivial utilities; not for type
  definitions, static config, or thin wrappers that only delegate.

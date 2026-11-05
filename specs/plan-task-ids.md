---
title: Stable ids on plan tasks
tracker_issue: KAI-70
---

# Stable ids on plan tasks

## Overview

The loop's plan lists phases and, under each, tasks. Kairos holds every version of the plan and the
ticks the loop has earned, and a person can edit the plan there. Today the loop matches a tick to a
task by the task's words, so a task that is reworded (by a person in Kairos, or by the planner when
it refines a plan) loses its tick when the loop next takes the plan in. This spec gives each task a
stable id written at the start of its line (`P2.T3`), sends the id to Kairos beside the task's words,
matches ticks by id first, and makes the plan checks report a missing or repeated id. Plans written
before this, with no ids, keep working exactly as they do now. Kairos's side, keeping a task by its
id across versions, is KAI-69; until it is live Kairos drops the id, which is harmless.

## Problem Statement

### Current State

- `withTicks` in `ralph/lib/kairos.mjs` ticks a line of the plan Kairos returns when its words, after
  `lineWords` strips the checkbox, model tag, NEXT marker and commit, equal the words of a line done
  in the local copy or of a done task Kairos reports. A reworded task matches nothing and comes back
  unticked. It runs in `syncPlan` (`ralph/lib/run-loop.mjs`) whenever a person changed the plan in
  Kairos, and on a fresh copy.
- `planForKairos` sends each task as `{ text, done, commit }`. Kairos stores tasks the same way
  (`packages/core/src/plans.ts` in Kairos, which maps a posted task to `text`, `done` and `commit` and
  drops anything else).
- `ralph/PROMPT_plan.md` and `ralph/CONVENTIONS.md` section 5 say nothing about task ids, and
  `ralph/PROMPT_build.md` Step 7 tells the builder to collapse a finished task to one line with its
  SHA, which today keeps only its words.
- `isMechanicalTask` in `ralph/lib/plan-parse.mjs` reads a task's first words to choose the mechanical
  model (`regenerate`, `rename`, `[DOC]` ...), so a leading id would hide them.
- `scripts/verify-plan-ticks.mjs` matches phases by their `Phase N` key and never matches tasks by
  their words; it is not changed (D4).

### Desired State

Every task the planner writes starts with an id of the form `P<n>.T<m>` (Exit Gate tasks `EG.T<m>`).
The id never changes when the task is reworded, reordered or moved to another phase, and is never
reused; the parts of a split task get new ids. The loop sends the id with each task, keeps a tick by
id when the words change, chooses the model from the words after the id, and the plan check reports a
task with no id (in a plan that has ids) or an id used twice.

### Success Criteria

- [ ] SC1: A task reworded in the version of the plan the loop takes from Kairos keeps its tick when its id is unchanged.
- [ ] SC2: The plan sent to Kairos carries each task's id separately from its words.
- [ ] SC3: A plan with no task ids is sent, ticked and checked exactly as it is today.
- [ ] SC4: Under `--strict`, the plan completeness check fails a plan where some tasks have an id and others do not, or where an id is used twice, naming the lines.
- [ ] SC5: The planner is told to write ids and the builder to keep them, and the model choice reads the words after the id.

## Scope

### In Scope

- Reading a task's leading id, in the loop (`ralph/lib/plan-parse.mjs`) and in the checks (`scripts/lib/spec-parse.mjs`).
- Sending the id in `planForKairos`, and matching ticks by id in `withTicks`.
- The model choice skipping a leading id.
- Id findings in `scripts/verify-plan-completeness.mjs`.
- The plan prompt, the build prompt, the conventions, the Kairos tracker notes and the docs that show the plan format.

### Out of Scope

- Kairos keeping tasks by id across versions: KAI-69, in the Kairos repository.
- `scripts/verify-plan-ticks.mjs`: unchanged, by the owner's decision (D4).
- Checking that an id is never reused across versions: the loop sees only the plan on disk, and Kairos holds the history (KAI-69).
- Naming task ids in commit messages or iteration status: not asked for.
- Copying the change into Demiurge: a manual step after release (D5).
- Changing phase ids: phases keep their `Phase N` key.

### Dependencies

- KAI-69 holds this item's release, not its build: Kairos drops a task id it does not know, so ids keep ticks across a person's edits only once KAI-69 is live. Everything here can be built and tested before then.
- Three tests already fail on `main` (`b3cb7ea`), one each in `test/verify-plan-completeness.test.mjs`, `test/lint-spec.test.mjs` and `test/example-project.test.mjs`. The build must not add to them.

## Technical Design

### Architecture Overview

```
planner ──writes──▶ .ralph/IMPLEMENTATION_PLAN.md ("  - [ ] P2.T3 Add the list [sonnet]")
                         │
   run-loop reportPlan ──┼──▶ planForKairos ──▶ POST /run/events { plan: { phases: [{ tasks: [{ id, text, done, commit }] }] } }
   run-loop syncPlan ◀───┼─── withTicks(markdown from Kairos, local copy, Kairos phases): tick by id, else by words
   model-select ─────────┼──▶ nextTask ─▶ isMechanicalTask (reads the words after the id)
   verify-plan-completeness ▶ MISSING ID / REPEATED ID findings (--strict fails)
```

The id is part of the plan's text, so nothing new is stored: the markdown carries it, and the task
object sent to Kairos gains an optional field. `ralph/lib/` cannot import from `scripts/lib/` (the
loop runs where the kit's scripts may not be shipped, see `ralph/lib/load-config.mjs`), so each side
has its own copy of the id pattern, and a test holds the two to the same answers (D6).

**The id.** `TASK_ID = /^(P\d+[a-z]?|EG)\.T\d+$/`: `P` and the phase number the task was first
planned in (a lettered phase such as `1a` is allowed, as `phaseId` allows it), or `EG` for the Exit
Gate, then `.T` and a number. It is the first word after the checkbox, followed by a space. Anything
else (`P2-T3`, `p2.t3`, `P2.T3x`, `Phase 2`) is not an id, and the line is read as a task with no id.

**Matching ticks (D7).** A line in the incoming markdown is ticked when it is an open checkbox and:
- it has an id, and a done task (in the local copy, or in Kairos's phases) has that id; or a done task
  *with no id* has the same words (Kairos before KAI-69 returns its tasks without ids);
- it has no id, and a done task has the same words, as today.

A done task with an id never ticks a line with a different id, even when their words match.
Phase lines are matched by their words, as today.

### Data Model

| Item | Change |
|------|--------|
| `.ralph/IMPLEMENTATION_PLAN.md` task line | new, optional: a leading id `P<n>.T<m>` or `EG.T<m>` before the task's words |
| `planForKairos` task object | changed: gains `id` (string) when the line has one; `text` is the words without the id; no `id` key when the line has none |

### API Design

- `splitTaskId(text) → { id: string | null, words: string }` in `ralph/lib/plan-parse.mjs`: the
  leading id of a task's text and the words after it. `words` is `text` unchanged when there is no id.
- `taskIdOf(text) → string | null` in `scripts/lib/spec-parse.mjs`: the same reading, for the checks.
- `planForKairos(planText)`: each task is `{ id?, text, done, commit }`.
- `withTicks(markdown, localText, phases)`: unchanged signature; matching as above. `phases[].tasks[]`
  may carry `id` (Kairos after KAI-69) or not.
- `isMechanicalTask(task)`: reads `splitTaskId(task).words`.
- `checkPlanCompleteness(specText, planText)` gains `missingIds: [{ line, text }]` and
  `repeatedIds: [{ id, lines }]`; both count as findings. The CLI prints `MISSING ID   plan:<line>  <text>`
  and `REPEATED ID  <id>  plan:<lines>`, and `--json` includes both lists.
- **Events.** The `plan` event the driver sends to Kairos (`POST /run/events`) carries the task id. No
  new event. Delivery stays as it is: queued in the outbox, sent in order, safe to send twice.
- **Permissions and access.** N/A: no new access. The run key and what it may do are unchanged.
- **External tool exposure.** The only outside surface is the `plan` event above; the change is one
  optional field. Kairos today drops it; KAI-69 makes it keep it.

### Service Changes

| Component | Change |
|-----------|--------|
| `ralph/lib/plan-parse.mjs` | new `splitTaskId` and `TASK_ID`; `isMechanicalTask` reads the words after the id |
| `ralph/lib/kairos.mjs` | `lineWords` drops a leading id; `planForKairos` sends `id`; `withTicks` matches by id first |
| `scripts/lib/spec-parse.mjs` | new `taskIdOf`, the same pattern as `splitTaskId` |
| `scripts/verify-plan-completeness.mjs` | `missingIds` and `repeatedIds` findings, printed and counted under `--strict` |
| `ralph/PROMPT_plan.md` | Step 4: write an id on every task; keep ids when refining; add ids to a plan that has none |
| `ralph/PROMPT_build.md` | Step 7: keep the task's id when collapsing it to one line |
| `ralph/CONVENTIONS.md` | section 5: the id format and its rules, in the plan example |
| `ralph/TRACKER_kairos.md` | "The plan": a reworded task keeps its id; a split task's parts get new ids |
| `docs/ARCHITECTURE.md` | [DOC] how a tick follows a task's id to Kairos |

### Decisions

**D1 — The id leads the task's words**
  The id is the first word after the checkbox: `- [ ] P2.T3 Add the list [sonnet]`, and a collapsed task
  reads `- [x] P2.T3 Add the list (abc1234)`. The owner chose it ("Leading, plain"), over a backticked id or a
  trailing `{#P2.T3}` tag. Ships in phase 1.

**D2 — The format is `P<n>.T<m>` only**
  `P` and the number of the phase the task was first planned in, kept when the task moves; `EG.T<m>` for
  the Exit Gate; a new task takes the next unused number in its phase; a split task's parts get new ids
  and the old one is retired. The owner chose it over a loose token. Ships in phase 1.

**D3 — A plan with some ids must have them all**
  A plan with no ids passes. If any task has an id, a task without one is a finding, and a repeated id
  is always a finding; both fail `--strict`, so the plan cannot be marked Ready and Kairos shows it as
  not complete. The owner chose it over advisory findings. Ships in phase 3.

**D4 — The tick check is not changed**
  `scripts/verify-plan-ticks.mjs` matches phases by key and never matches tasks by words. The owner chose
  to leave it unchanged rather than add a lost-tick check. Out of scope.

**D5 — The Demiurge copy is a manual release step**
  The kit is copied into Demiurge by hand (Demiurge's D85), with Demiurge's `ralph/VERSION` naming the kit
  commit, once KAI-69 is live. The loop cannot write another repository, so this is not built here: out of scope for the build.

**D6 — Two copies of the id pattern, held together by a test**
  `ralph/lib/` does not import from `scripts/lib/`, so `splitTaskId` and `taskIdOf` each hold the pattern,
  and one test runs the same examples through both. Is built in phase 3.

**D7 — A tick follows the id, and words only where an id is missing**
  As in Matching ticks above: a line with an id is ticked by that id, or by the words of a done task that
  has no id; a line with no id is ticked by words. A done task never ticks a line with a different id.
  This keeps ticks with Kairos before KAI-69, whose tasks have no ids. Ships in phase 2.

**D8 — A refined plan with no ids gets them**
  When the planner refines a plan whose tasks have no ids, it gives every task one, so the plan does not
  become a mix that D3 rejects. The words sent to Kairos are unchanged, so no tick is lost. Ships in phase 4.

  ### UI

  N/A: the kit has no user interface. The plan is markdown that people read in Kairos and in the file.

  ### Agentic and Conversational Behaviour

  The loop's agents gain no new power. The planner writes ids, as it already writes `Files:` and model
  tags; the builder keeps them. The driver, not the agent, sends the plan and matches ticks, as today.
  A person can still edit any task, id included, in Kairos; a removed id falls back to words, and a
  repeated one is reported by the plan check.

  ### Analytics, Flags and Configuration

  - Outcome: a reworded task keeps its tick. No event is added: Kairos records each plan version and its
    ticks, which shows it.
  - Flag or kill switch: none. The change is additive, plans without ids are unchanged, and Kairos drops
    an id it does not know.
  - Configuration: none. The id format is fixed by D2.

  ### Migration and Rollback

  - Additive. Existing plans have no ids and are read, sent, ticked and checked as before (SC3). A plan
    gains ids when it is next written or refined (D8).
  - Order: build and merge here; then, once KAI-69 is live, the owner copies the kit into Demiurge (D5).
    Until KAI-69 is live, ids are kept in the markdown and dropped from Kairos's task objects; ticks are
    still kept by words.
  - Rollback: revert the merge. A plan that already has ids still works with the older kit: the id is
    read as part of the words on both sides, so ticks still match by words, and only a reworded task
    loses its tick, as today.
  - Manual step: copying into Demiurge, by the owner (D5).

## Implementation Plan

### Phase 1: Reading a task's id

`splitTaskId` and `TASK_ID` in `ralph/lib/plan-parse.mjs` (D1, D2), and `isMechanicalTask` reading the
words after the id. Tests in `test/driver-plan-model.test.mjs`.

**Acceptance Tests**

- [ ] `[unit]` splitTaskIdReadsLeadingId — Given `P2.T3 Add the list [sonnet]`, When split, Then the id is `P2.T3` and the words are `Add the list [sonnet]` (SC2)
- [ ] `[unit]` splitTaskIdAcceptsExitGateAndLetteredPhases — Given `EG.T1 Run the gate` and `P1a.T2 Fix it`, When split, Then the ids are `EG.T1` and `P1a.T2` (SC2)
- [ ] `[unit]` splitTaskIdIgnoresWhatIsNotAnId — Given `Phase 2 work`, `P2-T3 x`, `p2.t3 x`, `P2.T3x x` and `Add the list`, When split, Then each has no id and its words are the text unchanged (SC3)
- [ ] `[unit]` mechanicalTaskSeenPastItsId — Given `P3.T1 regenerate the table` and `P3.T2 Add the route [sonnet]`, When isMechanicalTask reads each, Then the first is mechanical and the second is not (SC5)

### Phase 2: Sending ids and keeping ticks by them

`lineWords` drops a leading id; `planForKairos` sends `id` beside `text`; `withTicks` matches as D7
says. All in `ralph/lib/kairos.mjs`; tests in `test/driver-kairos.test.mjs`.

**Acceptance Tests**

- [ ] `[unit]` planForKairosSendsTaskIds — Given a phase with `- [x] P2.T1 Add the list (def5678)` and `- [ ] P2.T2 Add the filter`, When planForKairos reads it, Then its tasks are `{ id: 'P2.T1', text: 'Add the list', done: true, commit: 'def5678' }` and `{ id: 'P2.T2', text: 'Add the filter', done: false, commit: null }` (SC2)
- [ ] `[unit]` planForKairosOmitsIdWhenNone — Given a plan whose tasks have no ids, When planForKairos reads it, Then each task is `{ text, done, commit }` with no `id` key (SC3)
- [ ] `[unit]` rewordedTaskKeepsItsTick — Given a local line `- [x] P2.T3 Add the list (abc1234)` and an incoming line `- [ ] P2.T3 Add the list and its empty state`, When withTicks merges them, Then the incoming line is ticked (SC1)
- [ ] `[unit]` kairosTaskIdTicksRewordedLine — Given Kairos phases with a done task `{ id: 'P1.T2', text: 'Old words' }` and an incoming line `- [ ] P1.T2 New words`, When withTicks merges them, Then the line is ticked (SC1)
- [ ] `[unit]` sameWordsUnderAnotherIdStayOpen — Given a local line `- [x] P2.T3 Add the list` and an incoming line `- [ ] P2.T5 Add the list`, When withTicks merges them, Then the incoming line stays unticked (SC1)
- [ ] `[unit]` unnumberedDoneTaskTicksLineWithId — Given Kairos phases with a done task `{ text: 'Add the table' }` and no id, and an incoming line `- [ ] P1.T1 Add the table`, When withTicks merges them, Then the line is ticked (SC3)
- [ ] `[integration]` personsRewordKeepsTickThroughTheLoop — Given a run whose local plan has `P1.T1` ticked and a Kairos stand-in that returns a person's version rewording `P1.T1`, When the loop takes the plan in and then reports it, Then the plan file has `P1.T1` ticked with the person's words and the reported plan's task carries `id: 'P1.T1'` and `done: true` (SC1, SC2)

### Phase 3: Id findings in the plan check

`taskIdOf` in `scripts/lib/spec-parse.mjs` (D6), and the `missingIds` and `repeatedIds` findings in
`scripts/verify-plan-completeness.mjs` (D3). Acceptance-test rows, phase lines, and rows under
`## Open Questions / Blocked`, `## Decisions` and `## Waivers` are not tasks and need no id. Tests in
`test/verify-plan-completeness.test.mjs`, and one in `test/spec-parse.test.mjs`.

**Acceptance Tests**

- [ ] `[unit]` planWithoutIdsHasNoIdFindings — Given a plan whose tasks have no ids, When checkPlanCompleteness reads it, Then `missingIds` and `repeatedIds` are empty (SC3)
- [ ] `[unit]` mixedPlanReportsTaskWithoutId — Given a plan with `P1.T1 Add the list` and a task `Add the filter` with no id, When checkPlanCompleteness reads it, Then `missingIds` names the second task's line (SC4)
- [ ] `[unit]` repeatedIdReported — Given a plan where `P2.T3` starts two tasks, When checkPlanCompleteness reads it, Then `repeatedIds` holds `P2.T3` with both lines (SC4)
- [ ] `[unit]` testRowsAndOpenQuestionsNeedNoId — Given a plan with ids on every task, plus acceptance-test checkbox rows, phase lines and Open Questions rows with no ids, When checkPlanCompleteness reads it, Then `missingIds` is empty (SC4)
- [ ] `[unit]` taskIdParsersAgree — Given the same list of task texts, When splitTaskId and taskIdOf read each, Then both give the same id, or none, for every one (SC2, SC3)
- [ ] `[integration]` strictFailsOnIdFindings — Given a spec and a plan with a repeated id, When `verify-plan-completeness.mjs --spec S --strict` runs, Then it exits 1 and prints `REPEATED ID`, and without `--strict` it exits 0 (SC4)

### Phase 4: Telling the planner and the builder

`ralph/PROMPT_plan.md` Step 4 (write ids, keep them when refining, add them to a plan with none: D8),
`ralph/PROMPT_build.md` Step 7 (keep the id when collapsing), `ralph/CONVENTIONS.md` section 5 (format
and rules, in the plan example), `ralph/TRACKER_kairos.md` ("The plan"), and a [DOC] note in
`docs/ARCHITECTURE.md`. Tests in `test/driver-prompt.test.mjs`.

**Acceptance Tests**

- [ ] `[unit]` planPromptAsksForTaskIds — Given `ralph/PROMPT_plan.md` and `ralph/CONVENTIONS.md`, When read, Then each names the `P<n>.T<m>` and `EG.T<m>` format, says an id is never reused or renumbered, and that a split task's parts get new ids (SC5)
- [ ] `[unit]` conventionsPlanExampleCarriesIds — Given the plan example in `ralph/CONVENTIONS.md` section 5, When its task lines are read with splitTaskId, Then every task has an id (SC5)
- [ ] `[unit]` buildPromptKeepsIdWhenCollapsing — Given `ralph/PROMPT_build.md`, When Step 7 is read, Then it says to keep the task's id when collapsing it to one line (SC5)

## Edge Cases

- A person removes a task's id in Kairos: the line is matched by its words, as today, and the plan check reports it as missing if other tasks have ids.
- A person gives two tasks the same id: `withTicks` ticks both if that id is done; the plan check reports the repeat, and the plan cannot be marked Ready until it is fixed.
- A task moves to another phase: it keeps its id (`P2.T3` under Phase 3); matching ignores the phase.
- A task is split: its parts get new ids and start unticked unless their words match a done task with no id.
- A phase is collapsed to one line: its tasks leave the local copy, and Kairos keeps them (its `mergePhases`), as today.
- A line starting with something like an id (`P2-T3`, `Phase 2`) is read as a task with no id.
- Kairos before KAI-69 returns tasks with no ids: lines with ids are ticked by their words through D7, so no tick is lost compared with today.
- An empty or placeholder plan: unchanged, `planIsWritten` stops it being sent.

## Security Considerations

No new access, secret or personal data. The id is plan text the loop already sends to Kairos with the
run key it already holds. Ids come from the plan, which a person may edit, so they are matched only
against `TASK_ID` and never used as a path, command or key.

## Testing Strategy

- Unit tests carry the reading of ids, the tick matching and the findings: pure functions over plan text.
- One integration test runs the loop with the existing Kairos stand-in in `test/driver-kairos.test.mjs`
  to show a person's reword reaching the plan file and the next report. Kairos itself is faked: KAI-69
  is not live, and the stand-in returns tasks both with and without ids.
- One integration test runs the completeness CLI on a fixture.
- The existing tests for `planForKairos`, `withTicks` and the completeness check stay unchanged and
  passing, which shows SC3.
- The Exit Gate is `npm test`. Three tests already fail on `main` (see Dependencies), and the build must not add to them.

## Open Questions

- [ ] `[tooling]` `test/verify-plan-completeness.test.mjs` already has one failing test on `main`. The build should say whether a new row there is affected by it, and leave the existing failure as it is.

## References

- KAI-69 — Kairos keeps plan tasks by a stable id (holds this item's release).
- `ralph/lib/kairos.mjs` (`planForKairos`, `withTicks`, `lineWords`), `ralph/lib/run-loop.mjs` (`syncPlan`, `reportPlan`).
- `ralph/lib/plan-parse.mjs` (`isMechanicalTask`, `nextTask`), `scripts/lib/spec-parse.mjs` (`parsePlan`).
- `scripts/verify-plan-completeness.mjs`, `scripts/verify-plan-ticks.mjs`.
- Kairos `packages/core/src/plans.ts` (task shape, `mergePhases`).
- `.kairos/experiments.md` (how kit items are built; the Demiurge copy).

# Decisions and scope

An unattended loop makes decisions while nobody is watching. This page covers who is allowed to decide
what, how the loop keeps to a spec's scope, where every decision is written down, and how a person
reviews and overturns them.

## Who decides what

| Kind of decision | Who makes it | What the others do |
|------------------|--------------|--------------------|
| What the feature is: behaviour, scope, priorities, data, anything a customer would notice | **A person**, in the `/design` interview or by answering an Open Question | The loop records the question as `[product]` and stops that task; the supervisor parks the spec |
| Approvals and waivers | **A person**, always. They carry a name. | Loops and the supervisor may list a candidate waiver; they never apply or sign one |
| Anything outward-facing: merging, releasing, infrastructure, shared environments, data outside the worktree, spending | **A person** | Forbidden in every prompt; enforce it with credentials and branch protection as well |
| A gap the spec did not foresee, where the project's `standards/`, a recorded user decision or an existing pattern gives the answer | **The supervising skill** (`autonomous`), and it says so | Recorded in the spec or plan, tagged `[REVIEW]`, and listed for the person |
| How to build what the spec asks: where code goes, which pattern, how to split a task | **The loop** (plan or build mode) | Recorded as a plan decision `D<n>` with the rule that decided it |
| A defect in the loop's own tooling (a verifier that mis-parses, a broken check command) | **The build loop** fixes it | A separate `<KEY> Tooling:` commit with a test, never a blocker |

The line is drawn at standards. A call the written standards already make is the supervisor's to make
and log. A call they do not make is a person's. This is why writing standards down pays off twice: every
rule in `standards/` is a finding review stops making and a question the loop stops parking on.

## Scope rules

A spec's **Problem Statement**, **Scope** (In / Out of Scope) and **Success Criteria** are a boundary.
Loops never widen it. Every finding from build or review is placed against that boundary before anyone
decides what to do with it:

| Bucket | Test | What happens | Where it is recorded |
|--------|------|--------------|----------------------|
| **Inside** the boundary | The spec asked for it, or it is wrong in code this spec wrote | Fixed now, properly, with a test | The fix commit |
| **Outside, ship-blocking** | Outside the stated scope, but this spec's deliverable would be unsafe or wrong without it, usually because this spec created the gap | Fixed now, and flagged: the extra scope is a judgement call a person should see | `[REVIEW: SCOPE]` in the commit message and the talk log, with one line on why it could not wait |
| **Outside, pre-existing** | It was true before this spec touched anything | **Not built.** Recorded as a candidate spec or ticket, with the residual risk | A `[product] CANDIDATE-SPEC:` row in the plan's Open Questions; with Jira, also the review comment or a new linked issue |

So, in practice:

- **The loop files it instead of building it** when the problem predates the spec. Deferring is the
  correct handling there, not a shortcut: "fix it properly" and "fix it here" are different questions.
- **The loop builds beyond the spec only when the spec's own deliverable depends on it**, and every such
  case is tagged `[REVIEW: SCOPE]` so you can see how much went outside the lines.
- **The spec itself is expanded only by a person.** The supervisor may amend a spec to record a decision
  the standards make (tagged `[REVIEW]`), but it never adds scope. Widening a spec is one of the answers
  you give to a scope audit, not something the loop does.
- **Review that will not converge stops.** After `review.scopeAuditAfterPasses` passes (default 5) the
  review loop stops fixing, lists every finding from every pass with its bucket, and asks one batched
  question: accept the residual risk, file follow-up specs, or widen the spec. The queue runner also
  parks a spec at `queue.maxReview` passes (default 8) whatever happens. A review that keeps finding new
  work is almost always a spec that has outgrown its contract.
- **A spec that needs a person parks; the queue moves on.** Unanswered `[product]` questions park only
  the spec they belong to.

## Where decisions are recorded

| Record | Written by | What it holds | Committed? |
|--------|-----------|---------------|------------|
| Spec `### Decisions` (`**D<n> — title**`) | `/design`, with you | Choices made in the interview: the decision, what was rejected, why | Yes |
| Spec `## Open Questions` | `/design`, the loop, the supervisor, you | Questions and their answers. Entries are ticked when settled and **kept**, with who decided and when, so the section becomes the spec's decision log. Agent-made answers carry `[REVIEW]`. | Yes |
| Plan `## Decisions` (`- D<n> - ...`) | plan and build loops | How-to-build calls, each with the rule that decided it | Yes (the plan is committed with each slice) |
| Plan `## Open Questions / Blocked` | plan, build and review loops | `[product]` questions, review findings left for a person (`REVIEW: file:line`), `CANDIDATE-SPEC:` rows | Yes |
| Commit messages | build and review loops | What changed and why; `Tooling:` commits; `[REVIEW: SCOPE]` notes | Yes |
| `.ralph/PROGRESS.md` | review loop | One entry per review pass: what was fixed, what is left in each bucket | Usually not |
| Talk log (`.claude-temp/<topic>/TALK.md`) | the supervising skill | `[REVIEW]`, `[REVIEW: SCOPE]` and `[ASK]` entries, each with the rule, where it is recorded and how to undo it | Usually not: it is the index, and every entry that matters is also in the spec or plan |
| Queue file (`.claude-temp/ralph-queue/QUEUE.md`) | the queue runner | Why each parked spec stopped | No |
| Jira (when enabled) | every mode | Status transitions and one comment per milestone and per review pass, including deferred findings | In Jira |

Ids are stable: `D<n>` is minted by incrementing the highest id in the spec and plan, and never reused,
so "D7" means the same thing in a commit, a review comment and a conversation.

## Reviewing what was decided

One command gathers all of it:

```bash
node scripts/ralph-decisions.mjs                  # everything on this branch that you have not reviewed
node scripts/ralph-decisions.mjs --spec my-spec   # one spec
node scripts/ralph-decisions.mjs --since 2026-10-14 --all   # include entries already marked reviewed
node scripts/ralph-decisions.mjs --json           # for a dashboard or a PR description
```

```
NEEDS YOU (3)  - answer it, then set the queue line back to [ ] or tick the question
  parked        specs/export-flag.md — blocked in build: [product] should --verbose include timings?   .claude-temp/ralph-queue/QUEUE.md:2
  finding       `[product]` REVIEW: src/auth/token.ts:41 - compare is not constant-time (outside-ship-blocking)   .ralph/IMPLEMENTATION_PLAN.md:48
  question      `[product]` Q6 — open, blocks no phase: restrict invitations to verified domains?   specs/team-invitations.md:405

DECIDED FOR YOU (3)  - read each; mark it [REVIEWED] when you accept it, or change it
  agent call    `[product]` `[REVIEW]` Q4 — decided by the supervising agent from standards/security/...   specs/team-invitations.md:403
  plan decision D11 - expiry sweep runs in the existing job scheduler (standards/jobs.md)   .ralph/IMPLEMENTATION_PLAN.md:39
  tooling       4f2a91c team-invitations Tooling: freeze the database clock in the test harness   commit

DEFERRED (1)  - findings outside the spec, recorded instead of built: file a spec or accept the risk
  candidate     `[product]` CANDIDATE-SPEC: audit export has no paging (outside, pre-existing)   .ralph/IMPLEMENTATION_PLAN.md:51
```

A routine for coming back after a run:

1. **NEEDS YOU first.** Answer each question where it lives (tick it in the spec's Open Questions with
   your answer and the date, or write it in the decisions file the supervisor reads), then set the parked
   queue line back to `- [ ]`. The runner resumes from the ledger.
2. **DECIDED FOR YOU next.** Read each entry with the rule it cites. If you agree, change its `[REVIEW]`
   tag to `[REVIEWED]` (or append `[REVIEWED]` to a plan decision) and it drops out of the report. If you
   do not, overturn it (below).
3. **DEFERRED last.** File the candidate specs you want, and accept the risk on the rest by ticking them
   with a note.
4. **Then the diff.** Open the draft pull request. The report tells you where the judgement calls are, so
   you can read those parts of the diff closely and skim the rest.

Pasting the report into the pull request description gives the reviewer the same map.

## Overturning a decision

| When | How |
|------|-----|
| Before the plan is built | Edit the spec (or the plan decision) and re-run plan mode, or let the queue re-plan. |
| While building | Change the decision in the spec's Open Questions or the plan's `## Decisions`, add a task to the plan for the change if code already depends on it, and re-queue the spec. The next iteration reads the new answer; nothing else remembers the old one. |
| After the spec is built or reviewed | Treat it as a change to the contract. Edit the spec (by hand or with an agent in an interactive session): a new `D<n>`, a dated Open Questions entry saying what changed and why, and acceptance rows for the new behaviour. Set the ledger row back to `drafted`; plan mode then refines the existing plan, keeping finished phases, and build and review carry the change. |
| A pattern of wrong calls | Write the rule into `standards/`. Every later spec, plan and review reads it, so the same call is made your way from then on. |

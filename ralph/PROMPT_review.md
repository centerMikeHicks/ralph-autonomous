# Ralph Loop: REVIEW MODE

You are one iteration of a **stateless Ralph loop**. Your context is fresh; your memory is the files
on disk and git. You review the whole spec's diff once against the spec and `standards/`, fix what is
safely fixable, record what is not, and advance the ledger only on a clean pass.

`ralph/CONVENTIONS.md` is authoritative (scope buckets, blocker tags, formats). It wins on conflict.
The driver may prepend the previous iteration's status, files last changed, and, when a tracker is
configured, a tracker block. They are already read.

## Before you stop: write `.ralph/ITERATION_STATUS.json` (every iteration, unconditional)

Overwrite with one Bash heredoc as your last action:

```json
{
  "spec": "<active spec basename, no .md>",
  "phase": "Review - full spec | Review - fixes slice 2",
  "mode": "review",
  "outcome": "committed | progressed | blocked | failed | waiting | aborted",
  "did": "<one line>",
  "result": "<one line, concrete: 'clean pass, ledger reviewed' or '3 fixed, 2 left (1 inside, 1 outside/pre-existing)'>",
  "next": "<one line>",
  "committed": false,
  "sha": null,
  "exit_gate": "passed | not-yet",
  "anchors": ["<optional, up to 5: 'path:a-b - what'>"]
}
```

`exit_gate: "passed"` only when the spec's Exit Gate is genuinely met and the branch is ready for a
person: findings closed, every check run. Anything less ("probably fine", an unrun check) is `not-yet`.
Strings are one line, about 300 characters; `committed`/`sha` must match HEAD movement.
`blocked` = a finding needs a human decision; put why in `result`.

## Hard rules

- Review the **whole diff once**, then fix in slices of about 120 tool calls; commit each slice and exit.
  At about 150 calls without a commit, commit what passes and name what is left.
- Uncommitted work from a previous iteration comes first: finish, verify and commit it before reviewing.
  Never discard a change you did not make.
- Fix trivial and in-scope issues properly (root cause, no band-aids). Do **not** make architectural
  changes, refactor working code for taste, or fix a security-sensitive finding without recording it
  for a person's confirmation.
- Never sign approvals or waivers, run infrastructure apply, force push, touch shared environments,
  skip hooks, commit secrets, or widen the spec's scope. Stage by path, never `git add -A`.
- Review subagents run once per spec state, not once per iteration: if the previous iteration's
  findings are still open (see status and the plan's Open Questions), fix the next ones instead of
  re-running them.
- Batch independent tool calls in one response.

## Step 1: Current state (one batched call)

`git status --short; git diff --stat <base>...HEAD; git log --oneline -15`, plus the plan's
`## Open Questions / Blocked`, the spec's Scope and Success Criteria, and `.ralph/PROGRESS.md` top.
`<base>` is `project.baseBranch`'s merge-base. Count prior review passes for this spec from
`.ralph/iterations.jsonl` (mode `review`).

**If this is pass `review.scopeAuditAfterPasses` or later (default 5):** stop fixing. Produce the
scope audit (Step 7) and exit `blocked` with the batched decision in `result`.

## Step 2: Read the diff once

Read the full diff against the spec. Questions, in order:
1. Does every Success Criterion and acceptance row have working behaviour behind it (not just a test)?
2. Is anything built that the spec did not ask for (scope creep)? Anything the spec asked for missing?
3. Is new code reachable (called from a route/page/entrypoint), or merely exported?
4. Correctness: error paths, empty inputs, concurrency, boundaries, resource cleanup.
5. Security and access: input validation, authorization on every new entry point, secrets, injection.
6. Tests: do they assert the spec's Then, at the tagged layer, or only that code ran?
7. Compatibility: migrations reversible or additive, configuration documented, no breaking change unmarked.

## Step 3: Run the checks

Run the Exit Gate commands from `gates.exitGate` (a `null` command is "not configured", never green),
`node scripts/verify-acceptance-bindings.mjs --spec <S>`, `node scripts/verify-plan-completeness.mjs
--spec <S>`, and, if the plan says **Base is red**, `node scripts/base-health.mjs --compare`. For
anything long, run detached via `node scripts/sweep.mjs run ...` and end `waiting`.

Run the review subagent once, `model` from `models.review`:

```
Task: subagent_type: <gates.reviewSubagent>
prompt: "Review the diff for spec <name> against standards/ and the spec's Scope. Return findings with
severity (critical|warning|info), scope bucket (inside | outside-ship-blocking | outside-pre-existing),
and file:line."
```

If the diff touches a surface a `standards/` file covers (UI, API, data, security, agent behaviour),
the subagent reads that file; name the surfaces in the prompt.

## Step 4: Bucket every finding by scope

Place each finding against the spec's own stated boundary before deciding what to do:

- **Inside** the boundary: fix it now, properly.
- **Outside and ship-blocking** (this spec's deliverable is unsafe or wrong without it, typically
  because this spec created the gap): fix it, tag it `[REVIEW: SCOPE]` with one line on why it
  could not wait.
- **Outside and pre-existing** (true before this spec): do **not** build it. Record a candidate spec or
  ticket under Open Questions as `[product] CANDIDATE-SPEC: ...`, state the residual risk, and move on.
  It is deferred safely only if something durable holds it: the tracker (when configured) and the
  plan's Open Questions. A deferred finding that lives only in this chat is lost.

Do not convert a finding into a fix before it has a bucket. A pass that only fixes warnings the
previous pass's own fix introduced means the work has left the spec's boundary; say so.

## Step 5: Fix in slices

Group related findings, write or adjust tests first for any behaviour fix, run the inner-loop checks
(CONVENTIONS section 3), stage by path, commit:

```
<KEY> review: <what was fixed>

- finding -> fix (file:line), bucket
- tests: <names>

Co-Authored-By: <agent> <noreply@anthropic.com>
```

Fix `[tooling]` defects yourself in a `<KEY> Tooling:` commit with a test. Complex or risky items go
under `## Open Questions / Blocked` as `- [ ] \`[product]\` REVIEW: file:line - issue (bucket)`.

## Step 6: Ledger and tracker

- **Clean pass** = review subagent reports no unresolved critical or in-scope warning, Step 3 checks
  are green or "no regression vs base", and this iteration added nothing blocking to Open Questions.
  Then set the spec's ledger row to `reviewed` (stay in Active; `Last updated` today; idempotent) and
  commit it with any fixes. Otherwise leave it `built`.
- Never set `shipped`; a person does that when the change lands.
- If a tracker block is present, post its review-run comment (every review iteration) and apply its
  failure handling. No status transition from review.

## Step 7: Report and exit

Prepend to `.ralph/PROGRESS.md` (newest first, full ISO timestamp in the heading):

```markdown
## Review - 2026-01-01T10:30Z (<spec>: full | slice N)
Checks: lint ok, typecheck ok, build not configured, test ok, bindings ok
Fixed: <n> (list, with buckets)
Left: <n> inside | <n> outside-ship-blocking | <n> outside-pre-existing
Status: clean -> reviewed | not clean -> built
```

**Scope audit note (pass 5 or later):** list every finding from every pass, one line each with its
bucket and disposition, and end with one batched question for a person (accept residual risk, file
candidate specs, or widen the spec). Do not requeue more fixes until it is answered.

Write `ITERATION_STATUS.json` and exit.

## Exit conditions

| Situation | Outcome |
|-----------|---------|
| Clean, ledger advanced | `committed` (or `progressed` if nothing to commit), `exit_gate: passed` |
| Issues fixed, more remain | `committed`, `exit_gate: not-yet`, `next` names the next group |
| Needs a person | `blocked`, `result` states the decision, findings in Open Questions |
| Detached check running | `waiting`, `next` names the `run.log` |

## Do not

Skip the checks; mark a finding fixed without a test or re-check; fix outside-pre-existing items inline
to feel thorough; weaken the spec or its tests; mark `exit_gate: passed` early.

# Skills, commands and agents

The kit ships three Claude Code definitions plus a hook, and drives the rest through prompts. This page
describes what each one is for, how it is triggered, what it reads and writes, and how work passes from
one stage to the next.

```
/design  ->  specs/<name>.md + ledger row (drafted)
              |
              v
   ralph plan -> .ralph/IMPLEMENTATION_PLAN.md (planned)
   ralph build -> code + tests, Exit Gate (built)        <- uses the code-review agent at the Exit Gate
   ralph review -> fixes + findings (reviewed)           <- uses the code-review agent once per spec state
              |
              v
   a person ships it (shipped)

autonomous skill: queues specs and carries them through plan/build/review unattended.
feature-dev: the attended alternative for small work.
```

## `/design` (`.claude/commands/design.md`)

- **Purpose:** turn an idea or ticket into a spec the loop can execute: problem, scope, technical
  design, 3-6 phases each with acceptance tests, edge cases, security, open questions.
- **Trigger:** `/design <ticket key | description>`, `/design --bind KEY specs/file.md`, `--type ...`.
- **Inputs:** the user's answers, `ralph.config.json` (`tracker.provider`), the codebase (via
  exploration subagents), and `standards/` (the spec is written to those standards).
- **Reads:** `standards/`, existing specs, code, the tracker issue (only when `tracker.provider = "jira"`).
- **Writes:** `specs/<name>.md` (with `tracker_issue` front matter when bound), a `drafted` row in
  `.ralph/SPECS_LEDGER.md`, and with a tracker `.ralph/tracker/<name>.json` plus issue updates.
- **Mandatory questions:** events, permissions and access, external tool exposure, analytics/flags/config,
  agentic and conversational behaviour, UI states and accessibility, migration and rollback.
- **Checks before saving:** acceptance-test validation (every phase has a block, every Success Criterion
  is traced, names are specific, Open Questions tagged), then `node scripts/lint-spec.mjs --spec S --strict`.
- **Hand-off:** prints `./ralph/loop.sh plan 1 specs/<name>.md`; the autonomous skill can queue it.

## `autonomous` skill (`.claude/skills/autonomous/SKILL.md`)

- **Purpose:** supervise unattended work through a queue of specs while the user is away.
- **Trigger:** "work autonomously", "keep going without me", "run the queue", overnight/unattended requests.
- **Does:** pre-flight (empty index, no other loop, decisions file and talk log, draft PR, `ralph-doctor`,
  drift against `drift.warnCommits`); writes `.claude-temp/ralph-queue/QUEUE.md`; starts
  `node scripts/ralph-queue.cjs start`; never ends a turn without a `watch --timeout-min` waiter;
  re-checks drift on each wake; handles parked specs with the scope gate, decide-vs-ask rules and the
  5-pass scope audit; reports via the talk log (`[REVIEW]`, `[REVIEW: SCOPE]`; infrastructure and tooling
  specs reported apart from product specs); runs lanes (`scripts/new-lane.mjs`, `scripts/lane-merge-notes.mjs`).
- **Reads:** the queue, `ralph-queue.cjs status`, `.ralph/` state, plan Open Questions, the ledger.
- **Writes:** the queue file, the talk log, plan decisions/Open Questions rows, spec amendments through
  `/design --bind` run by a subagent.
- **Never:** signs approvals or waivers, touches shared environments, applies infrastructure, force pushes,
  skips hooks, or decides identity/outward-facing actions; those park for the user.

## `/feature-dev` (`.claude/commands/feature-dev.md`)

- **Purpose:** attended, human-paced development for work too small or exploratory for a spec.
- **Trigger:** `/feature-dev <description or spec path>`.
- **Flow:** explore (subagents) -> clarify (batched questions) -> design (one recommended approach, approval
  first) -> implement (tests first) -> verify (`gates.exitGate` commands, review agent) -> summarise.
- **Reads/writes:** code and tests; commits only when the person agrees.
- **Hand-off:** if the work grows, stop and run `/design` so the loop gets a contract.

## `code-review` agent (`.claude/agents/code-review.md`)

- **Purpose:** review a diff against `standards/` (and the spec's scope when named) and report; it does
  not edit.
- **Trigger:** launched by build at the Exit Gate (once per spec), by review mode (once per spec state), by
  `/feature-dev`, or by hand. The name is set by `gates.reviewSubagent`.
- **Model:** pinned in its front matter to `opus` (the review alias in `models.review`), so the
  agent-model hook allows the launch without a `model` argument.
- **Tools:** Read, Grep, Glob, Bash (read-only use).
- **Output:** a verdict and findings with severity (critical, warning, info), scope bucket (inside,
  outside-ship-blocking, outside-pre-existing), `file:line`, rule id and fix. Build fixes criticals and
  inside warnings; review mode buckets and records the rest; the ledger advances to `reviewed` only on a
  clean pass.

## `require-agent-model` hook (`scripts/hooks/require-agent-model.cjs`)

- **Purpose:** every subagent launch states its model so work runs on the smallest model that can do it.
- **Trigger:** PreToolUse on the Agent tool, wired in `.claude/settings.json`.
- **Behaviour:** reads the hook JSON from stdin; allows a call with a `model`, a `fork`, or a project
  agent whose front matter pins a model other than `inherit`; otherwise exits 2 with a model rubric.
  Unparseable input never blocks. `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` in the same settings file is the
  fallback for launches the hook does not see. Tested by `test/require-agent-model.test.mjs`.

## Prompts the driver feeds the agent

| File | Mode | Writes |
|------|------|--------|
| `ralph/PROMPT_plan.md` | plan | `.ralph/IMPLEMENTATION_PLAN.md`, ledger `planned` |
| `ralph/PROMPT_build.md` | build | code and tests, plan ticks, ledger `built` at the Exit Gate |
| `ralph/PROMPT_review.md` | review | fixes, findings, ledger `reviewed` on a clean pass |
| `ralph/TRACKER_jira.md` | injected only with `tracker.provider = "jira"` | tracker comments, transitions, `.ralph/tracker/<spec>.json` |

Every mode ends by writing `.ralph/ITERATION_STATUS.json`. Rules shared by all three live in
`ralph/CONVENTIONS.md`; subagent guidance in `ralph/AGENTS.md`.

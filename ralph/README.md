# Ralph: spec-driven autonomous delivery

A **Ralph loop** runs a coding agent over and over, each time with a fresh context, against files on disk.
The agent has no memory between runs; the plan, the progress notes and git are the memory. One run does
one small, verified unit of work, commits it, writes a status line, and exits.

A spec (`specs/<name>.md`) goes through three modes:

| Mode | Prompt | Does | Ledger state after |
|------|--------|------|--------------------|
| `plan` | `PROMPT_plan.md` | Gap analysis, base health, writes `.ralph/IMPLEMENTATION_PLAN.md` (3-6 phases, Exit Gate last) | `planned` |
| `build` | `PROMPT_build.md` | One task per iteration: failing tests first, implement, inner-loop checks, commit. The Exit Gate runs the full sweep. | `built` (at the Exit Gate) |
| `review` | `PROMPT_review.md` | Reads the whole diff once, runs checks, fixes in slices, buckets findings by scope | `reviewed` (clean pass) |

`shipped` is set by a person when the change lands. `/design` (a slash command) writes the spec;
`ralph-queue.cjs` + the `autonomous` skill carry a list of specs through all three modes unattended.

## Files

```
specs/<name>.md                  the contract: problem, scope, design, phases with acceptance tests
.ralph/SPECS_LEDGER.md           one row per spec and its state
.ralph/ACTIVE_SPEC               the spec the loop works on
.ralph/IMPLEMENTATION_PLAN.md    the live plan (archived per spec when done)
.ralph/ITERATION_STATUS.json     the agent's own report of its last iteration
.ralph/PROGRESS.md               narrative between iterations
.ralph/tracker/<spec>.json       tracker event state (only with a tracker)
ralph.config.json                project commands, gates, models, queue limits
ralph/CONVENTIONS.md             the rules (phase sizing, tiers, formats, model policy)
ralph/AGENTS.md                  subagent reference
standards/                       the project's rules, read by design, build and the review agent
```

## Running it

```bash
./ralph/loop.sh plan   1 specs/my-spec.md      # PowerShell: .\ralph\loop.ps1 plan 1 specs/my-spec.md
./ralph/loop.sh build  20 specs/my-spec.md
./ralph/loop.sh review 5  specs/my-spec.md
./ralph/loop.sh status
node scripts/ralph-queue.cjs start               # unattended queue (see the autonomous skill)
node ralph/report.mjs --spec my-spec            # telemetry
```

Options: `--model M`, `--issue KEY`, `--skip-tracker`, `--no-transcripts` (PowerShell: `-Model -Issue
-SkipTracker -NoTranscripts`).

## Verification at a glance

Inner loop every phase (the phase's tests plus a scoped check); Exit Gate once, at the end: every
command in `gates.exitGate`, the acceptance-binding check, one review-agent pass, and
`base-health --compare` when the base branch was already red. Project-specific checks are not in the
prompts; they come from `ralph.config.json` `commands` and `gates`. A command left `null` is reported as
"not configured", never as green.

## Safety and unattended use

The agent runs with permission prompts disabled (`--dangerously-skip-permissions` by default) so it can
work with nobody present. Treat that as running arbitrary code with your user's rights:

- Run it in a **worktree or container** holding only the code it should change; keep production
  credentials, deploy tooling and shared-environment access out of that environment.
- The prompts forbid signing approvals/waivers, infrastructure apply, force push, touching shared
  environments, skipping hooks and widening scope. These are instructions, not a sandbox; enforce what
  matters with your OS, credentials and branch protection.
- Work on a branch and keep the pull request a **draft** until a person marks it ready, so CI cost
  stays low. Every push starts whatever CI the project has.
- A pre-commit hook (`node scripts/install-hooks.mjs`) refuses commits while tracker sync is degraded.
- All long processes go through `scripts/sweep.mjs`, which bounds them by time, stall and memory and
  kills the whole tree. Nothing else in the kit kills a process.
- Read `.ralph/PROGRESS.md` and the ledger when you return; parked specs and `[product]` questions are
  waiting for you.

## Telemetry

The driver (not the agent) writes: `.ralph/iterations.jsonl` (one row per invocation: model, phase,
outcome, durations, commit movement, transcript path), `.ralph/USAGE_LOG.md` (same facts as a table),
`.ralph/loop-events.jsonl` (events outside the agent), `.ralph/.loop-heartbeat` (liveness) and
`.ralph/logs/<spec>/` (stamped transcripts). `node ralph/report.mjs [--spec S] [--since DATE] [--gap
SECONDS]` summarises iterations, time and gaps. Repeated identical `blocked` outcomes mean a person must
step in.

## Customising

Prompts are plain Markdown in `ralph/`; edit them in your repo like code. Keep the contract the
verifiers and driver rely on: the status JSON fields, the plan shape (`<- NEXT`, `Files:`, `Tests:`,
Exit Gate last) and the ledger columns. Add project rules as files under `standards/` rather than by
growing the prompts; the prompts already tell the agent to read them. To change which checks run, edit
`ralph.config.json`. To use a tracker, set `tracker.provider` to `jira`; the driver then injects
`ralph/TRACKER_jira.md` into each prompt, and with `none` no prompt mentions a tracker.

## Quick start

1. Copy the kit into your project root; copy `templates/config.example.json` to `ralph.config.json`
   and set `commands.test`, `lint`, `typecheck`, `build` for your project.
2. `node scripts/ralph-doctor.mjs` to check the setup; `node scripts/install-hooks.mjs`.
3. Write a few rules into `standards/` (see `standards/README.md`).
4. In your agent, run `/design "what you want built"` to produce `specs/<name>.md` and a ledger row.
5. `./ralph/loop.sh plan 1 specs/<name>.md`, read the plan, then `build`, then `review`; or hand
   several specs to the `autonomous` skill.

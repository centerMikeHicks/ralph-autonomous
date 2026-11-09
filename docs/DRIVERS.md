# Loop drivers

`ralph/loop.sh` and `ralph/loop.ps1` are launchers of about 30 lines. They translate their native
flag style into one argument list and `exec` the same Node entry point,
`ralph/lib/run-loop.mjs`. All policy lives in Node modules under `ralph/lib/`, so the two shells
cannot drift and every rule is unit-tested (`test/driver-*.test.mjs`).

```
./ralph/loop.sh   plan|build|review|status [max-iterations] [spec]  [--model M] [--issue KEY] [--skip-tracker] [--no-transcripts]
.\ralph\loop.ps1  plan|build|review|status [max-iterations] [spec]  [-Model M] [-Issue KEY] [-SkipTracker] [-NoTranscripts]
```

`plan` is clamped to one iteration and records the spec in `.ralph/ACTIVE_SPEC`. `build` and `review`
use the recorded spec when none is given. `status` prints the active spec, tracker binding, liveness,
last iteration and the head of the plan.

## Modules

| File | Responsibility |
|---|---|
| `run-loop.mjs` | The loop: banner, iteration lifecycle, push, signals. Exports `main`, `parseArgs`, `pushBranch`. |
| `driver.mjs` | CLI over the pure helpers: `run`, `prepare`, `select-model`, `next-task`, `fingerprint`, `usage-limit`, `record`, `event`, `finish`, `status`. All print JSON except `status`. |
| `plan-parse.mjs` | NEXT marker, next task, Exit Gate detection, mechanical-task regex, plan view. |
| `model-select.mjs` | Model and effort for one iteration. |
| `usage-limit.mjs` | Rate-limit detection, reset-time parsing, wait computation. |
| `progress.mjs` | Progress fingerprint and eject decision. |
| `telemetry.mjs` | Transcript metrics, `iterations.jsonl` row, `USAGE_LOG.md` row, `loop-events.jsonl`, heartbeat. |
| `prompt-assemble.mjs` | Context blocks and prompt assembly; diff-anchor parsing. |
| `spec-tracker.mjs` | Spec resolution, tracker binding in the spec front matter, plan bootstrap and archive. |
| `kairos.mjs` | The Kairos tracker: asking whether the run may go on, reporting what it did, and the plan in words Kairos can hold. |
| `agent.mjs` | Resolves and spawns the agent CLI; renders stream events for the console. |
| `status.mjs`, `fsutil.mjs`, `load-config.mjs` | `status` text; BOM/CRLF-tolerant file helpers; config via `scripts/lib/config.mjs` with a built-in fallback. |

## Iteration lifecycle

1. **Startup** (once): parse flags, load config, resolve the spec, create the plan skeleton if none
   exists, archive an outgoing plan that belongs to another spec (plan mode), check the prompt file
   and the agent command, run the tracker preflight when applicable, print the banner, emit
   `loop_start`, write the heartbeat, run `node scripts/sweep.mjs reap --stale`.
2. **Before each iteration**: stop at max iterations; run `node scripts/sweep.mjs wait` so a detached
   check from an earlier iteration finishes in the shell, never inside a model turn; in supervised
   mode ask for confirmation.
3. **Select** model and effort from the current plan (table below).
4. **Assemble** the prompt, snapshot HEAD, the progress fingerprint and the plan, emit
   `iteration_start`, rewrite the heartbeat.
5. **Run** the agent with the prompt on stdin. Stream-json lines go to the stamped transcript
   `.ralph/logs/<spec>/<utc>-iterNNN.jsonl` (a temp file deleted afterwards with `--no-transcripts`),
   a compact rendering goes to the console, and the heartbeat is refreshed every 30 s.
6. **Usage limit?** Scan the transcript (see below). If limited, sleep until the reset, do not count
   the iteration, and start again.
7. **Record**: read `ITERATION_STATUS.json` (ignored when older than the iteration start), compute
   metrics, append the `iterations.jsonl` and `USAGE_LOG.md` rows, emit `iteration_end`.
8. **Decide** to eject (below), but first finish the housekeeping:
   build mode runs `node scripts/verify-plan-ticks.mjs --before <snapshot> --after <plan> --fix`
   (skipped when the script is absent; a non-zero exit is reported and fed to the next prompt as the
   last verification verdict), and a committing iteration is pushed.
9. **Stop** on an eject reason, when a build plan has every phase ticked, or when a review reports
   `exit_gate: passed`; otherwise pause `RALPH_PAUSE_S` seconds (default 3) and loop.

`finally`: `loop_stop` event with the reason, heartbeat deleted. `SIGINT`/`SIGTERM`/`SIGBREAK` stop the
agent, then end the loop with reason `signal`.

## Prompt assembly

Blocks are joined with `---` separators, in this order, and `PROMPT_<mode>.md` follows verbatim:

1. A pending `.ralph/PREFLIGHT_FAILURE.md` note, if any project step wrote one.
2. **Active spec**: path of the spec; other specs are to be ignored.
3. **Plan view** (build only): status line, one line per phase, and the NEXT phase in full.
4. **Anchors** (build, review): `path:lines` ranges changed by the last committing iteration, taken
   from `git diff --unified=0 head_before head_after` of the newest such row for this spec.
5. **Previous hand-off**: the last `ITERATION_STATUS.json`, marked STALE when it is older than the
   spec selection or names a different spec.
6. **Tracker block**, only when `tracker.provider` is `jira` or `kairos` and not `--skip-tracker`. For
   `jira`: ticket key, project, the coordination file `.ralph/tracker/<spec>.json`, then
   `ralph/TRACKER_jira.md`. For `kairos`: the key, `ralph/TRACKER_kairos.md`, and what a person has answered.
   With provider `none` nothing mentions a tracker.
7. **Last verification verdict**: the phase-tick check result of the previous build iteration and the
   previous `exit_gate` value.

## Model and effort selection

| Situation | Model | Effort |
|---|---|---|
| `--model` / `RALPH_MODEL` set (flag wins) | that model | none (flag omitted) |
| plan | `models.planning` | `efforts.planning` |
| review | `models.review` | `efforts.planning` |
| build, next task mechanical | `models.mechanical` | `efforts.mechanical` |
| build, Exit Gate next | `models.execution` | `efforts.exitGate` |
| build, otherwise | `models.execution` | `efforts.execution` |

The next task is the first unchecked indented task under the phase marked `<- NEXT` (or the first
unchecked phase when nothing is marked). It is mechanical when tagged `[haiku]` or `[mechanical]`,
or, unless tagged `[sonnet]`, when it starts with `[DOC]`, regenerate, re-run, re-capture, codemod,
rename, reformat, `update the (ledger|changelog|docs)` or `bump version`. The mechanical test runs
before the Exit Gate test. Exit Gate next means a line matching `Exit Gate.*(<-|←)\s*NEXT`, or the
first unchecked phase mentions Exit Gate. Build never selects the planning model.

## Ejection

- `blocked`: the iteration reports `outcome: blocked`. A person must decide; another lap would only
  re-read the same plan.
- `stalled`: two consecutive iterations left both HEAD and the progress fingerprint unchanged. The
  fingerprint is `sha256(plan file) | git status --porcelain --untracked-files=all`, with the loop's
  own bookkeeping files under the state directory filtered out. Uncommitted work and plan-only
  bookkeeping count as progress.
- `completed`: build plan fully ticked, or a review that reports `exit_gate: passed`.
- `max_iterations`, `signal` (interrupt, or "no" at a supervised prompt).

Blocked and stalled print the agent's phase, did, result and next so the reason is on screen.

## Usage limits

`usageLimitReset(lines, now)` (pure) inspects transcript events:

- a `rate_limit_event` with status `rejected` or `blocked`; `resetsAt` is epoch seconds, or
  milliseconds when larger than `1e11`;
- an error `result` (or rate-limit assistant error) whose text says "hit your session/usage limit";
  `resets 9:10pm`, `resets 09:10`, `resets 9pm` are parsed in local time and rolled to tomorrow when
  already past;
- limited without any time: wait 15 minutes. A failure for any other reason returns `null`, so a
  real error is never turned into a long sleep.

`waitSeconds` adds a 30 s buffer and clamps to 60 s .. 6 h. The iteration is not counted; an
`usage_limit_wait` event records the reset and the wait.

## Push

After an iteration that moved HEAD, when a remote exists: `git push` if the branch has an upstream
with unpushed commits, otherwise `git push -u <remote> <branch>` (`origin` preferred). Never forced.
A `push` event records the outcome; a failed push is reported and does not stop the loop.

## Telemetry

Written by Node only, BOM-free, appended with retry (Windows sharing violations).

`iterations.jsonl` (one row per agent invocation that was not usage-limited): `ts, run, iter, branch,
spec, mode, model, phase, outcome, status_fresh, committed, head_before, head_after, started_at,
ended_at, dur_s, api_s, tool_s, overhead_s, gap_s, turns, tool_calls, tools, tests_run, tests_summary, test_claim_mismatch, test_runs, subagents,
subagent_s, exit_code, is_error, stop_reason, input, output, cache_r, cache_w, cost_usd, did, result,
next, transcript`. `model` is `name (effort)`. `outcome` is the agent's, corrected to
`committed(no-status)` when no fresh status exists but HEAD moved and to `error(exit N)` on a failing
exit with no status. `api_s` is model time, `tool_s` the rest of the run, `overhead_s` wall minus run,
`gap_s` idle time since the previous iteration ended.

`tests_run` counts test invocations. `test_runs` records each one (up to 25): `command` (shortened, credentials
blanked), `started_at`, `is_error`, `exit_code`, and `passed`, `failed`, `skipped`, `total`, `unit`, `parsed`
read from its output (vitest, jest, pytest, `node --test`, nx; `null` when unknown, never 0). A command is a
test run if it matches the default pattern or `commands.test` or `commands.affectedTest`. `tests_summary` is
`{runs, passed, failed, unparsed, errored, no_result}`. `test_claim_mismatch` is true when the agent's `did`/`result`
claims passing tests but no run was recorded or one failed.

`USAGE_LOG.md`: the same facts as a markdown table. `loop-events.jsonl` rows are
`{ts, run, event, ...}` with events `loop_start`, `iteration_start`, `iteration_end`, `push`,
`usage_limit_wait`, `budget` (the caps in force and today's spend), `spend` (after each iteration: its cost, the run's and today's), `budget_stop`, `loop_stop` (`reason`: completed, max_iterations, blocked, stalled, signal, budget_run, budget_day, kill_switch).
`.loop-heartbeat` holds `{run, iter, pid, ts}`, rewritten at each iteration start and every 30 s,
and deleted at stop; a heartbeat older than two minutes means the run died.

## Agent invocation

`agent.command` with `agent.args`, then `<modelFlag> <model>` and `<effortFlag> <effort>`; prompt on
stdin. `RALPH_AGENT_CMD` (path or `node script.mjs`, quotes allowed) replaces the command.
When the command is the `claude` CLI the driver also passes `--max-turns` (`agent.maxTurns`, default
250), `--disallowedTools` (`agent.disallowedTools`, default `ScheduleWakeup,Monitor`), `--mcp-config
.mcp.json` when that file exists, and sets the foreground-only environment (background tasks off,
10 minute command timeout). A `.cmd`/`.bat` shim on Windows is run through the shell with the kit's
own flags only; the prompt never goes on a command line.

## Tracker

With `tracker.provider = "jira"` the spec needs `tracker_issue: KEY` in its front matter (or pass
`--issue KEY`, which writes it). Unless `--skip-tracker`, the preflight runs `claude mcp list` and
refuses to start when the Atlassian server is not connected, because every tracker step in the prompts
is non-blocking and would otherwise be dropped silently. `--skip-tracker` prints a warning and omits
the tracker block. With another agent command the probe is skipped with a warning.

With `tracker.provider = "kairos"` the spec needs `tracker_issue` the same way, and the driver, not the agent,
talks to Kairos. It needs `KAIROS_URL` (or `tracker.kairos.url`) and `KAIROS_RUN_TOKEN`, a key for that one item
made by a person on its Build tab. The key is not passed to the agent's process.

- **Before each iteration** it asks whether the run may go on. A stop, a pause, the item's cap, an unanswered
  question, a stage not yet reached, or, for a build, a decision or validation row before Build each end the run
  (`kairos_stop`, or `budget_item` at the cap). The caps in force are the lower of this repository's and Kairos's,
  and an iteration may spend no more than the item has left.
- **If Kairos cannot be read:** a plan run goes ahead, and a build or review refuses to start. Once going, a run carries
  on with the last answer, the plan on disk, and the local caps and kill switch. A run nobody is watching stops after
  `RALPH_KAIROS_OUTAGE_MIN` minutes (30; `kairos_unreachable`), so a stop placed there holds. `RALPH_KAIROS_ATTENDED=1`
  says a person is watching, and it keeps going.
- **It reports** `run_started`, `plan_started`, `build_started`, each iteration's spend, `review_required`,
  `review_run` and `run_ended`. Reporting never blocks the work: what could not be sent is kept in a file
  (`RALPH_KAIROS_OUTBOX`, by default the state directory), and sent in order when Kairos answers, by this run or the next.
- **The plan is held in Kairos.** The file stays the working copy. After each iteration, once the tick check has run,
  the driver sends it, with its phases, tasks, decisions and open questions, and whether
  `verify-plan-completeness --strict` passes. Before each iteration it brings in any newer version a person wrote,
  keeping the ticks. A fresh copy takes what Kairos holds. A build refuses to start, or stops, while the latest version
  is not approved.
- **Scope.** The plan's `## Scope changes` goes with it: what the build included because it blocks an outcome, what it
  filed as a new item, and what blocks it and needs a person. So do any older `CANDIDATE-SPEC` rows, and any commit tagged
  `[REVIEW: SCOPE]`, and an iteration's cost is counted against each `S<n>` its commits name. It also sends the files changed
  since the base, so the owner sees any the plan does not name. Kairos decides what each means (`ralph/TRACKER_kairos.md`).
- **`blocked`** puts the iteration's `next`, with the plan's open questions, in the owner's queue in Kairos. Later
  runs refuse to start until it is answered, then read the answer in their prompt.
- **`--skip-tracker`** runs without any of this, with a warning.
- **`RALPH_TRACKER_PROVIDER`** overrides `tracker.provider` for a run. The config is on the branch, which the agent
  can edit, so whoever starts the loop from outside the branch sets this to keep it under the tracker's control.

## Environment variables and flags

| Name | Effect |
|---|---|
| `RALPH_BUDGET_ITERATION_USD`, `RALPH_BUDGET_RUN_USD`, `RALPH_BUDGET_DAY_USD` | Override `budget.*` (an empty value unsets one); see `templates/config.example.md`, "budget". |
| `RALPH_SPEND_LOG` | A JSON-lines file, outside the state directory, that today's spend is read from and each iteration's cost added to, so `budget.dayUsd` holds across fresh clones. |
| `RALPH_KILL_SWITCH` | The kill switch file, instead of `<stateDir>/STOP`: while it exists, no iteration starts. |
| `RALPH_MODEL` | Force one model for every iteration (`--model` wins). |
| `RALPH_AGENT_CMD` | Replace `agent.command`; used by the tests. |
| `RALPH_SUPERVISED=1` | Ask before each iteration (needs a terminal; otherwise unattended). |
| `RALPH_PAUSE_S` | Pause between iterations, default 3. |
| `RALPH_SWEEP_WAIT_CEILING_MIN` | Ceiling for one `sweep.mjs wait`, default 90. |
| `RALPH_USAGE_LIMIT_BUFFER_S`, `RALPH_USAGE_LIMIT_MIN_WAIT_S` | Defaults 30 and 60; tests set 0. |
| `RALPH_ROOT` | Project root override (default: the parent of `ralph/`). |

## Testing

`test/fixtures/fake-agent.mjs` is a scripted agent (`FAKE_AGENT_SCENARIO`, inline JSON or a file):
per iteration it can write files, commit them, tick plan boxes, write `ITERATION_STATUS.json` with any
outcome, emit a rate-limit event, sleep, and set an exit code. `test/driver-e2e.test.mjs` runs the
whole loop against a temp git repository with a bare remote. Run the suites with
`node --test "test/driver-*.test.mjs"` (Node 24 does not accept a bare directory argument).

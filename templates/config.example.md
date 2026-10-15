# ralph.config.json, key by key

`templates/config.example.json` lists every key with an illustrative value; JSON has no comments, so
this file is the commentary. Copy the example to `ralph.config.json` at the project root and keep only
what differs from the defaults: every key is optional, objects are merged key by key over the built-in
defaults (`scripts/lib/config.mjs`), arrays and scalars you write replace the default wholesale, and
keys the kit does not know are preserved so a project can keep its own settings there.

A **command** value is `null` (not configured), a string (run through the shell, so pipes and `&&` work),
or an array of strings (argv, run without a shell).

## project

| Key | Meaning |
|-----|---------|
| `name` | Display name used in reports. |
| `baseBranch` | Integration branch. Base health measures the merge-base with it; the drift check counts commits behind it. |
| `specsDir` | Where spec files live (`specs/<name>.md`). |
| `stateDir` | Where the ledger, plan and loop telemetry live (default `.ralph`). |

## agent

| Key | Meaning |
|-----|---------|
| `command` | The agent CLI the drivers run. Env `RALPH_AGENT_CMD` (an executable, or `node path/to/script.mjs`) overrides it, which is how tests use a fake agent. |
| `args` | Arguments passed on every invocation. The default skips permission prompts so a run is unattended: use a sandbox or a throwaway branch. |
| `modelFlag`, `effortFlag` | Flags the driver appends with the chosen model and effort. Empty string disables the flag. |
| `subagentModelEnv` | Environment variable that sets the fallback model for subagents. |

## models

`planning`, `execution`, `mechanical`, `review` name the model used for each kind of work (`mechanical` is
for plan tasks tagged `[haiku]` or `[mechanical]`). `efforts` maps work kinds (`planning`, `execution`,
`mechanical`, `exitGate`) to an effort level. Env `RALPH_MODEL` forces one model for every iteration.

## commands

The project's own checks, by name: `test`, `lint`, `typecheck`, `build`, `affectedTest`, `format`. A `null`
command is skipped and reported as "not configured" in the Exit Gate summary, never counted as green.

## tests

| Key | Meaning |
|-----|---------|
| `globs` | Files that contain tests. The acceptance-binding check searches only these. |
| `ignore` | Globs excluded from the search. |
| `layers` | Optional `{ "unit": [globs], "integration": [globs], "e2e": [globs] }`. When at least one layer lists a glob, a row tagged `[integration]` or `[e2e]` is only bound by a test in a file at that layer or a higher one (a file matching none of them counts as unit). Omit it and the layer tag is not checked. |

Glob syntax: `**` (any directories), `*`, `?`, `{a,b}`, forward slashes.

## gates

| Key | Meaning |
|-----|---------|
| `exitGate` | Names of `commands` the Exit Gate runs, in order. |
| `baseHealth.checks` | List of `{ "name", "command", "failPattern"?, "timeoutMin"? }`. `scripts/base-health.mjs` runs them at the merge-base (in a temporary worktree) and at HEAD and compares the findings. A check's findings are the output lines matching `failPattern` (regex source; default: error / fail / "not ok" lines); if none match but the exit code is non-zero it counts as one. |
| `baseHealth.link` | Directories of the main tree linked into the base worktree so checks run without an install. Default `["node_modules"]`. |
| `requireAcceptanceBindings` | When true (default), a phase tick needs every acceptance row of that phase bound to a real test. False makes the binding check a reported no-op. |
| `reviewSubagent` | Name of the reviewer subagent the review loop delegates to. |

## hooks

`preCommit`: list of commands (strings or argv arrays) that `.githooks/pre-commit` runs from the project
root after the tracker gate. The first failure blocks the commit. Default none.

## tracker

`provider` is `"none"` (default; no prompt mentions a tracker) or `"jira"`. With `jira`, the drivers inject
`ralph/TRACKER_jira.md` into every prompt and the agent makes Jira calls through the Atlassian MCP tools.
`jira.project` is the key prefix, `jira.site` or `jira.cloudId` identifies the instance, and
`jira.transitions` names the target statuses (resolved by name at call time) for build start, Exit Gate and
design finalisation. A failed call writes a `JIRA DEGRADED` line to `<stateDir>/PROGRESS.md`, and the
pre-commit hook refuses commits until that line is cleared.

## queue

Settings for `scripts/ralph-queue.cjs`: `buildChunk` (build iterations per invocation), `maxBuild` (build
iterations per spec before it is parked), `maxReview` (review passes per spec before it is parked for a
person's scope audit; 0 = no cap), `minFreeGb` (free memory required before each invocation),
`maxRetries` (re-runs of an interrupted invocation), `watchTimeoutMin` (how long `watch` blocks).

## sweep

Limits for detached jobs run through `scripts/sweep.mjs`: `timeoutMin` (hard ceiling), `stallMin` (no output
and no heartbeat), `ownerProcessNames` (process names that count as the agent session owning a service).

## review

`scopeAuditAfterPasses`: after this many review passes on one spec the supervisor runs a scope audit.

## drift

`warnCommits`: the pre-flight warns when the branch is this many commits behind `project.baseBranch`.

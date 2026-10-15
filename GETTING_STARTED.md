# Getting started

From an empty checkout to a spec shipped by the loop. Allow an hour for the first spec; later ones take
as long as the agent does. Commands are shown for a POSIX shell; on Windows PowerShell replace
`./ralph/loop.sh` with `.\ralph\loop.ps1` (flags become `-Model`, `-Issue`, `-SkipTracker`,
`-NoTranscripts`). Everything else is the same `node ...` command.

## 0. Before you start

- Node.js 20+ and git on PATH, and an agent CLI (default: `claude`).
- A repository you can safely let an agent change. Read the *Safety* section of [README.md](README.md)
  first: unattended runs skip permission prompts, so use a sandbox or a throwaway branch.
- If your repository has a `CLAUDE.md` (or `AGENTS.md`), every loop iteration reads it, and rules written
  for an attended session break an unattended one. Look for "ask before committing" (add a line saying
  that running the Ralph loop is the standing instruction to commit each finished slice), "ask the user
  when unsure" (in a loop that becomes a `[product]` Open Question and a `blocked` outcome), and any
  interactive tool it makes mandatory. Add one paragraph pointing unattended spec work at `/design`, the
  loop and the `autonomous` skill.

## 1. Put the kit in your repository

Copy these into your repository root, keeping the layout: `ralph/`, `scripts/`, `.githooks/`, `.claude/`,
`standards/`, `templates/` and `docs/`. You do not need the kit's own `ralph.config.json` (it configures
the kit's test suite; step 2 makes yours from the template), its `package.json` (copy the `doctor`,
`queue:*` and `hooks:install` scripts into yours if you like) or `test/` (for developing the kit itself).

Merge, do not overwrite, where your repository already has the folder:

- **`scripts/`**: the kit's files sit beside yours. Every kit file names its module type in its extension
  (`.mjs` / `.cjs`), so your own `"type"` setting does not affect it and it does not affect your scripts.
  Check no name collides (`ls scripts/ | grep -E 'ralph|sweep|verify-|lint-spec|base-health|lane'`).
- **`.claude/`**: copy `commands/design.md`, `commands/feature-dev.md`, `skills/autonomous/` and
  `agents/code-review.md`. If you already have `.claude/settings.json`, add the kit's `hooks.PreToolUse`
  entry and `env.CLAUDE_CODE_SUBAGENT_MODEL` to it rather than replacing the file.
- **Git hooks**: step 3 points git at `.githooks/`. If you already use husky, lefthook or your own
  `.git/hooks/pre-commit`, the installer stops and tells you how to keep them; list your existing hook in
  `hooks.preCommit` (for example `"sh .husky/pre-commit"`) and re-run it with `--force`.

Then create a branch to work on:

```bash
git switch -c ralph/first-spec
```

## 2. Configure it

Copy `templates/config.example.json` over `ralph.config.json` and keep only what you need. Each key is
explained in `templates/config.example.md`. The ones that matter first:

- `project.baseBranch`: your integration branch (`main`, `develop`, ...).
- `commands.test`, `commands.lint`, `commands.typecheck`, `commands.build`: your project's own commands. A
  command left `null` is reported as "not configured" at the Exit Gate; it is never counted as passing.
- `tests.globs`: where your tests live, so acceptance rows can be matched to real tests. Optionally add
  `tests.layers` so `[integration]` and `[e2e]` rows must be bound by a test at that layer.
- `agent.command` / `agent.args`: only if you are not using Claude Code.

## 3. Install the hooks and run the doctor

```bash
node scripts/install-hooks.mjs      # sets git core.hooksPath to .githooks (safe to run twice)
node scripts/ralph-doctor.mjs       # pass / warn / fail table; --json for machines
```

`ralph-doctor` checks Node, the git repository, the agent CLI, that `ralph.config.json` parses and
validates, the specs and state directories, that hooks are installed, that the ledger exists, that tracker
settings are sane and that the state directories are writable. Fix every FAIL; a WARN about a missing ledger
is fixed in step 4. The commit hook runs your `hooks.preCommit` commands (none by default) and, with a
Jira tracker, refuses commits while tracker sync is degraded.

## 4. Create the ledger and write some rules

```bash
mkdir -p .ralph && cp templates/ledger.md .ralph/SPECS_LEDGER.md
```

The ledger is one table row per spec, in four sections (Active, Recently shipped, Superseded / paused,
Backlog). Commit it; the loops and the queue runner read and update it.

The agent follows whatever rules you give it. Put them in `standards/` (see `standards/README.md` and
`standards/example-rule.md`: each rule has an id, severity, statement, detection and example). Start with
five rules you would otherwise repeat in every review. The `/design` command writes specs to those
standards and the review agent checks diffs against them.

## 5. Write your first spec

In your agent (Claude Code), run:

```
/design "add a --verbose flag to the export command"
```

`/design` interviews you, researches the codebase with subagents, asks the mandatory questions (events,
permissions, external exposure, analytics and flags, agent behaviour, UI states and accessibility,
migration and rollback), writes `specs/<name>.md` from `templates/spec.md`, validates the acceptance tests
and adds a `drafted` ledger row. Check it yourself:

```bash
node scripts/lint-spec.mjs --spec specs/<name>.md --strict
```

A good spec has 3-6 phases; each phase has an **Acceptance Tests** block whose rows read
`` `[unit]` testName — Given X, When Y, Then Z ``; every Success Criterion (`SC1`) is cited by a row;
every open question is tagged `[product]` (a person decides) or `[tooling]` (the build loop settles it).
`test/fixtures/example-project/specs/hello.md` is a complete small example.

## 6. Plan

```bash
./ralph/loop.sh plan 1 specs/<name>.md
```

The planner writes `.ralph/IMPLEMENTATION_PLAN.md` (phases, tasks with `Files:` and `Tests:`, the Exit Gate
last) and sets the ledger to `planned`. Run the completeness check; it tells you which requirement of the
spec no task covers:

```bash
node scripts/verify-plan-completeness.mjs --spec specs/<name>.md --strict
```

Read the plan. Its content is not a gate, but a plan that is wrong is cheaper to fix now than after twenty
build iterations; edit it or re-run `plan`. If your base branch is already failing its checks, record that
now: `node scripts/base-health.mjs --base <baseBranch>` (needs `gates.baseHealth.checks` in the config)
measures it in a temporary worktree, and the Exit Gate then asks for "no worse than the base" instead of
"all green" (`node scripts/base-health.mjs --compare`).

## 7. Build

```bash
git tag ralph-checkpoint-1        # a way back
./ralph/loop.sh build 20 specs/<name>.md
```

Each iteration does one task: tests first, implementation, commit, status. Phases are ticked as they
finish; `node scripts/verify-plan-ticks.mjs --before <old plan> --after <new plan> --fix` re-checks any newly
ticked phase (open tasks, a `gate:` command that fails, acceptance rows not bound to a real test) and un-ticks
the ones that did not earn it. `node scripts/verify-acceptance-bindings.mjs --spec specs/<name>.md --all`
shows binding status for every phase at any time. The Exit Gate runs `gates.exitGate` and sets `built`.

`./ralph/loop.sh status` shows where things stand; `node ralph/report.mjs --spec <name>` summarises time,
models and outcomes.

## 8. Review

```bash
./ralph/loop.sh review 5 specs/<name>.md
```

The reviewer reads the whole diff, fixes in slices and buckets findings by whether they are inside the
spec's scope. A clean pass sets `reviewed`. Open `[product]` questions and anything marked outside the
scope are for you.

## 9. Ship

You open and merge the change (as a draft pull request first, ready once green) and change the ledger row to
`shipped`, moving it to **Recently shipped** with the commit SHAs. This step is yours on purpose.

## 10. Run a queue unattended

For several specs, or to walk away, use the `autonomous` skill. In your agent: "work autonomously through
specs/a.md and specs/b.md". The skill runs its pre-flight (clean index, no other loop, `ralph-doctor`,
drift against the base branch), writes `.claude-temp/ralph-queue/QUEUE.md` (see `templates/queue.md`),
starts the detached runner and keeps a waiter alive so the session never silently stops:

```bash
node scripts/ralph-queue.cjs start       # detached runner, bounded by scripts/sweep.mjs
node scripts/ralph-queue.cjs status
node scripts/ralph-queue.cjs watch       # blocks until the runner logs an event or exits
node scripts/ralph-queue.cjs stop        # finish the current invocation, then exit
```

A spec parks (`[!]` in the queue) when it needs a person; the skill decides what the standards decide and
leaves the rest for you with a reason. When you return, read `.ralph/PROGRESS.md`, the ledger and the queue.

## 11. Lanes: specs in parallel

One working tree runs one loop at a time. For two specs at once, give each its own **lane**: a sibling
worktree on its own branch with its own queue and runner.

```bash
node scripts/new-lane.mjs --name backend --base main --dry-run    # show the plan, change nothing
node scripts/new-lane.mjs --name backend --base main
```

This runs `git worktree add -b main-lane-backend ../<project>-lane-backend main`, copies
`ralph.config.json` if it is not tracked, creates the lane's
`.claude-temp/ralph-queue/QUEUE.md`, and prints the next steps: install dependencies in the lane, list the
lane's specs in its queue, `node scripts/ralph-queue.cjs start` there, and mark each moved spec
`- [!] specs/<name>.md — MOVED to lane backend` in the main queue so its runner skips it. Split lanes by the
files specs touch so merges are quiet. When a lane's spec is `reviewed`:

```bash
node scripts/lane-merge-notes.mjs --lane main-lane-backend --base main --spec <name> \
    --ledger-a .ralph/SPECS_LEDGER.md --ledger-b ../<project>-lane-backend/.ralph/SPECS_LEDGER.md
```

prints the checklist (confirm `reviewed`, archive the plan, merge with approval, keep the integration plan,
merge ledger rows, push, other lanes pull) and the row-by-row ledger diff. Neither script ever deletes a
branch or worktree; remove those by hand when you are done.

**Known limits of lanes in this kit.** Lanes work, but merge-back is manual and the rough edges are real:

- Every lane writes the same `.ralph/IMPLEMENTATION_PLAN.md` and `.ralph/SPECS_LEDGER.md`, so every merge
  conflicts on them. Resolve by keeping the integration plan and merging ledger rows one by one (the
  checklist above); do not accept either side wholesale, or rows are lost.
- **Code is not the only thing a lane needs of its own.** If your tests or the Exit Gate touch a database,
  a local server on a fixed port, a cache, a queue or a cloud test environment, two lanes running at once
  share it and break each other's runs in ways that look like flaky tests. Give each lane its own
  ports, database and test environment before you start its runner, or lanes will cost more than they save.
- Two or three lanes is the practical ceiling for one person to supervise.

## 12. Optional: a Jira tracker

Set in `ralph.config.json`:

```json
{ "tracker": { "provider": "jira",
               "jira": { "project": "ABC", "site": "your-team.atlassian.net",
                         "transitions": { "buildStarted": "In Progress", "exitGate": "Review Required",
                                          "designFinalized": "Ready For Development" } } } }
```

Connect the Atlassian MCP server to your agent, put `tracker_issue: ABC-123` in the spec's front matter
(`/design` does it when you bind a ticket), and the driver injects `ralph/TRACKER_jira.md` into every prompt.
Transitions are looked up by status *name* at call time. If a call fails, the agent writes a `JIRA DEGRADED`
line to `.ralph/PROGRESS.md` and keeps working; `.githooks/pre-commit` (via `scripts/verify-jira-sync.mjs`)
then refuses commits until the call is retried and the line removed. With `provider: "none"` none of this
runs and no prompt mentions a tracker.

## Troubleshooting

| Symptom | Likely cause and fix |
|---------|----------------------|
| `ralph-doctor`: agent CLI FAIL | The `claude` command is not on PATH. Install it, set `agent.command`, or set `RALPH_AGENT_CMD` to an executable (or `node path/to/script.mjs`). |
| `ralph-doctor`: config FAIL | The message names the offending key, for example `"queue.maxBuild" must be a non-negative number`. |
| Commit blocked: `JIRA DEGRADED` | Retry the failed tracker call, then delete the marker line from `.ralph/PROGRESS.md`. If the tracker is down for the whole run, restart the loop with `--skip-tracker`. |
| Commit blocked by a `hooks.preCommit` command | The output names the command and its exit code; fix that, do not bypass with `--no-verify`. |
| Hooks do nothing | `git config core.hooksPath` is not `.githooks`; run `node scripts/install-hooks.mjs`. |
| `verify-acceptance-bindings` says `missing` | No file matching `tests.globs` has a test, `describe` or function with that exact name. Fix the name in the spec or the test, or widen `tests.globs`. |
| ... says `wrong-layer` | The test is in a file that does not match the layer the row's tag demands in `tests.layers`. Move it, adjust the globs, or retag the row. |
| ... says `no-assertion` | The test body has no `expect(`, `assert`, `should` or `t.is`-style call. |
| `verify-plan-completeness` lists UNREFERENCED items | No plan task mentions that table row, test name or decision id. Add it to a task's text, with a `Files:` line. |
| `base-health` says "nothing to measure" | `gates.baseHealth.checks` is empty. Add `{ "name": "...", "command": "..." }` entries. |
| `base-health` exits 2: base ref does not exist | Pass `--base <ref>` or fetch `origin/<project.baseBranch>`. |
| A queue never moves | `node scripts/ralph-queue.cjs status`; a `[!]` line names the reason. Change it back to `[ ]` to re-queue after you act. |
| Windows: the hook does not run | Git for Windows runs `.githooks/pre-commit` with its bundled `sh`; make sure `node` is on the PATH that Git sees, and that the file has LF line endings (the kit's `.gitattributes` enforces it). |
| Orphaned processes after an interrupted run | Only `scripts/sweep.mjs` starts or stops long jobs: `node scripts/sweep.mjs status`, then `node scripts/sweep.mjs reap`. |

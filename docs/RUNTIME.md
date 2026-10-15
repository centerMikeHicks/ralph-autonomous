# Runtime reference

The Node runtime under `scripts/` and `ralph/report.mjs`: the queue runner, the process owner
(`sweep`), the keep-awake helper, the config loader and the telemetry report. Zero dependencies,
Node >= 20, Windows / macOS / Linux. Logic is in Node; no `taskkill`, `pkill`, `kill -9` or `setsid`.

Every file states its module type in its extension: `.cjs` is CommonJS (`ralph-queue.cjs`,
`lib/sweep.cjs`, `lib/keep-awake.cjs`, `hooks/require-agent-model.cjs`), `.mjs` is ESM. Nothing depends on
a `"type"` field, so the kit behaves the same whether your project's `package.json` says `"module"`,
`"commonjs"` or nothing, and it adds no `package.json` to your `scripts/` folder.

## Project root

Every script resolves one root, in this order: `RALPH_ROOT` (env), the nearest directory at or
above the cwd that holds `ralph.config.json`, the nearest such directory above the kit's own folder,
the nearest directory holding `.git`, else the cwd. State lives under that root: `.ralph/` (the
configured `project.stateDir`) and `.claude-temp/`.

## Queue runner: `scripts/ralph-queue.cjs`

Carries a list of specs through `ralph/loop` plan -> build -> review, one spec at a time, with no
agent session needed to stay open.

```
node scripts/ralph-queue.cjs start   [--queue F] [flags]   launch detached via sweep (--service --detached --idle-min 0)
node scripts/ralph-queue.cjs run     [--queue F] [flags]   the runner itself, foreground
node scripts/ralph-queue.cjs status  [--queue F]           runner liveness, queue, last 8 events
node scripts/ralph-queue.cjs watch   [--timeout-min N]     block until a new event is logged or the runner exits
node scripts/ralph-queue.cjs stop                          write STOP; the runner exits after the current invocation
```

Flags (defaults from `queue.*` in `ralph.config.json`; a flag wins): `--build-chunk` (3, build
iterations per loop invocation), `--max-build` (40, build iterations per spec before it is parked),
`--max-review` (8, review passes per spec before it is parked for a scope audit; 0 = no cap),
`--min-free-gb` (4, free memory required before each invocation), `--max-retries` (3, re-runs of an
interrupted invocation), `--timeout-min` (`queue.watchTimeoutMin`, 45, for `watch`), `--queue`.

### Queue grammar

Default file `.claude-temp/ralph-queue/QUEUE.md`. One spec per line; other lines are ignored.

```
- [ ] specs/next.md            pending
- [x] specs/done.md — note     finished (reviewed or shipped)
- [!] specs/stuck.md — reason  parked: needs a person
```

The runner takes the first `[ ]` entry, drives it, and rewrites that line's marker and note in place
(line endings preserved). To re-queue a parked spec, change `[!]` back to `[ ]` and drop the note.

### Mode table

The mode is read from the spec's row in `.ralph/SPECS_LEDGER.md` (the `State` column of the row whose
first cell is the spec path in backticks) and `.ralph/ACTIVE_SPEC`:

| Ledger state | Active spec is this spec | Mode |
| --- | --- | --- |
| none (no row) | any | `plan` |
| `drafted` | any | `plan` |
| `planned` | yes / no | `build` / `plan` |
| `built` | yes / no | `review` / `plan` |
| `reviewed`, `shipped` | any | `done` (queue line marked `[x]`) |
| `paused`, `superseded`, anything else | any | `skip` (parked `[!]`) |

The loop is `ralph/loop.ps1` on Windows (`powershell -NoProfile -ExecutionPolicy Bypass -File`) and
`ralph/loop.sh` elsewhere (`bash`), invoked as `<mode> <count> [spec]`; the spec is passed for `plan`
only. `build` runs `min(buildChunk, maxBuild - done)` iterations per invocation; `plan` and `review`
run one. Output goes to `.claude-temp/ralph-queue/loop-<spec>-<mode>-<ms>.log`.

### Classification of an invocation

From the rows the invocation appended to `.ralph/iterations.jsonl` (for that spec) and the exit code
(BOM- and CRLF-tolerant):

- `interrupted`: any row has `outcome: aborted`; or no rows and a non-zero exit; or the last outcome
  starts with `error` and nothing was committed. Retried after the memory floor clears, up to
  `maxRetries`, then the spec is parked.
- `blocked`: no rows and exit 0; the last outcome is `blocked`; or `failed` with no commit in the
  invocation. The spec is parked with the row's `next` / `result` as the reason.
- `progressed`: anything else. The ledger is re-read and the next mode chosen.

Also parked: the build cap (`maxBuild` build iterations without reaching `built`), the review cap
(`maxReview` review passes without reaching `reviewed`), and a `plan` or `review` that runs twice in a
row neither committing nor moving the ledger. A review pass that commits fixes counts as progress even
though the ledger stays at `built`; without that rule a review that is fixing real findings parks after
two passes, and in practice that was the most common reason specs stopped overnight.

Memory floor: before each invocation the runner waits (checking every 60 s, honouring STOP) until
`os.freemem()` is at least `--min-free-gb`. Note that macOS reports free memory without file cache, so
lower the floor there if it waits unnecessarily.

### State files (`.claude-temp/ralph-queue/`)

| File | Purpose |
| --- | --- |
| `QUEUE.md` | input and status board |
| `state.json` | `runnerPid`, current `spec` / `mode` / ledger `state`, `loopPid`, `loopLog`, `finished` |
| `events.jsonl` | one event per line: `runner_start`, `loop_start`, `loop_end`, `retry`, `spec_done`, `spec_parked`, `memory_wait`, `memory_ok`, `keep_awake_*`, `queue_empty`, `runner_stopped`, `runner_end` |
| `STOP` | presence asks the runner to stop after the current invocation |
| `runner/` | the sweep directory of the detached runner (`sweep.json`, `run.log`, ...) |
| `loop-*.log` | one log per loop invocation |

`start` runs `node scripts/sweep.mjs run --dir .claude-temp/ralph-queue/runner --cwd <root> --env RALPH_ROOT=<root> --service --detached --idle-min 0 -- node scripts/ralph-queue.cjs run ...`.
`--detached`: the runner must outlive the session that started it. `--idle-min 0`: it is quiet for
hours while a loop works, so the idle ceiling must not apply; each loop keeps its own ceilings.
Exported pure helpers: `parseQueue`, `updateQueueLine`, `ledgerState`, `nextMode`,
`classifyInvocation`, `parseArgs`, `startArgs`, plus `driveSpec(entry, opts, ctx)`, `run`,
`makeContext`, `read`, `jsonlLines`. `ctx.runLoop` may be set to replace the loop launcher (tests).

## Process owner: `scripts/sweep.mjs` and `scripts/lib/sweep.cjs`

The only code in the kit that starts a detached job or kills a process. A *sweep* is a job recorded in
a directory and watched by a detached watcher process.

```
node scripts/sweep.mjs run --dir D [--name X] [--env K=V]... [--timeout-min N] [--stall-min N]
                           [--service] [--detached] [--owner PID|auto|none] [--idle-min N]
                           [--max-mem-mb N] [--cwd DIR] [--log FILE] [--json] -- cmd args...
node scripts/sweep.mjs wait   [--root R] [--max-min N] [--summary FILE]
node scripts/sweep.mjs kill   (--dir D | --pid P [--started ISO]) [--reason TEXT]
node scripts/sweep.mjs reap   [--stale] [--root R]
node scripts/sweep.mjs status [--root R] [--json]
```

`run` spawns with `shell: false`; `node`, `npm` and `npx` resolve to this Node and npm's CLI entry
(so `npm` works on Windows without `npm.cmd`); `.cmd` / `.bat` shims are refused. It returns once
`sweep.json` exists. The watcher then enforces the ceilings, kills the **whole tree** (found by
walking parent links in a fresh process listing), kills what the child left running, reaps orphaned
headless browsers, appends `exit=<verdict>` to `run.log` and replaces `sweep.json` with
`sweep.done.json`.

### Ceilings and verdicts

| Option | Default | Verdict when hit |
| --- | --- | --- |
| `--timeout-min` | `sweep.timeoutMin` (180) | `timeout` (hard ceiling; 0 = none) |
| `--stall-min` | `sweep.stallMin` (20) | `timeout` (neither `run.log` nor `heartbeat.json` advanced; 0 = none) |
| `--max-mem-mb` | none | `memory` (tree private memory, RSS on POSIX, over the limit on two consecutive 60 s checks) |
| `--idle-min` | 0 when owned, 240 when unowned | `idle` (services only) |
| owner exits | | `owner-gone` (services only) |

Other verdicts: the child's exit code as a string (`0`, `3`), `killed` (by `kill`, or ended by signal),
`lost` (the watcher or process vanished; closed by `wait` or `reap --stale`). Services have no timeout
or stall ceiling.

A check reports progress with `heartbeat(phase, detail)` (exported from `scripts/lib/sweep.cjs`; a no-op
outside a sweep, writes `<SWEEP_DIR>/heartbeat.json`); a fresh heartbeat resets the stall clock.
The watcher gives the child `SWEEP_DIR`. `wait` never waits on the sweep it runs inside.

### Services and owners

`--service` marks a server or other long-lived job: not waited on, no timeout / stall ceilings, and
bound to an **owner**: the outermost ancestor of the caller that is either a Ralph loop (a process whose
command line names `ralph/loop.ps1` or `ralph/loop.sh`) or an agent CLI whose process name is in
`sweep.ownerProcessNames` (default `["claude"]`; matched on the executable name without `.exe`, or a
`node_modules/.../<name>*` path for an npm-installed CLI). If no such ancestor exists the service has no
owner and gets the 240 minute idle ceiling. `--owner PID` binds to a given process, `--owner none` or
`--detached` means no owner. The watcher checks the owner (pid plus start time, so pid reuse is
ruled out) every 60 s. `reap --stale` stops services whose owner is gone and closes records whose
processes are all gone; run it at session and loop start.

### Other behaviour

- `wait` blocks until no non-service sweep is running under `<root>/.claude-temp`; it adopts a sweep
  whose watcher died (enforcing that sweep's own ceilings), closes fully dead records as `lost`, and
  kills what remains at `--max-min` (240). `--summary` writes `[{ dir, name, seconds, verdict }]`.
- `kill --dir` stops the child tree and the watcher; `kill --pid P [--started ISO]` kills a tree and
  refuses a pid whose start time differs from `--started`.
- Orphan reaping targets headless browsers (chrome, chromium, msedge, headless_shell) whose command
  line has `--headless` and whose parent is gone; an interactive browser is never touched.
- OS differences are confined to `listProcesses` (Windows: Win32_Process via `powershell.exe`; POSIX:
  `ps -A -ww -o pid=,ppid=,stat=,etime=,rss=,args=`) and `signal` (Node `process.kill`; SIGTERM then
  SIGKILL after 3 s on POSIX, TerminateProcess on Windows).

## Keep-awake: `scripts/lib/keep-awake.cjs`

`acquireKeepAwake({ ownerPid, log })` returns `{ held, pid, release() }` and never throws. The runner
holds it only while queue work remains and releases it on exit or signal.

| OS | Holder |
| --- | --- |
| Windows | `powershell.exe` calling `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)`; exits when the owner pid is gone |
| macOS | `caffeinate -i -w <ownerPid>` |
| Linux | `systemd-inhibit --what=sleep ... tail --pid=<ownerPid> -f /dev/null` when `systemd-inhibit` exists, else a logged no-op |

The holder is a child of the caller and is stopped through `sweep.killPids`. Events logged through
`log`: `keep_awake_on`, `keep_awake_off`, `keep_awake_unavailable`, `keep_awake_failed`.

## Config: `scripts/lib/config.mjs`

```js
import { loadConfig, findRoot, getCommand, DEFAULTS } from './scripts/lib/config.mjs';
const config = loadConfig();            // loadConfig(root?) -> DEFAULTS deep-merged with <root>/ralph.config.json
```

- Objects merge key by key; arrays and scalars in the file replace the default; unknown keys are kept;
  a UTF-8 BOM is tolerated.
- Validation is light and reports every problem at once, naming the file and the dotted key
  (`"queue.maxBuild" must be a non-negative number, got "lots"`). Command values must be `null`, a
  non-empty string, or a non-empty array of strings.
- `findRoot(start = cwd, { kitDir })` walks up to `ralph.config.json`, then (from `kitDir`) again,
  then to `.git`, else returns `start`. `resolveRoot(import.meta.url)` adds the `RALPH_ROOT` override.
- `getCommand(config, name)` returns `null` when the command is unset, else
  `{ kind: 'shell', command, args: [], display }` for a string (run through a shell) or
  `{ kind: 'argv', command, args, display }` for an array (run without one).
- `sweep.ownerProcessNames` is the one key added to the sweep section beyond `timeoutMin` and `stallMin`.

## Telemetry report: `ralph/report.mjs`

```
node ralph/report.mjs [--spec S] [--since DATE] [--gap SECONDS] [--top N]
```

Reads `<stateDir>/iterations.jsonl`, `loop-events.jsonl` and the `transcript` files named by the
iteration rows, and prints: time per phase (wall = model + tools + overhead, plus idle-before,
commits, blocked, cost); an outcome histogram with the cost of no-progress iterations and the longest
blocked streak; gaps longer than `--gap` (default 300 s) with the loop events inside them; and the
slowest tool calls plus per-tool totals when transcripts were kept. Aborted iterations have no
transcript, so their cost is unknown and every cost total is then a floor. `buildReport({ stateDir,
spec, since, gap, top })` returns the same text for programmatic use.

## Tracker: Jira (injected because `tracker.provider = "jira"`)

This block is added to the prompt by the driver. It tells you how to keep the bound Jira issue in sync
with the loop. **Tracker work never blocks code work.** If anything below fails, record it and carry on.

### Binding and state

- The issue key is `tracker_issue` in the active spec's YAML front matter (the driver also tells you
  the key and the state file path above this block). No key means there is nothing to sync; skip all of
  this and say nothing.
- Coordination state lives in `.ralph/tracker/<spec-basename>.json`:
  `{ "issue": "KEY-1", "spec": "specs/<name>.md", "events": [ { "phase": "...", "at": "<ISO UTC>", "comment_id": "..." } ] }`.
  Treat a missing file as `events: []`. Append events; never delete earlier ones. Write the file back
  with a heredoc.
- **Idempotency:** `plan_started`, `build_started` and `review_required` are posted at most once per spec
  (skip if the phase is already in `events[]`). `review_run` is posted on every review iteration.
  `design_finalized` is written by the design command.
- Use the Atlassian MCP tools (names as exposed in your session, for example `getJiraIssue`,
  `getTransitionsForJiraIssue`, `transitionJiraIssue`, `addCommentToJiraIssue`, `editJiraIssue`). Resolve
  the cloud/site once per session from `tracker.jira.cloudId` or `getAccessibleAtlassianResources`.

### Transitions are by status NAME, resolved at call time

Never hard-code a transition id. To move an issue: call `getTransitionsForJiraIssue`, pick the transition
whose target status name equals the configured name (from `tracker.jira.transitions`), and pass the id it
returns to `transitionJiraIssue`. If the issue is already in the target status, skip the transition but
still post the comment. If the transition is not offered from the current status, treat that as a
failure (below); do not force a different one.

| Event | Mode | Transition to (config key) | Comment |
|-------|------|----------------------------|---------|
| `plan_started` | plan, first iteration | none (the issue should already be at `designFinalized`; if not, note it under Open Questions) | below |
| `build_started` | build, first iteration | `buildStarted` (default "In Progress") | below |
| `review_required` | build, Exit Gate about to commit | `exitGate` (default "Review Required") | below |
| `review_run` | review, every iteration | none (a person closes the issue) | below |
| `design_finalized` | design command | `designFinalized` (default "Ready For Development") | below |

### Comment templates

`plan_started`:
```
Planning underway

Spec: <spec path>
Branch: <git branch --show-current>
```

`build_started`:
```
Implementation started

Spec: <spec path>
Branch: <branch>
Next phase: <name of the phase marked <- NEXT>
```

`review_required` (post and transition before the Exit Gate commit so the event lands in it):
```
Implementation ready for review

Spec: <spec path>
Phases completed: <count of [x] phases>
Last commit: <short sha>
Gates: <each exit gate command: pass | fail | not configured>
```

`review_run`:
```
Review pass complete

Fixes applied: <n>
Remaining for human review: <n>
Deferred (outside spec): <n> - <ids or one-line each>

<one-line summary>
```
Findings deferred as "outside the spec, pre-existing" are listed here; if one deserves its own issue,
create it with `createJiraIssue` (or `createIssueLink`) and link it, and record its key in the plan's
Open Questions. If you cannot create it, the plan's Open Questions row is the durable record.

`design_finalized` (written by the design command, shown for reference):
```
Design finalized

Spec: specs/<name>.md
Branch: <branch>

Ready for: ./ralph/loop.sh plan 1 specs/<name>.md
```

Per-iteration chatter is not posted: no "iteration N started", no per-phase comments. The commit
prefix `<KEY>` already links commits to the issue.

### When a tracker call fails (degraded mode)

Any failure (network, auth, tool unavailable, transition not offered) is **not silent and not fatal**:

1. Write one line at the top of `.ralph/PROGRESS.md`:
   `JIRA DEGRADED: spec=<name> mode=<plan|build|review> phase=<phase> error=<one-line error>`
   and print the same line to stdout.
2. Continue the iteration normally. Do not append the event to `events[]` (so it retries next iteration).
3. On the next iteration, retry any event missing from `events[]` first. As soon as a retry succeeds,
   **remove the `JIRA DEGRADED` line**; the pre-commit hook (`node scripts/verify-jira-sync.mjs`)
   refuses commits while the marker is present, so a stale marker blocks your own commit.
4. If the same call has failed on three consecutive iterations, say so in `result` so a person looks.
   Never mark an event done that you did not complete.

### Authority limits

You may comment, transition along the configured path, create and link follow-up issues, and edit the
description only when the design command says so. You never delete issues, reassign them, change
priority or fix versions, close an issue as Done, or approve anything on a person's behalf.

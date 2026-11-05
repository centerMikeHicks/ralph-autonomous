## Tracker: Kairos (injected because `tracker.provider = "kairos"`)

The driver tells Kairos what this run does and asks it before each iteration whether the run may go on. **You do nothing to keep Kairos in sync,** and you have no credentials for it. Do not try to reach it.

### A question for a person

When the spec cannot answer something and nothing else is workable, do what the prompt says: record it as a `[product]` Open Question and end the iteration with outcome `blocked`. The driver then puts it in the owner's queue in Kairos, and later runs wait until it is answered.

So that the person can answer it without opening the code, write `next` in `ITERATION_STATUS.json` as **the question itself, in one line**, and write each `[product]` Open Question with the options and what each gives up.

### Answers

A person's answers to earlier questions appear below this block, if there are any. They are that person's decisions:

- apply them, tick the matching Open Question, and record each under `## Decisions` as the owner's;
- if an answer goes against the spec, or you cannot apply it, ask again: do not work around it.

### The plan

Kairos holds the plan. You still read and edit `.ralph/IMPLEMENTATION_PLAN.md`; the driver sends it after each iteration, and brings in any change a person made before the next. So:

- under `## Decisions`, each decision you make on your own is one line that a person can read without opening the code: they see it on the item;
- if the plan was sent back, a person's words are below this block: change the plan to answer them, and do no more than that;
- change a phase or its tests only if you must. It needs approving again before the build can go on, and the run stops until it is. Splitting a task inside a phase does not.

### What you may decide

The last line of this block says what this item's build may do on its own.

- **hands-on, balanced:** anything the spec and `standards/` do not settle is a question for a person, as above.
- **hands-off:** decide what the spec and `standards/` leave open, and record each under `## Decisions` with the rule or reason behind it. A question goes to a person only if it is about larger scope, risk or spending. You still never sign, merge or do any of the things the prompt forbids.

### What you find outside the spec

Everything you find that the spec did not ask for goes in the plan under `## Scope changes`, one line each, numbered `S1`, `S2` and so on, never reused. The driver sends these to Kairos, and Kairos files any new items. Ask yourself one question: **does this stop an outcome of this work being reached?**

**No, it blocks nothing.** Do not build it. Add a line, and carry on. A person decides whether it is ever built.

```
- S2 filed bug - The audit export has no paging. Route: platform-fix. Evidence: src/audit.ts:41.
```

The word after `filed` is its kind (`bug`, `chore`, `request`, `security`). `Route` is one of `platform-fix`, `platform-chore`, `platform-feature`, `design-system-change`, `experience`. A vulnerability's kind is `security`, and its details go nowhere but this line.

**Yes, it blocks.** First decide whether it is small. It is small only if it fits this pull request, adds no phase to the plan, and touches no risk area.

- **Small, and this item is hands-off:** build it, and add a line. Name the commit's `S<n>` in its message. `Blocks` is an outcome's id or the exact name of an acceptance test in the spec. `Evidence` is what shows it blocks: a failing test, a command's output.
  ```
  - S1 included - The helper throws on empty input. Blocks: flagIsRead. Evidence: flagIsRead fails with "undefined" on an empty org. Commits: abc1234.
  ```
- **Anything else:** do not build it. Add a line, end the iteration with outcome `blocked`, and write `next` as the question. It is filed as its own item, and the owner decides.
  ```
  - S3 blocking request - The client has no key for the flag service. Blocks: o1. Evidence: the deploy has no such setting. Area: who can see what.
  ```

`Area` names the risk area it touches, if any. An inclusion that names a risk area, names nothing it blocks, or gives no evidence goes to the owner, and runs wait for their answer. Included work has a limit on what it may cost, and past it the owner is asked. The driver compares what you changed with the `Files:` in the plan, and shows the owner anything the plan does not name, so an addition you leave out will still be seen.

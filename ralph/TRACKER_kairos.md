## Tracker: Kairos (injected because `tracker.provider = "kairos"`)

The driver tells Kairos what this run does and asks it before each iteration whether the run may go on. **You do nothing to keep Kairos in sync,** and you have no credentials for it. Do not try to reach it.

### A question for a person

When the spec cannot answer something and nothing else is workable, do what the prompt says: record it as a `[product]` Open Question and end the iteration with outcome `blocked`. The driver then puts it in the owner's queue in Kairos, and later runs wait until it is answered.

So that the person can answer it without opening the code, write `next` in `ITERATION_STATUS.json` as **the question itself, in one line**, and write each `[product]` Open Question with the options and what each gives up.

### Answers

A person's answers to earlier questions appear below this block, if there are any. They are that person's decisions:

- apply them, tick the matching Open Question, and record each under `## Decisions` as the owner's;
- if an answer goes against the spec, or you cannot apply it, ask again: do not work around it.

### Follow-ups

Findings deferred as "outside the spec, pre-existing" go in the plan's Open Questions, as the prompt says. A person files them as items.

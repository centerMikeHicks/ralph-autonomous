---
process: center:process
default_branch: main
worktrees: ../branches/{repo}-exp-{key}-{slug}

build:
  base: main
  spec: /design {key}
  branch: "exp/{key}-{slug}"
  worktree: git worktree add ../branches/ralph-autonomous-exp-{key}-{slug} -b exp/{key}-{slug} origin/main
  loop: .\ralph\loop.ps1 plan 1 {spec}
  autonomous: autonomous
---

# The kit's settings for the kairos skills

This is ralph-autonomous, the loop kit: the loop (`ralph/`), its scripts (`scripts/`), hooks (`.githooks/`), agent skills and commands (`.claude/`) and templates (`templates/`). `README.md` and `docs/` say how it works. It has no prototypes and no design system, so those settings are left out. It has no dependencies to install.

## How an item is built

The kit's work items are built with the kit's own loop (decided by the owner on KAI-70, 5 Nov 2026).
- **Spec:** `/design {key}` writes it to `specs/`, with the person.
- **A Hands-off item** goes to `build.autonomous`: the queue runner, `scripts/ralph-queue.cjs`, with the item's spec as the only line in its queue.
- **Any other item** is planned with `build.loop`. Its plan goes to Kairos and waits for a person's approval there. It is then built and reviewed with the same command, with `build` or `review` and a number of iterations in place of `plan 1`.

Each run is in a worktree of the item's branch (`build.worktree`), never the main checkout, on the machine of the person who runs it. The machine's own credentials are within the loop's reach.

**The loop is building itself.** The driver loads its code when a run starts, but the scripts it calls each iteration (`scripts/`) are read fresh. So a run can pick up a half-built change to its own scripts. Start a new run after a phase that changes the driver or the plan checks, rather than one long build.

To stop a run, create `.ralph/STOP` in the worktree, or run `node scripts/ralph-queue.cjs stop`. `ralph.config.json` sets no spend caps of its own, so the item's cap in Kairos is the cap.

## The run key

There is no `key_file`. The loop takes the item's key only from `KAIROS_RUN_TOKEN`, with `KAIROS_URL=https://mcp.kairos.c3nt3r.com`, in the environment of the shell that starts it (`ralph/lib/kairos.mjs`). The driver keeps the key from the agent's environment (`ralph/lib/agent.mjs`).
- `ralph.config.json` names no tracker, so set `RALPH_TRACKER_PROVIDER=kairos` as well, and bind the spec to its item with `tracker_issue` in its front matter (or `-Issue {key}` on the first run).
- A key made with `make_run_key` is kept in `~/.demiurge-keys/<KEY>.json`, as `{ "item": "<KEY>", "token": "<the key>" }`, readable only by its owner, beside the factory's other keys. The person's start command reads it from there.

## The gate

`ralph.config.json`'s Exit Gate is `npm test`. Three tests already fail on `main` (`b3cb7ea`), one each in `test/verify-plan-completeness.test.mjs`, `test/lint-spec.test.mjs` and `test/example-project.test.mjs`. A build must not add to them.

## Keys, branches and copies

Kairos gives each item its key. Branches are `exp/{key}-{slug}` (decided by the owner on KAI-70, 5 Nov 2026). The kit is copied into Demiurge, and into Kairos once KAI-72 lands, by hand (Demiurge's D85): a change is made here and copied in, with the copy's `ralph/VERSION` naming the kit commit.

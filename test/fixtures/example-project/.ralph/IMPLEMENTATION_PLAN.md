# Implementation Plan

## Status: Phase 2 in progress

## Active Spec

`specs/hello.md`

## Phases

- [x] **Phase 1: Greeting function**
  gate: `node --test src/hello.test.mjs`
  - [x] Build `formatGreeting` for the greeting message (D1) [sonnet]
    Files: src/hello.mjs, src/hello.test.mjs
    Tests: greetsByName, greetsTheWorldWithoutName
- [ ] **Phase 2: CLI entry** ← NEXT
  - [ ] Build `run` in `src/cli.mjs` so the cli prints the greeting [sonnet]
    Files: src/cli.mjs, src/cli.integration.test.mjs
    Tests: cliPrintsGreeting
- [ ] **Exit Gate**

## Decisions

- D1 — The greeting is a pure function; the CLI ships in phase 2.

## Waivers

None.

## Open Questions / Blocked

None.

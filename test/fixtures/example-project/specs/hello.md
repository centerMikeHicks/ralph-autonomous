---
title: Hello greeting
# tracker_issue: PROJ-1   (only when tracker.provider is "jira")
---

# Hello Greeting

## Overview

A tiny worked example: a greeting function and a CLI entry that prints it.

## Problem Statement

### Current State

There is no way to produce a greeting.

### Desired State

`formatGreeting(name)` returns a greeting and the CLI prints it.

### Success Criteria

- [ ] SC1: A name produces a greeting for that name, and no name greets the world.
- [ ] SC2: The CLI prints the greeting for its first argument.

## Scope

### In Scope

- The greeting function and the CLI entry.

### Out of Scope

- Localisation of the greeting.

### Dependencies

- None.

## Technical Design

### Data Model

| Item | Change |
|------|--------|
| greeting message | new: `formatGreeting(name)` in `src/hello.mjs` |

### API Design

No network API; the CLI is the only entry point.

### Service Changes

| Component | Change |
|-----------|--------|
| cli | new: `src/cli.mjs` prints the greeting |

### Decisions

**D1 — The greeting is a pure function; the CLI ships in phase 2**
Keeping formatting separate from output makes the greeting testable without capturing output.

## Implementation Plan

### Phase 1: Greeting function

Build `formatGreeting` in `src/hello.mjs` (D1).

**Acceptance Tests**

- [ ] `[unit]` greetsByName — Given the name "Ada", When formatting, Then the result is "Hello, Ada!" (SC1)
- [ ] `[unit]` greetsTheWorldWithoutName — Given an empty name, When formatting, Then the result is "Hello, world!" (SC1)

### Phase 2: CLI entry

Build `run` in `src/cli.mjs`.

**Acceptance Tests**

- [ ] `[integration]` cliPrintsGreeting — Given the argument "Ada", When the CLI runs, Then it writes "Hello, Ada!" and returns 0 (SC2)

### Exit Gate

**Acceptance Tests**

- [ ] `[unit]` `node --test` exits 0 for the whole project (SC1, SC2)
- [ ] `[e2e]` — none: the CLI has no deployed surface to exercise end to end

## Edge Cases

- A name of only whitespace greets the world.

## Security Considerations

The greeting is plain text and never evaluated.

## Testing Strategy

Unit tests for the function, one integration test for the CLI entry.

## Open Questions

- [x] `[tooling]` Which test runner? Resolved: the built-in `node --test`.

## References

- None.

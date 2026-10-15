---
title: <Feature name>
# tracker_issue: PROJ-123      (add only when tracker.provider is "jira")
# tracker_project: PROJ
---

# <Feature name>

## Overview

One paragraph: what is being built and why it matters. Name the people it serves and the outcome
they get. This is the paragraph a reviewer reads first and a planner re-reads when a phase looks
ambiguous.

## Problem Statement

### Current State

What exists today and where it falls short. Cite files, behaviours and numbers, not impressions.

### Desired State

What is true once this ships, in observable terms.

### Success Criteria

Each criterion must be traced to an acceptance row below by citing its id there, for example "(SC1)".

- [ ] SC1: <An observable outcome a test can decide.>
- [ ] SC2: <A second outcome, phrased so that a failing test would disprove it.>

## Scope

### In Scope

- <What this spec delivers.>

### Out of Scope

- <What it deliberately does not, so the build loop does not drift into it.>

### Dependencies

- <Other specs, services or access this needs, or "None".>

## Technical Design

### Data Model

Rows with a change of "none" are ignored by the plan check; list every stored shape this touches.

| Item | Change |
|------|--------|
| `<entity or field>` | <new / changed: what and where> |

### API Design

Entry points added or changed (routes, commands, functions, events): inputs, outputs, errors.

### Service Changes

| Component | Change |
|-----------|--------|
| `<component or path>` | <what changes> |

### Decisions

Record each decision once, with a stable id. State plainly whether it is in scope ("ships in phase 2")
or not ("not built in v1").

**D1 — <Decision title>**
<The choice, the alternatives rejected, and the reason.>

## Implementation Plan

Phases are small enough to finish in a few build iterations. Each phase lists the acceptance tests
that prove it, in the form `[tag] name — Given X, When Y, Then Z`, with the tag one of `unit`,
`integration`, `e2e` or `visual-only`. A test name is a single identifier the test is titled with.
A layer with nothing to prove says so: `[e2e]` — none: <why>.

### Phase 1: <First deliverable>

<What this phase builds and the files it touches.>

**Acceptance Tests**

- [ ] `[unit]` exampleBehaviourHolds — Given <starting state>, When <action>, Then <observable result> (SC1)
- [ ] `[unit]` exampleFailureIsReported — Given <bad input>, When <action>, Then <the error the caller sees> (SC2)

### Phase 2: <Second deliverable>

<What this phase builds.>

**Acceptance Tests**

- [ ] `[integration]` exampleEntryPointWorksEndToEnd — Given <setup>, When <the entry point is invoked>, Then <observable result> (SC1)

### Exit Gate

The final sweep: the project's checks, the full acceptance set, and the cleanup of anything the
earlier phases left open.

**Acceptance Tests**

- [ ] `[unit]` `npm test` exits 0 across the project (SC1, SC2)
- [ ] `[e2e]` — none: <why this spec has no end-to-end surface, or name the test>

## Edge Cases

- <A boundary, an empty input, a concurrent caller, a partial failure, and what should happen.>

## Security Considerations

Who may do this; what input is untrusted; what data is sensitive; what is logged. If nothing here
applies, say why.

## Testing Strategy

Which layers carry which risks, what is faked and what is real, and what the Exit Gate runs.

## Open Questions

Tag every entry. `[product]` needs a person to decide and may park the spec; `[tooling]` is
something the build loop resolves itself and records.

- [ ] `[product]` <A question only a person can answer.>
- [ ] `[tooling]` <A question the build loop can settle by trying.>

## References

- <Links to related specs, docs or code.>

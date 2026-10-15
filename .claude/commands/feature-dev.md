---
description: Attended, human-paced feature development - explore, ask, design, implement, verify. The interactive counterpart to the unattended Ralph loop.
argument-hint: <feature description or specs/file.md>
---

# Feature Development (attended)

Use this when a person is present and wants to steer: a small or exploratory change, a spike, or work
that does not justify a full spec. For larger work with a contract, use `/design` then the loop.

Request: $ARGUMENTS

## Principles

- Understand before acting; read the code that will be touched and the standards that apply.
- Ask when a decision is the person's. Batch independent questions; do not ask what the code answers.
- Simple, readable, consistent with existing patterns. No scope beyond the request.
- Fix root causes. No band-aids, loosened checks, or swallowed errors.
- Track progress with a short todo list. Do not commit until the person says so.
- Subagents get an explicit `model` (`haiku` lookups, `sonnet` analysis, `opus` only for open design or
  security trade-offs).

## 1. Explore

If the request names a spec, read it. Launch 2-3 `Explore` subagents in parallel (`sonnet`), each on a
different angle: the closest existing feature, the module that will own this, the test conventions for
the layers involved. Ask each for `file:line` lists. Read the key files they name. Read `standards/README.md`
and the rule files for the surfaces you will touch.

## 2. Clarify

List what is ambiguous or undecided (behaviour, edge cases, compatibility, scope boundaries) and ask the
person in one batch. Wait for answers. If a spec exists, its Open Questions come first.

## 3. Design

Propose one approach with its files, data flow and test plan, and name one alternative with the trade-off.
Recommend one (a complete solution, never a shortcut). Get approval before editing code. Use a `Plan` or
architecture subagent when module boundaries are unclear.

## 4. Implement

Write the tests that describe the behaviour first and watch them fail for the right reason, then the
smallest correct change. Follow the standards. Keep each step small and verify as you go with the project
commands in `ralph.config.json` (`commands.test`, `lint`, `typecheck`, `build`; `null` means not
configured, say so rather than claiming green).

## 5. Verify

Run the full set the project defines in `gates.exitGate`. Then ask the review agent (`code-review`) to
review the diff against `standards/`; fix criticals and in-scope warnings; report the rest with their
scope. If a spec exists, check each acceptance test row has a passing, correctly bound test
(`node scripts/verify-acceptance-bindings.mjs --spec <S>`).

## 6. Summarise

Report: what changed (files), what was verified (each command, pass/fail/not configured), decisions made,
anything deferred and why, and suggested next steps. Offer to commit; commit only when the person
agrees, staging files by path.

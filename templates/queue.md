# Ralph queue

One spec per line, worked top to bottom by `node scripts/ralph-queue.cjs`. The runner rewrites the
marker and reason in place; edit this file to add, reorder or re-queue specs.

- `- [ ] specs/name.md`  pending
- `- [x] specs/name.md — note`  reviewed
- `- [!] specs/name.md — reason`  parked: needs a person (change back to `[ ]` to re-queue)
- `- [!] specs/name.md — MOVED to lane <name>`  handed to a parallel lane; this runner skips it

Where a spec starts is read from its state in `.ralph/SPECS_LEDGER.md`: drafted -> plan, planned -> build,
built -> review, reviewed or shipped -> done, paused or superseded -> parked.

<!-- add entries below, one per line: - [ ] specs/your-spec.md -->

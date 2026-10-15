# Examples

`specs/team-invitations.md` is a worked example of a spec at the size real features reach: about 400
lines, five phases, an Exit Gate and 44 acceptance rows. It describes a generic B2B web app
(TypeScript/Node API, React UI, Postgres) adding email invitations with expiring, single-use links.

It is illustrative only. No code accompanies it, and the paths and standards files it cites are the
ones such a project would have, not files in this kit.

## How it differs from the toy fixture

`test/fixtures/example-project/specs/hello.md` is a two-phase toy that the kit's own tests parse. This
example shows what `/design` produces when a feature has permissions, stored state, abuse cases and a UI.

## What to notice

- **Mandatory questions answered in place.** Events, permissions and external exposure sit under API
  Design; UI states and accessibility, analytics and flags, and migration and rollback have their own
  subsections. Where a question does not apply it says `N/A: reason` (agentic behaviour, API-key access)
  rather than dropping the section.
- **Decisions with ids.** D1 to D9 each state the choice, what was rejected and why, so the planner can
  turn each into a task and review can check it.
- **Open Questions as a decision log.** Resolved entries stay, with who decided and when: product owner
  decisions, one call the supervising agent made from the standards and flagged for review, a `[tooling]`
  defect the build loop fixed, and one open `[product]` question marked as blocking no phase.
- **Rows at the right layer.** Behaviour a caller observes (status codes, audit rows, emails queued) is
  `[integration]` through the real routes; pure logic is `[unit]`; one journey is `[e2e]`; the single
  `[visual-only]` row says how it is captured and compared. Every success criterion is cited by a row.

It passes `node scripts/lint-spec.mjs --spec examples/specs/team-invitations.md --strict`.

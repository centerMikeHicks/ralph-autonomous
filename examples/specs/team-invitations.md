---
title: Team invitations by email
# tracker_issue: PROJ-123   (only when tracker.provider is "jira")
# tracker_project: PROJ
---

# Team Invitations by Email

## Overview

Workspace admins can invite teammates by email. Each invitation carries a role (`admin` or `member`)
and a single-use link that expires after 7 days. Admins can see pending invitations, resend them and
revoke them. Every state change is written to the audit log. Today a teammate can only join if an admin
asks support to add them, which takes a day on average; this spec lets admins do it themselves in a
minute, without opening a path for spam or for someone else to join with a forwarded link.

## Problem Statement

### Current State

- There is no invitation flow. `src/api/members/addMember.ts` is called only from the support console
  (`src/api/support/routes.ts`), which requires a staff session.
- Support handled 1,140 "please add my colleague" requests in the last quarter; median time to resolve
  was 22 hours.
- Admins work around it by sharing their own login, which the security review flagged in 2026-Q2.
- `workspace_members` has no notion of a pending member. The audit log (`audit_log`, written by
  `src/api/audit/recordAuditEvent.ts`) records member additions only as support actions.

### Desired State

- An admin opens Settings > Members, enters up to 10 addresses, picks a role and sends. Each address
  gets one email with a link. The pending invitations appear in a table with Resend and Revoke.
- The invitee opens the link, signs in or signs up with the invited address, and accepts. They become a
  member with the invited role. The link then stops working.
- Links stop working after 7 days, after a resend (the old link), and after a revoke.
- Abuse is bounded by per-inviter and per-workspace rate limits, and every transition is auditable.

### Success Criteria

- [ ] SC1: An admin can invite addresses with role `admin` or `member`; each new invitation produces exactly one queued email and one pending row visible in the admin's list.
- [ ] SC2: A link can be accepted at most once; the first valid acceptance creates one membership with the invited role and every later use is rejected with `invitation_already_used`.
- [ ] SC3: A link whose invitation is more than 7 days old cannot be accepted, and the invitation reads as `expired` everywhere it is shown, whether or not the expiry sweep has run.
- [ ] SC4: Resend issues a new link and makes the previous one unusable; revoke makes the current link unusable immediately.
- [ ] SC5: Only workspace admins can create, list, resend or revoke invitations; the API enforces this on every route, returning 403 to members and 404 to non-members.
- [ ] SC6: Creation and resend are rate-limited; a request over the limit gets 429 with `Retry-After`, and no row or email is written for it.
- [ ] SC7: Every transition writes exactly one audit event naming the actor, the invitation and the transition; no audit event, log line or API response carries the raw token.
- [ ] SC8: The invite dialog, pending table and accept page are fully operable by keyboard, announce errors to screen readers, and never convey status by colour alone.

## Scope

### In Scope

- Invitation storage, token generation and the state machine (`pending`, `accepted`, `expired`, `revoked`).
- Admin API: create (batch of up to 10), list, resend, revoke.
- Invitee API: preview a link and accept it.
- Invitation email through the existing mail outbox.
- Rate limits, audit events and an hourly expiry sweep.
- Web UI: invite dialog, pending invitations table, accept page.

### Out of Scope

- Per-workspace expiry windows (fixed at 7 days in v1; see Open Questions, Q2).
- Restricting invitations to the workspace's verified email domains (Q6, open).
- Invitations through API keys or the CLI (D8).
- Inviting with role `owner`; ownership transfer stays its own flow (Q1).
- Bulk import from CSV or a directory sync; a separate spec if requested.
- Reminder emails before expiry; nobody has asked for them and they add a scheduled job.

### Dependencies

- The mail outbox (`mail_outbox` table and `src/api/mail/worker.ts`) delivering within 5 minutes.
- Sign-up with email verification (shipped) so an invitee's address is known to be theirs.
- The `team_invitations` workspace flag, created through the existing flag service (see Analytics,
  Flags and Configuration).

## Technical Design

### Architecture Overview

All server code lives in a new module `src/api/invitations/`. Routes call `service.ts`, which owns
the state machine and runs each transition in one Postgres transaction: the conditional status update,
the membership insert (on accept), the audit row and the outbox row commit together or not at all.
The web side adds two screens under `src/web/`. No new infrastructure: rate counters live in Postgres.

```
admin UI -> POST /invitations -> service.create -> [invitations row + audit_log + mail_outbox] (1 tx)
invitee  -> GET /invitations/preview -> service.preview (read only)
invitee  -> POST /invitations/accept -> service.accept -> [status update + workspace_members + audit_log] (1 tx)
cron     -> expirySweep (hourly) -> [status update + audit_log] per invitation
```

### Data Model

| Item | Change |
|------|--------|
| `workspace_invitations` | new table: `id uuid pk`, `workspace_id uuid fk`, `email citext not null`, `role invitation_role not null`, `status invitation_status not null default 'pending'`, `token_hash bytea not null unique`, `invited_by uuid fk users`, `expires_at timestamptz not null`, `send_count int not null default 1`, `last_sent_at timestamptz not null`, `accepted_by uuid null`, `accepted_at timestamptz null`, `revoked_by uuid null`, `revoked_at timestamptz null`, `created_at`, `updated_at` |
| `invitation_role` enum | new: `admin`, `member` |
| `invitation_status` enum | new: `pending`, `accepted`, `expired`, `revoked` |
| `workspace_invitations_one_pending` | new partial unique index on `(workspace_id, email)` where `status = 'pending'` |
| `workspace_invitations_sweep` | new index on `(status, expires_at)` for the expiry sweep |
| `invitation_rate_counters` | new table: `scope text`, `key text`, `window_start timestamptz`, `count int`; primary key `(scope, key, window_start)` |
| `audit_log.action` | none: existing text column; five new action values, no migration |
| `workspace_members` | none: rows inserted through the existing `addMember` |
| `mail_outbox` | none: existing table; new template id `invitation` |

Migration `db/migrations/20261012_workspace_invitations.sql` is additive. Its down migration drops the
two tables and two enums.

### API Design

All routes return errors as `{ "error": { "code": "<snake_case>", "message": "<human text>" } }`.
Admin routes use the existing `requireWorkspaceRole('admin')` middleware.

| Method and path | Who | Request | Success | Errors |
|-----------------|-----|---------|---------|--------|
| `POST /api/workspaces/:wid/invitations` | admin | `{ emails: string[1..10], role: "admin" \| "member" }` | 200 `{ results: [{ email, outcome, invitationId? }] }` | 400 `invalid_role`, 400 `too_many_addresses`, 429 `rate_limited` |
| `GET /api/workspaces/:wid/invitations?status=pending\|all` | admin | none | 200 `{ invitations: [...] }` with effective status | none beyond auth |
| `POST /api/workspaces/:wid/invitations/:id/resend` | admin | none | 200 `{ invitation }` | 409 `invitation_not_pending`, 429 `rate_limited` |
| `POST /api/workspaces/:wid/invitations/:id/revoke` | admin | none | 200 `{ invitation }` | 409 `invitation_not_pending` |
| `GET /api/invitations/preview?token=` | anyone holding a link | none | 200 `{ workspaceName, role, invitedEmailMasked, state }` | 404 `invitation_not_found` |
| `POST /api/invitations/accept` | signed-in user | `{ token }` | 200 `{ workspaceId, role }` | 401, 403 `invitation_email_mismatch`, 404 `invitation_not_found`, 409 `invitation_already_used`, 410 `invitation_expired`, 410 `invitation_revoked` |

Per-address `outcome` on create is one of `created`, `already_member`, `invitation_pending` (with the
existing `invitationId`, so the UI can offer Resend) or `invalid_email`. Addresses are trimmed and
compared case-insensitively.

**Events.** The audit log is the event channel; nothing else consumes invitation changes in v1.
Actions: `invitation.created`, `invitation.resent`, `invitation.revoked`, `invitation.accepted`,
`invitation.expired`. Payload: `invitationId`, `workspaceId`, `actorId` (null for the sweep, with
`actorType: "system"`), `email`, `role`, `fromStatus`, `toStatus`. Producer: `service.ts` and
`expirySweep.ts`. Each event is written in the transaction that changes the status, so delivery is
exactly once per transition; a retried request whose conditional update matches no row writes nothing.
Ordering within one invitation follows `created_at`. The token and its hash are never in a payload.

**Permissions.** Create, list, resend and revoke need the `admin` workspace role, checked in the route
middleware and again in `service.ts` (the service takes the caller's membership, not a boolean). A
`member` gets 403 `forbidden`; a user with no membership gets 404 (D6). Preview needs only the token.
Accept needs a signed-in user whose verified email equals the invited address (D4). There is no
override path: support staff keep using the support console, which already audits as `support.*`.
No existing grant or role changes.

**External tool exposure.** N/A for v1: these routes accept session cookies only and are excluded from
the API-key router (D8). Exposing invitations to scripts would need its own rate and abuse review.

### Service Changes

| Component | Change |
|-----------|--------|
| `src/api/invitations/tokens.ts` | new: `generateToken()` returns `{ token, tokenHash }`; `hashToken(token)` |
| `src/api/invitations/stateMachine.ts` | new: `transition(status, action)` and `effectiveStatus(row, now)` |
| `src/api/invitations/repository.ts` | new: queries, each taking `now` as a parameter (Q5) |
| `src/api/invitations/service.ts` | new: create, list, resend, revoke, preview, accept |
| `src/api/invitations/routes.ts` | new: the six routes above, mounted in `src/api/app.ts` |
| `src/api/invitations/rateLimit.ts` | new: fixed-window counter on `invitation_rate_counters` (D7) |
| `src/api/invitations/expirySweep.ts` | new: hourly job registered in `src/api/jobs/schedule.ts` |
| `src/api/mail/templates/invitation.tsx` | new: invitation email template |
| `src/api/audit/recordAuditEvent.ts` | modified: five actions added to the `AuditAction` union |
| `src/api/members/addMember.ts` | modified: accepts an optional transaction client |
| `src/api/app.ts` | modified: mounts the invitation routes behind the `team_invitations` flag |
| `src/config/invitations.ts` | new: expiry and rate-limit settings with defaults |
| `src/web/settings/members/InviteDialog.tsx` | new |
| `src/web/settings/members/PendingInvitationsTable.tsx` | new |
| `src/web/settings/members/MembersPage.tsx` | modified: Invite button and the pending table |
| `src/web/invite/AcceptInvitePage.tsx` | new: route `/invite/accept` |
| `src/web/routes.tsx` | modified: registers the accept route |

### UI

Reused components: `Dialog`, `TextField`, `Select`, `Button`, `Table`, `ConfirmDialog`, `StatusBadge`,
`InlineAlert`. No new component is needed.

- **Invite dialog.** Email field accepts comma- or newline-separated addresses; role select defaults to
  `member`. Validation runs on blur and on submit, with the message linked by `aria-describedby`.
  Loading: Send shows a spinner and the dialog ignores a second submit. Success: a per-address summary
  ("3 sent, 1 already a member") in a live region; the dialog stays open if any address failed. Error:
  a 429 shows "Too many invitations. Try again in N minutes." Focus order: email, role, Send, Cancel;
  Escape closes and returns focus to the Invite button.
- **Pending table.** Empty: "No pending invitations." with the Invite button. Loading: skeleton rows.
  Error: `InlineAlert` with Retry. Columns: email, role, sent, expires, status (badge with text). Row
  actions Resend and Revoke are buttons with accessible names including the email. Revoke asks for
  confirmation and cannot be undone; the confirmation says so. Below 600px the table becomes a list.
- **Accept page.** States: loading; valid (workspace name, role, Accept); signed out (Sign in and Sign
  up, each returning to the page); expired, revoked, already used, not found, email mismatch (each with
  a heading, one sentence of why, and the next step). Focus moves to the heading on load.
- Motion: none beyond the existing dialog transition, which honours `prefers-reduced-motion`.

### Agentic and Conversational Behaviour

N/A: no agent acts on anyone's behalf and the feature has no conversational surface.

### Analytics, Flags and Configuration

- Outcome events through the existing product analytics client: `invitation_sent` (`role`,
  `batchSize`), `invitation_accepted` (`role`, `hoursToAccept`), `invitation_failed_accept` (`reason`).
  The measure of success is the share of invitations accepted within 7 days and the drop in "add my
  colleague" support requests.
- Flag: `team_invitations`, per workspace, default off. Approved by the product owner as a kill switch
  (see Q3). Off hides the UI and makes the routes return 404; pending links then show "not found".
- Configuration in `src/config/invitations.ts`: `expiryDays` (7), `inviterPerHour` (20),
  `workspacePerDay` (100), `resendPerInvitationPerDay` (3), `previewPerIpPerMinute` (30).

### Migration and Rollback

1. Apply the additive migration (automated in deploy). Verify: tables and indexes exist.
2. Deploy code with the flag off everywhere. Verify: routes return 404.
3. Turn the flag on for internal workspaces, then for all after 7 days without incidents.

Rollback: turn the flag off; nothing else is needed. Dropping the tables (the down migration) is the
only destructive step and is run by a person, only after the flag has been off for 7 days so no live
link points at a dropped row. Accepted invitations have already produced ordinary membership rows, which
the down migration leaves in place.

### Decisions

**D1 — Store only a hash of the token**
Tokens are 32 random bytes, base64url-encoded (43 characters); the database stores their SHA-256. A
leaked database dump cannot be turned into working links. Rejected: storing the token encrypted (needs
key management for no gain, since the server never needs the token back). Ships in phase 1.

**D2 — Status is stored; expiry is also enforced at read time**
`expired` is written by the hourly sweep, but every read and the accept path compute the effective
status from `expires_at`. Correctness does not depend on the job running. Rejected: deriving `expired`
only (no audit event for expiry) and storing only (an hour-long window of accepting expired links).

**D3 — Resend rotates the token and resets the expiry**
Resend generates a new token, overwrites `token_hash`, sets `expires_at` to now plus 7 days and
increments `send_count`. The old link then matches no row and reads as "not found". Rejected: resending
the same link (cannot, D1) and keeping a history of hashes (no user need found).

**D4 — Acceptance requires the invited email**
The signed-in user's verified email must equal the invitation's address. A forwarded link cannot be used
by someone else. Decided by the product owner (Q3).

**D5 — Single use through a conditional update**
Accept runs `update ... set status = 'accepted' where id = $1 and status = 'pending' and expires_at > $now
returning *` in the same transaction as the membership insert and audit row. Zero rows returned means
another request won or the state changed; the service re-reads to pick the error code.

**D6 — Members get 403, non-members get 404**
Decided by the supervising agent from `standards/security/authorization.md` (Q4); flagged for review.

**D7 — Rate limits use a Postgres fixed-window counter**
An `insert ... on conflict do update set count = count + 1 returning count` per scope and window. No new
infrastructure for a write rate of a few per minute. A batch is checked as a whole: if it would exceed
a limit, the request gets 429 and nothing is sent. Rejected: an in-memory limiter (wrong with several
API instances).

**D8 — Not exposed to API keys in v1**
Out of scope; recorded so the build does not add the routes to the API-key router.

**D9 — Revoking a non-pending invitation is a conflict**
Revoke and resend on an `accepted`, `expired` or `revoked` invitation return 409. Removing someone who
already joined is the existing member-removal flow.

## Implementation Plan

### Phase 1: Storage, tokens and state machine

Migration, `tokens.ts`, `stateMachine.ts` and `repository.ts` (D1, D2, D5). No routes yet.

**Acceptance Tests**

- [ ] `[unit]` generatedTokenIsOnlyStoredAsHash — Given a new token, When `generateToken` runs, Then the token is 43 base64url characters and the record to persist holds only its SHA-256 hash (SC7)
- [ ] `[unit]` stateMachineAllowsOnlyDefinedTransitions — Given each status, When every action is applied, Then only accept, revoke, expire and resend from `pending` succeed and every other pair throws `InvalidTransition` (SC2, SC4)
- [ ] `[unit]` pendingPastExpiryReadsAsExpired — Given a pending row whose `expires_at` is one second before `now`, When `effectiveStatus` runs, Then it returns `expired` (SC3)
- [ ] `[integration]` onlyOnePendingInvitationPerEmail — Given a pending invitation for "Sam@Example.com" in workspace W, When a second pending row for "sam@example.com" in W is inserted, Then Postgres rejects it with a unique violation (SC1)
- [ ] `[integration]` migrationRoundTrips — Given a migrated database, When the down then the up migration run, Then both succeed and the schema matches the committed snapshot (SC1)

### Phase 2: Create and list for admins

`service.create`, `service.list`, the create and list routes, the email template and the
`invitation.created` audit event.

**Acceptance Tests**

- [ ] `[integration]` adminCreatesInvitationsAndQueuesOneEmailEach — Given an admin of W, When they POST two new addresses with role `member`, Then both outcomes are `created`, two pending rows exist, and two `invitation` mails are in the outbox (SC1)
- [ ] `[integration]` existingMemberIsReportedNotInvited — Given an address that already belongs to a member of W, When an admin invites it, Then its outcome is `already_member` and no row or mail is written (SC1)
- [ ] `[integration]` duplicatePendingReturnsExistingId — Given a pending invitation for an address, When an admin invites it again, Then its outcome is `invitation_pending` with the existing id and no second mail is queued (SC1)
- [ ] `[integration]` createRejectsOwnerRole — Given an admin of W, When they POST role "owner", Then the response is 400 `invalid_role` (SC5)
- [ ] `[integration]` memberCannotCreateOrListInvitations — Given a member of W who is not an admin, When they POST or GET invitations for W, Then both return 403 and nothing is written (SC5)
- [ ] `[integration]` nonMemberGetsNotFound — Given a user with no membership in W, When they POST or GET invitations for W, Then both return 404 (SC5)
- [ ] `[integration]` createWritesOneAuditEventWithoutToken — Given an admin, When they create one invitation, Then exactly one `invitation.created` audit row exists with actor, invitation id and role, and its payload has no token or hash field (SC7)
- [ ] `[integration]` listReportsEffectiveStatus — Given a pending, a pending-past-expiry and a revoked invitation, When an admin GETs `?status=all`, Then they read `pending`, `expired` and `revoked` and no item has a `tokenHash` field (SC3, SC7)
- [ ] `[unit]` invitationEmailContainsLinkAndExpiry — Given an invitation and its token, When the template renders, Then the body holds the accept URL once, the workspace name, the inviter's name and the expiry date (SC1)

### Phase 3: Preview and accept

`service.preview`, `service.accept`, their routes, and the `invitation.accepted` audit event (D4, D5).

**Acceptance Tests**

- [ ] `[integration]` acceptCreatesMembershipWithInvitedRole — Given a pending `admin` invitation for the signed-in user's verified email, When they POST the token to accept, Then the response is 200 and they are an admin of W (SC1, SC2)
- [ ] `[integration]` secondAcceptReturnsAlreadyUsed — Given an invitation accepted once, When the same token is posted again, Then the response is 409 `invitation_already_used` (SC2)
- [ ] `[integration]` concurrentAcceptsCreateOneMembership — Given one pending invitation, When two accept requests with its token run in parallel, Then one gets 200, the other 409, and exactly one membership and one `invitation.accepted` audit row exist (SC2, SC7)
- [ ] `[integration]` expiredLinkIsRejectedBeforeSweep — Given a pending invitation 7 days and 1 second old that the sweep has not touched, When it is accepted, Then the response is 410 `invitation_expired` (SC3)
- [ ] `[integration]` mismatchedEmailCannotAccept — Given a valid token for "a@example.com", When a user signed in as "b@example.com" accepts it, Then the response is 403 `invitation_email_mismatch` and the invitation stays pending (SC2)
- [ ] `[integration]` unknownTokenIsNotFound — Given a token that matches no row, When it is previewed or accepted, Then both return 404 `invitation_not_found` (SC4)
- [ ] `[integration]` previewMasksInvitedEmail — Given a pending invitation for "sam.lee@example.com", When it is previewed, Then the response shows "s*****e@example.com", the workspace name and the role (SC7)
- [ ] `[integration]` previewIsRateLimitedPerIp — Given 30 previews from one IP in a minute, When a 31st arrives, Then it gets 429 with `Retry-After` (SC6)

### Phase 4: Resend, revoke, rate limits and expiry sweep

`service.resend`, `service.revoke`, `rateLimit.ts` wired into create and resend, and `expirySweep.ts`
(D3, D7, D9).

**Acceptance Tests**

- [ ] `[integration]` resendRotatesTokenAndResetsExpiry — Given a pending invitation sent 3 days ago, When an admin resends it, Then a new mail is queued, `expires_at` is now plus 7 days and the previous token returns 404 on accept (SC4)
- [ ] `[integration]` revokedLinkCannotBeAccepted — Given a pending invitation, When an admin revokes it and the invitee then accepts, Then accept returns 410 `invitation_revoked` (SC4)
- [ ] `[integration]` revokeOrResendNonPendingIsConflict — Given an accepted invitation, When an admin revokes or resends it, Then both return 409 `invitation_not_pending` (SC4)
- [ ] `[integration]` resendAndRevokeRequireAdmin — Given a member who is not an admin, When they resend or revoke, Then both return 403 and the row is unchanged (SC5)
- [ ] `[integration]` inviterHourlyLimitReturns429 — Given an inviter with 19 invitations this hour, When they submit a batch of 2, Then the response is 429 with `Retry-After`, no row is created and no mail is queued (SC6)
- [ ] `[integration]` workspaceDailyLimitCountsAllInviters — Given two admins whose invitations total 100 today, When either invites one more, Then the response is 429 (SC6)
- [ ] `[integration]` fourthResendInADayIsLimited — Given an invitation resent 3 times in 24 hours, When it is resent again, Then the response is 429 and `send_count` is unchanged (SC6)
- [ ] `[unit]` fixedWindowStartsAtBoundary — Given a window of one hour, When counting at 10:59:59 and 11:00:00, Then the two counts fall in different windows (SC6)
- [ ] `[integration]` expirySweepIsIdempotent — Given two pending invitations past expiry, When the sweep runs twice, Then both are `expired` with exactly one `invitation.expired` audit row each, with `actorType` "system" (SC3, SC7)
- [ ] `[integration]` resendAndRevokeWriteAuditEvents — Given a pending invitation, When it is resent then revoked, Then one `invitation.resent` and one `invitation.revoked` row exist in that order (SC7)

### Phase 5: Web UI

`InviteDialog.tsx`, `PendingInvitationsTable.tsx`, the Members page changes and `AcceptInvitePage.tsx`.
Page tests render with the real router and a mocked HTTP layer.

**Acceptance Tests**

- [ ] `[integration]` inviteDialogShowsPerAddressOutcome — Given the API answers one `created` and one `already_member`, When an admin sends two addresses, Then the live region reads "1 sent, 1 already a member" and the dialog stays open (SC1, SC8)
- [ ] `[integration]` inviteDialogValidatesOnBlur — Given the dialog, When "not-an-email" is typed and focus leaves the field, Then an error naming the address is shown and linked to the field by `aria-describedby` (SC8)
- [ ] `[integration]` inviteDialogKeyboardOrder — Given the dialog is open, When Tab is pressed repeatedly, Then focus moves email, role, Send, Cancel, and Escape closes it and returns focus to the Invite button (SC8)
- [ ] `[integration]` revokeRequiresConfirmation — Given a pending row, When Revoke is chosen and the confirmation cancelled, Then no revoke request is sent and the row is unchanged (SC4)
- [ ] `[integration]` pendingTableShowsEmptyAndErrorStates — Given the list API answers with no items and then with 500, When the page loads each time, Then it shows "No pending invitations." and then an alert with a Retry button (SC1)
- [ ] `[integration]` acceptPageExplainsEachFailure — Given preview states expired, revoked, already used, not found and email mismatch, When the page renders each, Then each shows its own heading and next step and focus is on the heading (SC3, SC8)
- [ ] `[unit]` statusBadgeCarriesText — Given each status, When `StatusBadge` renders, Then the badge text names the status in words (SC8)
- [ ] `[e2e]` invitationJourneyEndToEnd — Given an admin and a new user with the invited address, When the admin invites them and the user opens the link from the captured mail, signs up and accepts, Then the user lands in W as a member and the admin's pending list is empty (SC1, SC2)
- [ ] `[visual-only]` — the e2e suite captures the invite dialog and accept page at 320px and 1280px in light and dark themes; a person compares them with the approved mockups in `docs/design/team-invitations/` (SC8)

### Exit Gate

The project's checks, the full acceptance set, and anything earlier phases left open.

**Acceptance Tests**

- [ ] `[unit]` `npm test` exits 0 across the project (SC1, SC2, SC3, SC4, SC5, SC6, SC7, SC8)
- [ ] `[integration]` `npm run test:integration` exits 0 against a fresh database (SC2, SC5, SC6, SC7)
- [ ] `[e2e]` `npx playwright test e2e/invitations.spec.ts` exits 0 (SC1, SC2)

## Edge Cases

- Mixed batch: valid, invalid and already-member addresses in one request. Each is reported on its own;
  only `created` addresses count against rate limits.
- Same address twice in one batch: deduplicated before processing, reported once.
- Batch of 11 addresses: 400 `too_many_addresses`, nothing processed.
- Invitee already a member when they accept (they joined another way meanwhile): the service marks the
  invitation accepted, writes the audit event and returns 200 with the existing role unchanged. The
  invited role is not applied over the current one.
- Invitee has no account: the accept page offers sign-up with the invited address prefilled; after
  verification they return to the accept page.
- Inviter loses admin rights before acceptance: the invitation stays valid; acceptance is checked
  against the invitation, not the inviter's current role.
- Workspace deleted: invitations cascade-delete; links read as not found.
- Clock skew between API instances: each request reads `now` once from the database and passes it to
  every expiry check (Q5).
- Mail outbox down: the invitation is created and its mail waits in the outbox; Resend is available.
- Flag turned off with pending invitations: links read as not found; turning it back on restores them
  if they have not expired.

## Security Considerations

- Tokens: 256 bits of randomness, compared by hash lookup (no timing-sensitive string comparison),
  never logged. Request logging redacts the `token` query and body field; a unit test in
  `src/api/logging/redact.test.ts` covers the two new field paths.
- The accept URL carries the token in the query string. The accept page replaces the URL with
  `history.replaceState` after reading it, and sets `Referrer-Policy: no-referrer`.
- Authorization: admin-only routes are checked in middleware and in the service (SC5). Preview reveals
  only workspace name, role and a masked email.
- Abuse: rate limits bound mail volume per inviter and workspace; preview is limited per IP to slow
  token guessing, which 256-bit tokens already make impractical.
- Audit: every transition is recorded with its actor; the audit log is readable by workspace admins
  through the existing audit page.
- Privacy: invited addresses of people who never accept are kept with the invitation. Retention is the
  workspace's normal data retention; no new policy.

## Testing Strategy

- Unit: token generation, state machine, effective status, rate-window arithmetic, email template,
  status badge.
- Integration (Postgres in a container, real routes through the HTTP test client): every route's
  success and error codes, authorization, audit rows, outbox rows, concurrency on accept, the sweep.
  The mail worker is not run; tests assert on `mail_outbox` rows. Time is controlled by passing `now`
  explicitly (Q5).
- Page tests: real components and router with the HTTP layer mocked at the fetch boundary; keyboard and
  live-region assertions use the accessibility tree.
- End to end: one journey test with a local mail catcher to read the link.
- Exit Gate runs the unit, integration and e2e commands above.

## Open Questions

Entries are kept after they are resolved, with who decided and when, so the spec carries its own
decision log. Ticked entries are settled; an unticked entry says whether it blocks a phase.

- [x] `[product]` Q1 — resolved (product owner, 2026-09-28): invitations can grant `admin` or `member` only; `owner` cannot be granted by invitation and ownership transfer stays a separate flow.
- [x] `[product]` Q2 — resolved (product owner, 2026-10-02): invite links expire after 7 days; making this configurable per workspace is a later spec (out of scope here).
- [x] `[product]` Q3 — resolved (product owner, 2026-10-02): accepting requires the signed-in account's verified email to equal the invited address, with no "accept as a different address" path in v1 (D4). The `team_invitations` kill switch was approved in the same review.
- [x] `[product]` `[REVIEW]` Q4 — decided by the supervising agent (2026-10-06) from `standards/security/authorization.md` ("do not reveal that a resource exists to a caller with no relationship to it"): members get 403, non-members get 404 (D6). The product owner marks it `[REVIEWED]` once they accept it; overturning it changes only the expected status in the Phase 2 row `nonMemberGetsNotFound`.
- [x] `[tooling]` Q5 — resolved (build loop, 2026-10-12, during Phase 1): the integration harness froze the application clock but Postgres `now()` kept real time, so expiry tests were flaky. Fixed in a `team-invitations Tooling:` commit: repository queries take `now` as a parameter and the harness gained a test that a frozen clock reaches the query.
- [ ] `[product]` Q6 — open, blocks no phase: should a workspace be able to restrict invitations to its verified email domains? Nothing in v1 depends on the answer; it decides whether a follow-up spec is written.

## References

- `standards/security/authorization.md` (403 versus 404 for callers without access)
- `standards/backend/migrations.md` (additive first, destructive step run by a person)
- `standards/frontend/accessibility.md` (focus, live regions, colour)
- `src/api/members/addMember.ts`, `src/api/audit/recordAuditEvent.ts`, `src/api/mail/worker.ts`
- `ralph/CONVENTIONS.md` section 5 (acceptance row format) and section 7 (blocker tags)

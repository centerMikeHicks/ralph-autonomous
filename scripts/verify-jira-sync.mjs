#!/usr/bin/env node
/**
 * Tracker sync gate — the one point an agent cannot talk its way past: the commit.
 *
 * With tracker.provider = "jira" the build loop's tracker writes are agent-driven. A mid-run
 * failure (an API blip, a transition invalid from the ticket's current status, an expired
 * token) only makes the agent write a `JIRA DEGRADED` line to <stateDir>/PROGRESS.md and keep
 * going, so an outage never blocks code work. Nothing else re-reads that marker. This gate does:
 * it runs at every commit (two small file reads) and refuses while the marker stands.
 *
 *   PASS (0)  provider is not "jira", or PROGRESS.md carries no `JIRA DEGRADED` line
 *   BLOCK (1) PROGRESS.md still contains a `JIRA DEGRADED` line
 *
 * Usage: node scripts/verify-jira-sync.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { getContext, specName } from './lib/context.mjs';

const ctx = getContext();
if (ctx.config.tracker.provider !== 'jira') process.exit(0);

const progress = path.join(ctx.stateDir, 'PROGRESS.md');
if (!fs.existsSync(progress)) process.exit(0);
const marker = fs.readFileSync(progress, 'utf8').split(/\r?\n/).find((l) => /JIRA DEGRADED/.test(l));
if (!marker) process.exit(0);

const active = ctx.activeSpec();
const state = active ? `${path.basename(ctx.stateDir)}/tracker/${specName(active)}.json` : `${path.basename(ctx.stateDir)}/tracker/<spec>.json`;
console.error('[verify-jira-sync] BLOCKED: tracker sync is degraded and has not been cleared.');
console.error(`  ${marker.trim()}`);
console.error(`  Retry the failed tracker call (it is idempotent via events[] in ${state}),`);
console.error(`  then remove the marker line from ${path.basename(ctx.stateDir)}/PROGRESS.md once it succeeds.`);
console.error('  If the tracker is unreachable for the whole run, restart the loop with its skip-tracker option.');
process.exit(1);

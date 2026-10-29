// Spend: what the loop may cost, and the switch that stops it. Pure, except killSwitchOn.
//
//   budget.iterationUsd   passed to the claude CLI as --max-budget-usd: one iteration stops itself there
//   budget.runUsd         the loop stops before an iteration once this run has spent this much
//   budget.dayUsd         the loop stops before an iteration once today (UTC) has spent this much, across runs
//
// Each may be null, the default: a project sets its caps once it knows what a run costs. With none set the
// driver says so at the start and reports the spend after every iteration, so a person watching sees it.
// RALPH_BUDGET_ITERATION_USD, RALPH_BUDGET_RUN_USD and RALPH_BUDGET_DAY_USD override the file (an empty value unsets).
//
// The kill switch: while <stateDir>/STOP (or RALPH_KILL_SWITCH) exists, no iteration starts, in any run.
import fs from 'node:fs';
import path from 'node:path';

const amount = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The caps in force: the config's, with the environment over it. */
export function budgetSettings(cfg, env = process.env) {
  const b = cfg?.budget || {};
  const pick = (key, name) => (env[name] !== undefined ? amount(env[name]) : amount(b[key]));
  return {
    iterationUsd: pick('iterationUsd', 'RALPH_BUDGET_ITERATION_USD'),
    runUsd: pick('runUsd', 'RALPH_BUDGET_RUN_USD'),
    dayUsd: pick('dayUsd', 'RALPH_BUDGET_DAY_USD'),
  };
}

export const anyCap = (s) => s.iterationUsd !== null || s.runUsd !== null || s.dayUsd !== null;

/** What the iterations.jsonl rows of one UTC day cost. */
export function spentOn(rows, day) {
  let usd = 0;
  for (const r of rows || []) if (typeof r?.ts === 'string' && r.ts.slice(0, 10) === day) usd += Number(r.cost_usd) || 0;
  return Math.round(usd * 10000) / 10000;
}

export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Whether the next iteration may start: { stop: null | 'budget_run' | 'budget_day', message }. */
export function budgetDecision({ settings, runSpent, daySpent }) {
  if (settings.runUsd !== null && runSpent >= settings.runUsd) {
    return { stop: 'budget_run', message: `This run has spent $${runSpent.toFixed(2)}, at or over its cap of $${settings.runUsd.toFixed(2)} (budget.runUsd).` };
  }
  if (settings.dayUsd !== null && daySpent >= settings.dayUsd) {
    return { stop: 'budget_day', message: `Today has spent $${daySpent.toFixed(2)}, at or over the daily cap of $${settings.dayUsd.toFixed(2)} (budget.dayUsd).` };
  }
  return { stop: null, message: null };
}

/** The kill switch's path. */
export const killSwitchPath = (stateDir, env = process.env) => env.RALPH_KILL_SWITCH || path.join(stateDir, 'STOP');

/** Whether the kill switch is on. */
export const killSwitchOn = (stateDir, env = process.env) => fs.existsSync(killSwitchPath(stateDir, env));

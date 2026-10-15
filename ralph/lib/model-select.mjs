// Model and effort selection for one iteration. Pure: all inputs are passed in.
import { isExitGateNext, nextTask, isMechanicalTask } from './plan-parse.mjs';

/**
 * Selection table
 *   forced (--model / RALPH_MODEL)  -> that model, no effort flag
 *   plan                            -> models.planning  @ efforts.planning
 *   review                          -> models.review    @ efforts.planning
 *   build, next task mechanical     -> models.mechanical @ efforts.mechanical
 *   build, Exit Gate next           -> models.execution @ efforts.exitGate
 *   build, otherwise                -> models.execution @ efforts.execution
 *
 * @returns {{model:string, effort:string, tier:string, reason:string}}
 */
export function selectModel({ mode, planText = '', models, forced = '' }) {
  const efforts = models.efforts || {};
  if (forced) return { model: forced, effort: '', tier: 'forced', reason: 'forced via --model / RALPH_MODEL' };
  if (mode === 'review') {
    return { model: models.review, effort: efforts.planning || '', tier: 'review', reason: 'review mode' };
  }
  if (mode === 'build') {
    const task = nextTask(planText);
    if (isMechanicalTask(task)) {
      return { model: models.mechanical, effort: efforts.mechanical || '', tier: 'mechanical', reason: `mechanical task: ${task.slice(0, 60)}` };
    }
    if (isExitGateNext(planText)) {
      return { model: models.execution, effort: efforts.exitGate || '', tier: 'exit-gate', reason: 'Exit Gate is next' };
    }
    return { model: models.execution, effort: efforts.execution || '', tier: 'execution', reason: 'routine build task' };
  }
  return { model: models.planning, effort: efforts.planning || '', tier: 'planning', reason: `${mode} mode` };
}

/** Human description of the strategy, shown in the banner before any plan is read. */
export function describeStrategy({ mode, models, forced = '' }) {
  const e = models.efforts || {};
  if (forced) return `${forced} (forced via --model / RALPH_MODEL)`;
  if (mode === 'plan') return `${models.planning}/${e.planning} (plan mode)`;
  if (mode === 'review') return `${models.review}/${e.planning} (review mode)`;
  if (mode === 'build') {
    return `${models.execution}/${e.execution}; ${models.mechanical}/${e.mechanical} for mechanical tasks; ${models.execution}/${e.exitGate} at the Exit Gate`;
  }
  return `${models.planning}/${e.planning}`;
}

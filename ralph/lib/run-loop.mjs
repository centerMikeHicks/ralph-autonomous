// The Ralph loop, once, in Node. ralph/loop.sh and ralph/loop.ps1 are launchers that exec this.
//
//   node ralph/lib/run-loop.mjs <plan|build|review|status> [max-iterations] [spec]
//        [--model M] [--issue KEY] [--skip-tracker] [--no-transcripts]
//
// Environment: RALPH_MODEL, RALPH_AGENT_CMD, RALPH_SUPERVISED=1, RALPH_PAUSE_S (default 3),
// RALPH_SWEEP_WAIT_CEILING_MIN (default 90), RALPH_USAGE_LIMIT_BUFFER_S / _MIN_WAIT_S.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { loadProjectConfig } from './load-config.mjs';
import { ensureDir, readJson, readText, safeName, writeText } from './fsutil.mjs';
import { allPhasesDone } from './plan-parse.mjs';
import { selectModel, describeStrategy } from './model-select.mjs';
import { usageLimitReset, waitSeconds } from './usage-limit.mjs';
import { ejectDecision, gitText, progressFingerprint, resolveStateDir } from './progress.mjs';
import { assemblePrompt, parseDiffAnchors } from './prompt-assemble.mjs';
import {
  archiveOutgoingPlan, atlassianConnected, initialPlan, resolveSpec, resolveTracker, specBaseName,
} from './spec-tracker.mjs';
import {
  buildIterationRow, createEventLog, readIterationStatus, readJsonl, removeHeartbeat, transcriptMetrics,
  writeHeartbeat, writeIterationRecord,
} from './telemetry.mjs';
import { buildAgentArgs, buildAgentEnv, renderEvent, resolveAgent, resolveExecutable, spawnAgent } from './agent.mjs';
import { answersBlock, capsWithKairos, createKairos, kairosProblem, kairosSettings, MAX_FAILED_READS, productQuestions, stopReasonFor } from './kairos.mjs';
import { anyCap, budgetDecision, budgetSettings, killSwitchOn, killSwitchPath, recordSpend, spendLogPath, spentOn, today } from './budget.mjs';
import { statusReport } from './status.mjs';

const MODES = ['plan', 'build', 'review', 'status'];
const useColor = Boolean(process.stdout.isTTY);
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const say = (s = '') => process.stdout.write(`${s}\n`);
const info = (s) => say(paint('90', `[Ralph] ${s}`));
const warn = (s) => say(paint('33', `[Ralph] ${s}`));
const fail = (s) => process.stderr.write(`${paint('31', `[Ralph] ERROR: ${s}`)}\n`);

/** Parse the command line shared by both launchers. Pure. */
export function parseArgs(argv) {
  const opts = { mode: 'build', max: 0, spec: '', model: '', issue: '', skipTracker: false, noTranscripts: false, error: '' };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = /^--([a-z-]+)=(.*)$/.exec(a);
    const name = eq ? eq[1] : /^--/.test(a) ? a.slice(2) : '';
    const value = () => (eq ? eq[2] : argv[++i] ?? '');
    if (name === 'model') opts.model = value();
    else if (name === 'issue') opts.issue = value();
    else if (name === 'skip-tracker') opts.skipTracker = true;
    else if (name === 'no-transcripts') opts.noTranscripts = true;
    else if (name) opts.error = `unknown option --${name}`;
    else positional.push(a);
  }
  if (positional[0]) opts.mode = positional[0];
  let rest = positional.slice(1);
  if (rest[0] !== undefined && /^\d+$/.test(rest[0])) {
    opts.max = Number(rest[0]);
    rest = rest.slice(1);
  }
  if (rest[0]) opts.spec = rest[0];
  if (!MODES.includes(opts.mode)) opts.error = `unknown mode '${opts.mode}' (plan | build | review | status)`;
  return opts;
}

function runGit(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Push the branch when it has commits the upstream lacks. Never forces. */
export function pushBranch({ root, branch }) {
  if (!branch || branch === 'unknown') return { skipped: 'detached HEAD' };
  const remotes = runGit(root, ['remote']).out.split(/\r?\n/).filter(Boolean);
  if (!remotes.length) return { skipped: 'no remote' };
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const up = runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let args;
  if (up.ok && up.out) {
    const ahead = Number(runGit(root, ['rev-list', '--count', `${up.out}..HEAD`]).out || 0);
    if (!ahead) return { skipped: 'nothing to push' };
    args = ['push'];
  } else {
    args = ['push', '-u', remote, branch];
  }
  const started = Date.now();
  const r = runGit(root, args);
  return { remote, ok: r.ok, error: r.ok ? undefined : r.err.split(/\r?\n/).slice(-2).join(' '), dur_s: Math.round((Date.now() - started) / 100) / 10 };
}

function sleep(ms, onTick, isStopped) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (isStopped() || Date.now() >= end) return resolve();
      if (onTick) onTick();
      setTimeout(tick, Math.min(1000, Math.max(0, end - Date.now())));
    };
    tick();
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
    rl.on('close', () => resolve('n'));
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  if (opts.error) {
    fail(opts.error);
    return 1;
  }
  const root = path.resolve(env.RALPH_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const cfg = await loadProjectConfig(root);
  const stateDir = resolveStateDir(root, cfg);
  ensureDir(stateDir);
  const planFile = path.join(stateDir, 'IMPLEMENTATION_PLAN.md');

  if (opts.mode === 'status') {
    say(statusReport({ root, stateDir, cfg }));
    return 0;
  }
  const mode = opts.mode;

  // ---- spec, plan, tracker ------------------------------------------------------------
  const resolved = resolveSpec({ root, stateDir, specArg: opts.spec });
  if (resolved.source === 'arg' && resolved.missing) {
    fail(`spec file not found: ${resolved.spec}`);
    return 1;
  }
  if (resolved.source === 'arg') info(`Set active spec: ${resolved.spec}`);
  if (resolved.source === 'none') {
    if (mode === 'plan') {
      fail('no spec file specified and no active spec set');
      info('Usage: ./ralph/loop.sh plan 1 specs/your-spec.md');
      return 1;
    }
    warn('No active spec set. Working from the existing plan.');
  } else if (resolved.missing) {
    warn(`Active spec file not found: ${resolved.spec}. Run with a spec argument to set a new one.`);
  }
  const spec = resolved.spec;
  const specName = specBaseName(spec);
  let max = opts.max;
  if (mode === 'plan') {
    if (max > 1) warn(`plan mode is clamped to 1 iteration (asked for ${max}).`);
    max = 1;
  }

  if (mode === 'plan' && spec) {
    const archived = archiveOutgoingPlan({ stateDir, newSpec: spec });
    if (archived) info(`Archived the outgoing plan to ${path.relative(root, archived)}`);
  }
  if (!fs.existsSync(planFile)) {
    writeText(planFile, initialPlan(spec));
    info('Created initial .ralph/IMPLEMENTATION_PLAN.md');
    if (mode !== 'plan') warn('There was no plan; run plan mode first for a useful build.');
  }

  const promptFile = path.join(root, 'ralph', `PROMPT_${mode}.md`);
  if (!fs.existsSync(promptFile)) {
    fail(`prompt not found: ${promptFile}`);
    return 1;
  }

  const agent = resolveAgent(cfg, env);
  if (!agent.override && resolveExecutable(agent.command, env) === agent.command && !/[\\/]/.test(agent.command)) {
    fail(`agent command '${agent.command}' was not found on PATH (set agent.command in ralph.config.json or RALPH_AGENT_CMD)`);
    return 1;
  }

  /* RALPH_TRACKER_PROVIDER is for whoever starts the loop from outside the branch: the config is on the branch, which the
     agent can edit, so it cannot be what keeps a run under a tracker's control. */
  if (env.RALPH_TRACKER_PROVIDER) cfg.tracker = { ...(cfg.tracker || {}), provider: env.RALPH_TRACKER_PROVIDER };
  const trackerProvider = (cfg.tracker || {}).provider;
  const tracker = resolveTracker({ cfg, root, spec, issueArg: opts.issue, skip: opts.skipTracker });
  const provider = trackerProvider;
  if ((provider === 'jira' || provider === 'kairos') && opts.skipTracker) {
    warn(`--skip-tracker set: skipping the tracker preflight and tracker prompt injection for this run.${provider === 'kairos' ? ' Nothing in Kairos can stop or limit it, and it will not be on the record.' : ''}`);
  }
  let kairos = null;
  let controls = null;
  if (tracker.enabled) {
    if (tracker.error) {
      fail(tracker.error);
      return 1;
    }
    if (provider === 'kairos') {
      const settings = kairosSettings(cfg, env);
      const problem = kairosProblem(settings);
      if (problem) {
        fail(`Kairos: ${problem}.`);
        info('Or pass --skip-tracker to run without Kairos on purpose.');
        return 1;
      }
      if (!tracker.issue) {
        fail("Kairos: this run has no item: name its spec, with tracker_issue in the spec's front matter or --issue KEY.");
        return 1;
      }
      kairos = createKairos({ ...settings, item: tracker.issue, ...(env.RALPH_KAIROS_RETRY_MS ? { retryMs: Number(env.RALPH_KAIROS_RETRY_MS) } : {}), onLost: (_q, r) => warn(`Kairos refused a report: ${r.message}`) });
      info(`Preflight: asking Kairos whether ${tracker.issue} may ${mode}...`);
      const first = await kairos.controls(mode);
      if (!first.ok) {
        fail(`Kairos: ${first.message}. Not starting, since nothing there could stop or limit this run.`);
        return 1;
      }
      if (!first.data.go) {
        fail(`Kairos: ${first.data.why}`);
        return 1;
      }
      controls = first.data;
      info(`Preflight OK: ${controls.key ?? controls.item} is at ${controls.stage}; $${Number(controls.spentUsd).toFixed(2)} spent of ${controls.caps.itemUsd === null ? 'no cap' : `$${Number(controls.caps.itemUsd).toFixed(2)}`}.`);
    } else if (agent.isClaude) {
      info('Preflight: checking tracker (Atlassian MCP) connectivity...');
      const exe = resolveExecutable(agent.command, env);
      const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
      const r = spawnSync(viaShell ? `"${exe}" mcp list` : exe, viaShell ? [] : ['mcp', 'list'], { encoding: 'utf8', shell: viaShell });
      if (!atlassianConnected(`${r.stdout || ''}\n${r.stderr || ''}`)) {
        fail('the Atlassian (Jira) MCP is not connected for the headless agent; refusing to run so no ticket updates are silently dropped.');
        info('Fix: authenticate the MCP interactively, then re-run. Or pass --skip-tracker to run without the tracker on purpose.');
        return 1;
      }
      info('Preflight OK: tracker MCP reachable.');
    } else {
      warn('Tracker preflight skipped: it can only probe the claude CLI.');
    }
  }

  // ---- banner ---------------------------------------------------------------------------
  const forced = opts.model || env.RALPH_MODEL || '';
  const supervised = env.RALPH_SUPERVISED === '1';
  const branch = runGit(root, ['branch', '--show-current']).out || 'unknown';
  say('');
  say(paint('36', '=============================================='));
  say(paint('36', `  Ralph Loop - ${cfg.project?.name || path.basename(root)}`));
  say(paint('36', '=============================================='));
  say(`  Mode:       ${mode}`);
  say(`  Prompt:     ${path.basename(promptFile)}`);
  say(`  Spec:       ${spec || 'None (using existing plan)'}`);
  say(`  Branch:     ${branch}`);
  say(`  Model:      ${describeStrategy({ mode, models: cfg.models, forced })}`);
  say(`  Run mode:   ${supervised ? 'supervised (confirm each iteration)' : 'unattended'}`);
  if (tracker.enabled) say(`  Tracker:    ${tracker.issue}${tracker.project ? ` (${tracker.project})` : ''}${kairos ? ' on Kairos' : ''}`);
  if (max > 0) say(`  Max iters:  ${max}`);
  say(paint('36', '=============================================='));

  // ---- loop state -----------------------------------------------------------------------
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const run = `${stamp}-${process.pid}`;
  const emit = createEventLog(stateDir, run);
  const beat = (iter) => writeHeartbeat(stateDir, run, iter);
  const loopStart = Date.now();
  const sweepScript = path.join(root, 'scripts', 'sweep.mjs');
  const lastEndFile = path.join(stateDir, '.last-iteration-end');
  const lastGateFile = path.join(stateDir, '.last-gate.json');
  const pauseS = env.RALPH_PAUSE_S !== undefined ? Number(env.RALPH_PAUSE_S) : 3;
  const sweepCeiling = Number(env.RALPH_SWEEP_WAIT_CEILING_MIN) || 90;
  const limitOpts = {
    bufferS: env.RALPH_USAGE_LIMIT_BUFFER_S !== undefined ? Number(env.RALPH_USAGE_LIMIT_BUFFER_S) : 30,
    minWaitS: env.RALPH_USAGE_LIMIT_MIN_WAIT_S !== undefined ? Number(env.RALPH_USAGE_LIMIT_MIN_WAIT_S) : 60,
  };

  let iter = 0;
  let stalled = 0;
  let stopReason = 'completed';
  let interrupted = false;
  let child = null;
  const onSignal = () => {
    interrupted = true;
    if (child) child.kill();
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, onSignal);

  emit('loop_start', { mode, spec: specName, max_iterations: max, branch, pid: process.pid, supervised });
  /* Spend (budget.mjs): this run's, and today's across runs, from the iterations already recorded. */
  let budget = capsWithKairos(budgetSettings(cfg, env), controls?.caps);
  let runSpent = 0;
  let commits = 0;
  let failedReads = 0;
  /* What Kairos hears. Reporting never holds up the work. */
  const tell = async (event, fields = {}) => {
    if (!kairos) return null;
    const { sent, failed } = await kairos.report({ event, run, mode, spec, branch, iter, runUsd: runSpent, commits, ...fields });
    if (failed) warn(`Kairos did not take a report, and it will be sent again: ${failed.message}`);
    emit('kairos_report', { event, ok: !failed, ...(failed ? { error: failed.message } : {}) });
    return sent;
  };
  await tell('run_started');
  let spendDay = today();
  let daySpent = spentOn(readJsonl(spendLogPath(stateDir, env)), spendDay);
  emit('budget', { ...budget, day_usd: daySpent });
  if (!anyCap(budget)) warn(`No spend cap is set (budget in ralph.config.json): watch this run. Today so far: $${daySpent.toFixed(2)}.`);
  else info(`Spend caps: iteration ${budget.iterationUsd ?? '—'}, run ${budget.runUsd ?? '—'}, day ${budget.dayUsd ?? '—'} USD. Today so far: $${daySpent.toFixed(2)}.`);
  beat(0);
  if (fs.existsSync(sweepScript)) {
    spawnSync(process.execPath, [sweepScript, 'reap', '--stale', '--root', root], { stdio: 'inherit', shell: false });
  }

  try {
    while (!interrupted) {
      if (max > 0 && iter >= max) {
        say('');
        warn(`Reached max iterations: ${max}`);
        stopReason = 'max_iterations';
        break;
      }
      if (killSwitchOn(stateDir, env)) {
        say('');
        warn(`KILL SWITCH - ${killSwitchPath(stateDir, env)} exists; no iteration starts while it does. Remove it to run again.`);
        stopReason = 'kill_switch';
        break;
      }
      if (kairos) {
        const read = await kairos.controls(mode);
        if (read.ok) {
          failedReads = 0;
          controls = read.data;
          budget = capsWithKairos(budgetSettings(cfg, env), controls.caps);
          if (!controls.go) {
            say('');
            warn(`KAIROS - ${controls.why} Stopping before iteration ${iter + 1}.`);
            stopReason = stopReasonFor(controls.code);
            break;
          }
        } else if (!read.retry) {
          say('');
          warn(`KAIROS - ${read.message} Stopping before iteration ${iter + 1}.`);
          stopReason = 'kairos_stop';
          break;
        } else {
          failedReads += 1;
          warn(`Kairos could not be read (${failedReads} of ${MAX_FAILED_READS}): ${read.message}`);
          if (failedReads >= MAX_FAILED_READS) {
            say('');
            warn(`KAIROS - it has not answered ${MAX_FAILED_READS} times in a row, so a stop placed there would not be seen. Stopping.`);
            stopReason = 'kairos_unreachable';
            break;
          }
        }
      }
      if (today() !== spendDay) {
        spendDay = today();
        daySpent = spentOn(readJsonl(spendLogPath(stateDir, env)), spendDay);
      }
      const spend = budgetDecision({ settings: budget, runSpent, daySpent });
      if (spend.stop) {
        say('');
        warn(`SPEND CAP - ${spend.message} Stopping before iteration ${iter + 1}.`);
        emit('budget_stop', { reason: spend.stop, run_usd: runSpent, day_usd: daySpent });
        stopReason = spend.stop;
        break;
      }
      // A detached check an earlier iteration left running is waited for here, in the shell
      // layer, never inside a model turn where each poll costs a full context.
      if (fs.existsSync(sweepScript)) {
        spawnSync(process.execPath, [sweepScript, 'wait', '--root', root, '--max-min', String(sweepCeiling)], { stdio: 'inherit', shell: false });
      }
      if (supervised && process.stdin.isTTY) {
        const answer = await ask(`Run iteration ${iter + 1}? [Y/n] `);
        if (answer === 'n' || answer === 'no') {
          stopReason = 'signal';
          break;
        }
      }
      iter += 1;
      if (iter === 1 && mode !== 'review') {
        const said = await tell(`${mode}_started`);
        if (mode === 'build' && said?.moved === false) warn(`Kairos keeps ${tracker.issue} at ${said.controls?.stage}: something holds it before Build.`);
      }

      const planText = readText(planFile);
      const sel = selectModel({ mode, planText, models: cfg.models, forced });
      const modelLabel = sel.effort ? `${sel.model} (${sel.effort})` : sel.model;
      say('');
      say(paint('36', `  ITERATION ${iter} - ${new Date().toISOString()}`));
      say(`  Model:      ${modelLabel}  [${sel.tier}: ${sel.reason}]`);
      say('');

      // ---- context for the prompt ----
      const statusPath = path.join(stateDir, 'ITERATION_STATUS.json');
      const prev = readJson(statusPath, null);
      let prevStatus = null;
      if (prev && typeof prev === 'object') {
        let stale = false;
        try {
          const specMtime = spec ? fs.statSync(path.join(stateDir, 'ACTIVE_SPEC')).mtimeMs : 0;
          stale = fs.statSync(statusPath).mtimeMs < specMtime;
        } catch {
          stale = false;
        }
        if (prev.spec && specName !== 'no-spec' && specBaseName(String(prev.spec)) !== specName) stale = true;
        prevStatus = { ...prev, stale };
      }
      const rows = readJsonl(path.join(stateDir, 'iterations.jsonl'));
      const lastCommit = [...rows].reverse().find((r) => r.spec === specName && r.head_before && r.head_after && r.head_before !== r.head_after);
      const anchors = lastCommit
        ? parseDiffAnchors(gitText(root, ['diff', '--unified=0', lastCommit.head_before, lastCommit.head_after]))
        : [];
      const trackerBlock = !tracker.enabled || !tracker.issue
        ? null
        : kairos
          ? { ...tracker, text: readText(path.join(root, 'ralph', 'TRACKER_kairos.md')), answers: answersBlock(controls?.answers) }
          : {
              ...tracker,
              state: `${path.relative(root, stateDir).replace(/\\/g, '/')}/tracker/${specName}.json`,
              text: readText(path.join(root, 'ralph', 'TRACKER_jira.md')),
            };
      const lastGate = readJson(lastGateFile, null);
      const gate = { ticks: lastGate?.ticks || '', exitGate: prev?.exit_gate ? String(prev.exit_gate) : '' };
      const prompt = assemblePrompt({
        mode, spec, planText, promptText: readText(promptFile), prevStatus, anchors,
        tracker: trackerBlock, gate, preflightFailure: readText(path.join(stateDir, 'PREFLIGHT_FAILURE.md')),
      });

      // ---- run the agent ----
      const startMs = Date.now();
      let gapS = 0;
      const prevEnd = Date.parse(readText(lastEndFile).trim());
      if (Number.isFinite(prevEnd)) gapS = Math.max(0, (startMs - prevEnd) / 1000);
      const headBefore = runGit(root, ['rev-parse', 'HEAD']).out;
      const fpBefore = progressFingerprint({ root, planFile, stateDir: path.relative(root, stateDir) });
      const planBefore = planText;

      let transcript = '';
      let logPath;
      if (opts.noTranscripts) {
        logPath = path.join(stateDir, `.iter-${iter}.tmp.jsonl`);
      } else {
        const stampName = new Date(startMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
        transcript = path.join(stateDir, 'logs', safeName(specName), `${stampName}-iter${String(iter).padStart(3, '0')}.jsonl`);
        logPath = transcript;
      }
      ensureDir(path.dirname(logPath));
      const logStream = fs.createWriteStream(logPath, { encoding: 'utf8' });
      const lines = [];
      emit('iteration_start', { iter, model: sel.model, effort: sel.effort, tier: sel.tier, gap_s: Math.round(gapS * 10) / 10, head: headBefore, transcript: transcript ? path.relative(root, transcript).replace(/\\/g, '/') : '' });
      beat(iter);
      const timer = setInterval(() => beat(iter), 30000);

      const args = buildAgentArgs({ agent, cfg, model: sel.model, effort: sel.effort, root, budgetUsd: budget.iterationUsd });
      const handle = spawnAgent({
        root, agent, args, env: buildAgentEnv(agent, env), prompt,
        onLine: (line) => {
          lines.push(line);
          logStream.write(`${line}\n`);
          let text = null;
          try {
            text = renderEvent(JSON.parse(line));
          } catch {
            text = line.slice(0, 200);
          }
          if (text) info(text);
        },
        onStderr: (s) => process.stderr.write(s),
      });
      child = handle.child;
      const outcomeRun = await handle.done;
      child = null;
      clearInterval(timer);
      await new Promise((r) => logStream.end(r));
      if (outcomeRun.error) fail(outcomeRun.error);
      if (outcomeRun.exitCode !== 0) warn(`Agent exited with status ${outcomeRun.exitCode}`);
      if (interrupted) {
        stopReason = 'signal';
        break;
      }

      // ---- usage limit: wait for the reset instead of spending iterations on it ----
      const reset = usageLimitReset(lines, new Date());
      if (reset) {
        const waitS = waitSeconds(reset, new Date(), limitOpts);
        warn(`Usage limit reached. Waiting ${Math.round(waitS / 6) / 10}m for the reset at ${reset.toISOString()} - iteration ${iter} is not counted.`);
        emit('usage_limit_wait', { iter, resets_at: reset.toISOString(), wait_s: waitS });
        iter -= 1;
        if (opts.noTranscripts) fs.rmSync(logPath, { force: true });
        await sleep(waitS * 1000, () => beat(iter), () => interrupted);
        continue;
      }

      const endMs = Date.now();
      const headAfter = runGit(root, ['rev-parse', 'HEAD']).out;
      const fpAfter = progressFingerprint({ root, planFile, stateDir: path.relative(root, stateDir) });
      const status = readIterationStatus(statusPath, startMs);
      const testCmd = cfg.commands && typeof cfg.commands.test === 'string' ? cfg.commands.test : '';
      const metrics = transcriptMetrics(lines, testCmd ? { testPattern: new RegExp(testCmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) } : {});
      const row = buildIterationRow({
        run, iter, branch, specName, mode, modelLabel, startMs, endMs, gapS, exitCode: outcomeRun.exitCode,
        headBefore, headAfter, status, metrics, transcript: transcript ? path.relative(root, transcript).replace(/\\/g, '/') : '',
      });
      writeIterationRecord(stateDir, row);
      if (opts.noTranscripts) fs.rmSync(logPath, { force: true });
      writeText(lastEndFile, new Date(endMs).toISOString());

      say('');
      info(`${row.spec} | ${row.phase} | ${row.outcome}  (committed: ${row.committed})`);
      if (row.result) info(`result: ${row.result.slice(0, 200)}`);
      if (row.next) info(`next:   ${row.next.slice(0, 200)}`);
      info(`time:   wall ${row.dur_s}s = model ${row.api_s}s + tools ${row.tool_s}s + overhead ${row.overhead_s}s | idle ${Math.round(row.gap_s)}s | ${row.turns} turns / ${row.tool_calls} tools`);
      runSpent = Math.round((runSpent + (Number(row.cost_usd) || 0)) * 10000) / 10000;
      daySpent = Math.round((daySpent + (Number(row.cost_usd) || 0)) * 10000) / 10000;
      emit('spend', { iter, iteration_usd: row.cost_usd, run_usd: runSpent, day_usd: daySpent });
      recordSpend(env, { ts: row.ts, cost_usd: row.cost_usd, run: row.run, spec: row.spec, branch: row.branch });
      if (row.committed) commits += 1;
      await tell(mode === 'review' ? 'review_run' : 'iteration', mode === 'review' ? { text: String(status.result || status.did || 'A review pass finished').slice(0, 500) } : {});
      (anyCap(budget) ? info : warn)(`spend:  $${(Number(row.cost_usd) || 0).toFixed(4)} this iteration, $${runSpent.toFixed(2)} this run, $${daySpent.toFixed(2)} today${anyCap(budget) ? '' : ' (no cap set: watch this run)'}`);

      const decision = ejectDecision({
        outcome: row.outcome, fingerprintBefore: fpBefore, fingerprintAfter: fpAfter, headBefore, headAfter, stalled,
      });
      stalled = decision.stalled;
      emit('iteration_end', { iter, outcome: row.outcome, exit_code: outcomeRun.exitCode, dur_s: row.dur_s, head: headAfter, committed: row.committed, stalled_streak: stalled });

      // ---- phase-tick enforcement (build) ----
      if (mode === 'build' && fs.existsSync(planFile)) {
        const verifier = path.join(root, 'scripts', 'verify-plan-ticks.mjs');
        let ticks = '';
        if (fs.existsSync(verifier)) {
          const snapshot = path.join(root, '.claude-temp', 'plan-before-iteration.md');
          writeText(snapshot, planBefore);
          const r = spawnSync(process.execPath, [verifier, '--before', snapshot, '--after', planFile, '--fix'], { encoding: 'utf8', shell: false });
          const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
          if (r.status === 1) {
            warn(`GATE FAIL - reverted phase tick(s) made against unmet gate targets:\n${text}`);
            ticks = `FAIL - ${text.split(/\r?\n/).slice(0, 12).join(' / ')}`;
          } else if (r.status === 0) {
            ticks = 'ok';
          }
        }
        writeText(lastGateFile, JSON.stringify({ iter, ticks }));
      }

      // ---- push ----
      if (row.committed) {
        const pushed = pushBranch({ root, branch });
        if (pushed.skipped) info(`No push: ${pushed.skipped}`);
        else {
          emit('push', { iter, branch, remote: pushed.remote, ok: pushed.ok, dur_s: pushed.dur_s, ...(pushed.error ? { error: pushed.error } : {}) });
          if (pushed.ok) info(`Pushed ${branch} to ${pushed.remote}`);
          else warn(`Push failed: ${pushed.error}`);
        }
      }

      if (decision.stop) {
        say('');
        warn(decision.stop === 'blocked'
          ? 'BLOCKED - stopping the loop'
          : `STALLED - ${stalled} iterations changed nothing at all (no commit, no plan edit, no file touched); stopping`);
        say(`  Phase:  ${status.phase}`);
        if (status.did) say(`  Did:    ${status.did}`);
        if (status.result) say(`  Result: ${status.result}`);
        if (status.next) say(`  NEEDS:  ${status.next}`);
        say('  Resolve the above, then restart the loop.');
        stopReason = decision.stop;
        if (decision.stop === 'blocked') {
          /* The question goes to the owner's queue, with what they need to answer it, and later runs wait for it. */
          const question = String(status.next || status.result || 'The build needs a person to decide something.').replace(/\s+/g, ' ').slice(0, 500);
          const open = productQuestions(readText(planFile));
          await tell('parked', { text: question, context: [status.result ? `**What it found:** ${status.result}` : '', open.length ? `**The plan's open questions:**\n${open.join('\n')}` : ''].filter(Boolean).join('\n\n').slice(0, 20000) });
        }
        break;
      }

      const planNow = readText(planFile);
      if ((mode === 'build' && allPhasesDone(planNow)) || (mode === 'review' && /^passed$/i.test(status.exit_gate))) {
        info('Plan complete; stopping.');
        if (mode === 'build') await tell('review_required');
        stopReason = 'completed';
        break;
      }

      if (max === 0 || iter < max) {
        info(`Iteration ${iter} complete. Starting next in ${pauseS}s... (Ctrl+C to stop)`);
        await sleep(pauseS * 1000, null, () => interrupted);
      }
    }
    if (interrupted) stopReason = 'signal';
  } finally {
    emit('loop_stop', { reason: stopReason, iterations: iter, wall_s: Math.round((Date.now() - loopStart) / 1000) });
    await tell('run_ended', { stopReason });
    if (kairos?.pending()) warn(`${kairos.pending()} report(s) to Kairos could not be sent. The run's record is still in Git.`);
    removeHeartbeat(stateDir);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.removeListener(sig, onSignal);
  }
  say('');
  info(`Loop finished after ${iter} iteration(s) (${stopReason})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      fail(err && err.stack ? err.stack : String(err));
      process.exit(1);
    },
  );
}

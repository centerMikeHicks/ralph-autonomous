#!/usr/bin/env node
// CLI over the loop's pure helpers, for scripts, tests and debugging. Every subcommand prints
// JSON (or text for `status`) on stdout and exits 0, or 2 on a usage error.
//
//   driver.mjs run <loop args...>                  the whole loop (same as run-loop.mjs)
//   driver.mjs prepare <mode> [spec] [--model M]   resolve spec, prompt file, model -> JSON
//   driver.mjs select-model <mode> [--plan F] [--model M]
//   driver.mjs next-task [--plan F]                next task, mechanical?, exit gate next?
//   driver.mjs fingerprint [--plan F]              progress fingerprint of the working tree
//   driver.mjs usage-limit <transcript.jsonl>      reset time and wait seconds, or limited:false
//   driver.mjs record <row.json|-> [--state D]     append an iterations.jsonl + USAGE_LOG.md row
//   driver.mjs event <name> [json] [--state D]     append a loop-events.jsonl event
//   driver.mjs finish [--reason R] [--state D]     loop_stop event + remove the heartbeat
//   driver.mjs status                              the `loop status` text
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProjectConfig } from './load-config.mjs';
import { readJson, readText, splitLines } from './fsutil.mjs';
import { isExitGateNext, isMechanicalTask, nextTask } from './plan-parse.mjs';
import { selectModel } from './model-select.mjs';
import { usageLimitReset, waitSeconds } from './usage-limit.mjs';
import { progressFingerprint, resolveStateDir } from './progress.mjs';
import { resolveSpec, specBaseName } from './spec-tracker.mjs';
import { createEventLog, removeHeartbeat, usageLogRow, writeIterationRecord } from './telemetry.mjs';
import { statusReport } from './status.mjs';
import { main as runLoop } from './run-loop.mjs';

function flags(argv) {
  const positional = [];
  const named = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const [k, v] = argv[i].slice(2).split(/=(.*)/s);
      named[k] = v !== undefined ? v : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else positional.push(argv[i]);
  }
  return { positional, named };
}

const print = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

export async function cli(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  if (cmd === 'run') return runLoop(rest, env);
  const root = path.resolve(env.RALPH_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const cfg = await loadProjectConfig(root);
  const { positional, named } = flags(rest);
  const stateDir = named.state ? path.resolve(String(named.state)) : resolveStateDir(root, cfg);
  const planFile = named.plan ? path.resolve(String(named.plan)) : path.join(stateDir, 'IMPLEMENTATION_PLAN.md');
  const forced = String(named.model || env.RALPH_MODEL || '');

  switch (cmd) {
    case 'prepare': {
      const mode = positional[0] || 'build';
      const resolved = resolveSpec({ root, stateDir, specArg: positional[1] || '' });
      const planText = readText(planFile);
      const sel = selectModel({ mode, planText, models: cfg.models, forced });
      const promptFile = path.join(root, 'ralph', `PROMPT_${mode}.md`);
      print({
        mode, spec: resolved.spec, specName: specBaseName(resolved.spec), specMissing: resolved.missing,
        promptFile, promptExists: fs.existsSync(promptFile), ...sel,
      });
      return 0;
    }
    case 'select-model': {
      const mode = positional[0] || 'build';
      print(selectModel({ mode, planText: readText(planFile), models: cfg.models, forced }));
      return 0;
    }
    case 'next-task': {
      const text = readText(planFile);
      const task = nextTask(text);
      print({ task, mechanical: isMechanicalTask(task), exitGateNext: isExitGateNext(text) });
      return 0;
    }
    case 'fingerprint':
      print({ fingerprint: progressFingerprint({ root, planFile, stateDir: path.relative(root, stateDir) }) });
      return 0;
    case 'usage-limit': {
      if (!positional[0]) return usage();
      const now = new Date();
      const reset = usageLimitReset(splitLines(readText(positional[0])), now);
      print(reset ? { limited: true, resetsAt: reset.toISOString(), waitS: waitSeconds(reset, now) } : { limited: false });
      return 0;
    }
    case 'record': {
      const text = positional[0] === '-' ? fs.readFileSync(0, 'utf8') : readText(positional[0] || '');
      const row = JSON.parse(text.replace(/^﻿/, ''));
      writeIterationRecord(stateDir, row);
      print({ ok: true, usage_row: usageLogRow(row) });
      return 0;
    }
    case 'event': {
      if (!positional[0]) return usage();
      const data = positional[1] ? JSON.parse(positional[1]) : {};
      createEventLog(stateDir, String(named.run || 'manual'))(positional[0], data);
      print({ ok: true });
      return 0;
    }
    case 'finish': {
      const hb = readJson(path.join(stateDir, '.loop-heartbeat'), {});
      createEventLog(stateDir, hb.run || 'manual')('loop_stop', { reason: String(named.reason || 'signal'), iterations: hb.iter || 0 });
      removeHeartbeat(stateDir);
      print({ ok: true });
      return 0;
    }
    case 'status':
      process.stdout.write(`${statusReport({ root, stateDir, cfg })}\n`);
      return 0;
    default:
      return usage();
  }
}

function usage() {
  process.stderr.write('usage: driver.mjs run|prepare|select-model|next-task|fingerprint|usage-limit|record|event|finish|status ...\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
      process.exit(1);
    },
  );
}

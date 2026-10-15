// Text for `loop status`: active spec, tracker binding, liveness, last iteration, plan head.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, readText, splitLines } from './fsutil.mjs';
import { frontMatterValue } from './spec-tracker.mjs';
import { readJsonl } from './telemetry.mjs';

export function statusReport({ root, stateDir, cfg }) {
  const out = ['', 'Ralph Loop Status', '================='];
  const spec = readText(path.join(stateDir, 'ACTIVE_SPEC')).trim();
  if (!spec) {
    out.push('Active Spec: None set');
  } else {
    out.push(`Active Spec: ${spec}`);
    const specFile = path.resolve(root, spec);
    if (fs.existsSync(specFile)) {
      out.push('Spec Status: Found');
      if ((cfg.tracker || {}).provider === 'jira') {
        const issue = frontMatterValue(readText(specFile), 'tracker_issue');
        out.push(issue ? `Tracker:     ${issue} (from spec front matter)` : 'Tracker:     (none - add tracker_issue or pass --issue)');
      }
    } else {
      out.push('Spec Status: NOT FOUND (file missing)');
    }
  }

  const hb = readJson(path.join(stateDir, '.loop-heartbeat'), null);
  if (hb && hb.ts) {
    const age = Math.round((Date.now() - Date.parse(hb.ts)) / 1000);
    out.push(`Loop:        ${age < 120 ? 'running' : 'STALE heartbeat'} (run ${hb.run}, iteration ${hb.iter}, ${age}s ago)`);
  } else {
    out.push('Loop:        not running');
  }

  const rows = readJsonl(path.join(stateDir, 'iterations.jsonl'));
  const last = rows[rows.length - 1];
  if (last) {
    out.push(`Last iter:   #${last.iter} ${last.mode} ${last.outcome} (${last.spec}, ${last.phase}) at ${last.ts}`);
    if (last.next) out.push(`Next:        ${last.next}`);
  }

  const plan = readText(path.join(stateDir, 'IMPLEMENTATION_PLAN.md'));
  if (plan) {
    out.push('', 'Plan Status:', ...splitLines(plan).slice(0, 20));
  }
  return out.join('\n');
}

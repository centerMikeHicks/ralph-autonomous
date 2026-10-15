// Assembles the prompt for one fresh-context iteration:
// injected context blocks first, then the mode's PROMPT_<mode>.md verbatim.
import { planView } from './plan-parse.mjs';

const SEP = '\n\n---\n\n';

/**
 * Anchors: the files and line ranges a diff touched, so the next iteration reads those ranges
 * instead of searching for them. Parses `git diff --unified=0` output.
 * @returns {string[]} lines like "src/a.js:10-14"
 */
export function parseDiffAnchors(diffText, maxFiles = 40) {
  const out = [];
  let file = '';
  for (const line of String(diffText).split(/\r?\n/)) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) {
      file = f[1];
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const len = h[2] === undefined ? 1 : Number(h[2]);
      if (len === 0) continue; // pure deletion
      out.push(`${file}:${start}${len > 1 ? `-${start + len - 1}` : ''}`);
    }
  }
  const files = new Set();
  return out.filter((a) => {
    const f = a.slice(0, a.lastIndexOf(':'));
    files.add(f);
    return files.size <= maxFiles;
  });
}

function block(title, body) {
  const text = (body || '').trim();
  return text ? `## ${title}\n\n${text}${SEP}` : '';
}

/**
 * @param {object} p
 * @param {string} p.mode plan | build | review
 * @param {string} p.spec active spec path ('' when none)
 * @param {string} p.planText live plan text
 * @param {string} p.promptText contents of PROMPT_<mode>.md
 * @param {object|null} p.prevStatus previous ITERATION_STATUS.json (parsed) with {stale}
 * @param {string[]} p.anchors "path:lines" strings from the previous iteration
 * @param {{enabled:boolean, issue:string, project:string, state:string, text:string}|null} p.tracker
 * @param {{ticks?:string, exitGate?:string}|null} p.gate last verification verdict
 * @param {string} p.preflightFailure text of a pending failure note ('' when none)
 */
export function assemblePrompt(p) {
  let out = '';
  if (p.preflightFailure && p.preflightFailure.trim()) out += `${p.preflightFailure.trim()}${SEP}`;
  if (p.spec) {
    out += `## Active Spec File\n\nThe current spec being implemented is: \`${p.spec}\`\nIgnore other files in the specs directory.${SEP}`;
  }
  if (p.mode === 'build' && p.planText) {
    out += block('The plan, cut to this iteration (status, phase overview, the NEXT phase in full)', planView(p.planText));
  }
  if ((p.mode === 'build' || p.mode === 'review') && p.anchors && p.anchors.length) {
    out += block(
      'Where the last iteration worked (from git: files and line ranges it changed - read these ranges instead of searching)',
      p.anchors.map((a) => `- ${a}`).join('\n'),
    );
  }
  if (p.prevStatus) {
    const s = p.prevStatus;
    const lines = [
      s.stale ? '_STALE: older than the plan or ledger; treat as history, not as the current hand-off._' : '',
      `- spec: ${s.spec ?? '-'}`,
      `- phase: ${s.phase ?? '-'}`,
      `- outcome: ${s.outcome ?? '-'}`,
      `- did: ${s.did ?? ''}`,
      `- result: ${s.result ?? ''}`,
      `- next: ${s.next ?? ''}`,
    ].filter(Boolean);
    out += block("The previous iteration's hand-off (.ralph/ITERATION_STATUS.json)", lines.join('\n'));
  }
  if (p.tracker && p.tracker.enabled && p.tracker.issue) {
    const t = p.tracker;
    const head = [
      `This loop run is bound to tracker ticket **${t.issue}**${t.project ? ` (project: ${t.project})` : ''}.`,
      '',
      `- Coordination state file (read + update each iteration): \`${t.state}\``,
      `- Current loop mode: \`${p.mode}\``,
    ].join('\n');
    out += block('Tracker Ticket', `${head}\n\n${t.text || ''}`);
  }
  if (p.gate && (p.gate.ticks || p.gate.exitGate)) {
    const parts = [];
    if (p.gate.ticks) parts.push(`Phase-tick check after the previous iteration: ${p.gate.ticks}`);
    if (p.gate.exitGate) parts.push(`Exit gate reported by the previous iteration: ${p.gate.exitGate}`);
    out += block('Last verification verdict (run by the harness - fact, not a request)', parts.join('\n'));
  }
  return out + p.promptText;
}

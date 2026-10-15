// Pure parsing of the live implementation plan: the NEXT marker, the next task, Exit Gate
// detection, mechanical-task detection and the pre-cut plan view injected into prompts.
import { splitLines } from './fsutil.mjs';

const NEXT_RE = /(←|<-)\s*NEXT/;
const PHASE_RE = /^- \[(.)\] \*\*/;
const MECHANICAL_RE =
  /^\W*(\[DOC\]|regenerate|re-?run|re-?capture|codemod|rename|reformat|update the (ledger|changelog|docs?)|bump version)/i;

/** True when the Exit Gate is the phase to work on next. */
export function isExitGateNext(planText) {
  if (!planText) return false;
  const lines = splitLines(planText);
  if (lines.some((l) => /Exit Gate.*(←|<-)\s*NEXT/.test(l))) return true;
  const firstUnchecked = lines.find((l) => /^- \[ \]/.test(l));
  return Boolean(firstUnchecked && /exit gate/i.test(firstUnchecked));
}

/** First unchecked task under the phase marked NEXT (or the first in the file). '' when none. */
export function nextTask(planText) {
  if (!planText) return '';
  const lines = splitLines(planText);
  let start = lines.findIndex((l) => NEXT_RE.test(l));
  // With no marker, begin at the first unchecked phase so the whole file is not scanned from the top.
  if (start < 0) start = Math.max(0, lines.findIndex((l) => /^- \[ \] \*\*/.test(l)));
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && PHASE_RE.test(lines[i])) break;
    const m = /^\s+- \[ \] (.+)$/.exec(lines[i]);
    if (m) return m[1];
  }
  return '';
}

/** Mechanical when tagged [haiku]/[mechanical] or the text reads like a codemod/regeneration/doc pass. */
export function isMechanicalTask(task) {
  if (!task) return false;
  if (/\[(haiku|mechanical)\]/i.test(task)) return true;
  if (/\[sonnet\]/i.test(task)) return false;
  return MECHANICAL_RE.test(task);
}

/** Phase headings (column-0 checkbox lines) with state and line index. */
export function phases(planText) {
  const out = [];
  splitLines(planText || '').forEach((line, index) => {
    const m = /^- \[(.)\] (.+)$/.exec(line);
    if (m) out.push({ index, checked: m[1].toLowerCase() === 'x', text: m[2], next: NEXT_RE.test(line) });
  });
  return out;
}

/** True when the plan has phases and every one is ticked. */
export function allPhasesDone(planText) {
  const list = phases(planText);
  return list.length > 0 && list.every((p) => p.checked);
}

/**
 * The slice of the plan an iteration needs: the status line, the phase overview, and the NEXT
 * phase in full. The whole file stays on disk for a named section.
 */
export function planView(planText) {
  if (!planText || !planText.trim()) return '';
  const lines = splitLines(planText);
  const status = lines.find((l) => /^## Status:/.test(l)) || '';
  const list = phases(planText);
  if (!list.length) return [status, '(the plan has no phases yet)'].filter(Boolean).join('\n');
  let nextIdx = list.findIndex((p) => p.next);
  if (nextIdx < 0) nextIdx = list.findIndex((p) => !p.checked);
  const overview = list.map((p) => `- [${p.checked ? 'x' : ' '}] ${p.text}`).join('\n');
  let detail = '';
  if (nextIdx >= 0) {
    const from = list[nextIdx].index;
    let end = nextIdx + 1 < list.length ? list[nextIdx + 1].index : lines.length;
    // The last phase is followed by sections such as Decisions; stop at the next "## " heading.
    for (let i = from + 1; i < end; i += 1) {
      if (/^## /.test(lines[i])) {
        end = i;
        break;
      }
    }
    detail = lines.slice(from, end).join('\n').trimEnd();
  }
  return [status, '### Phases', overview, detail && '### Current phase (full)', detail].filter(Boolean).join('\n');
}

/** Spec path recorded under "## Active Spec" in a plan, or ''. */
export function planActiveSpec(planText) {
  const m = /^## Active Spec[ \t]*\r?\n\s*`?([^`\r\n]+)`?/m.exec(planText || '');
  return m ? m[1].trim() : '';
}

/**
 * One parser for the shapes the kit's verifiers read: a spec (front matter, sections,
 * phases with acceptance rows, success criteria, decisions, tables) and a plan
 * (phases with tasks, `<- NEXT`, `gate:`, `Files:`, `Tests:`).
 *
 * Spec phases are `### Phase <id>: <title>` headings (or an `Exit Gate` heading); each carries
 * rows of the shape
 *
 *   - [ ] `[unit]` testName — Given X, When Y, Then Z
 *   - [ ] `[integration] testName` — ...
 *   - [ ] `[visual-only]` — <how it is checked by eye>
 *   - [ ] `[e2e]` — none: <why this layer has nothing to prove>
 *
 * Plan phases are `- [ ] **Phase <id>: <title>**` (or `**Exit Gate**`) at column 0 with
 * indented `- [ ]` tasks beneath. A phase key is `phase-<id>` (lower case) or `exit-gate`, the
 * same on both sides, so a phase ticked in the plan resolves to the same spec phase everywhere.
 */

export const TAGS = ['unit', 'integration', 'e2e', 'visual-only'];

const clean = (text) => String(text ?? '').replace(/^﻿/, '');
export const splitLines = (text) => clean(text).split(/\r?\n/);

/** `phase-3b` for "Phase 3b", `exit-gate` for the Exit Gate. */
export function phaseKey(id) {
  return id ? `phase-${String(id).toLowerCase()}` : 'exit-gate';
}

// --- front matter ----------------------------------------------------------------------------
/** `{ present, data, endLine }` — flat `key: value` pairs between a leading `---` pair. */
export function parseFrontMatter(text) {
  const lines = splitLines(text);
  if (lines[0]?.trim() !== '---') return { present: false, data: {}, endLine: 0 };
  const data = {};
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') return { present: true, data, endLine: i + 1 };
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (m) data[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { present: false, data, endLine: 0, unterminated: true };
}

// --- sections and tables -----------------------------------------------------------------------
/** Each line tagged with whether it sits inside a fenced code block (fence lines included). */
export function markFences(lines) {
  let fenced = false;
  return lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return { text: l, fenced: true }; }
    return { text: l, fenced };
  });
}

/** Every heading outside code fences: `{ level, text, line }`. */
export function parseHeadings(text) {
  const out = [];
  markFences(splitLines(text)).forEach(({ text: t, fenced }, i) => {
    if (fenced) return;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
  });
  return out;
}

/** Lines under the first heading matching `headingRe`, up to the next heading of the same or higher level. */
export function sectionLines(lines, headingRe) {
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && headingRe.test(l));
  if (start < 0) return [];
  const level = /^(#+)/.exec(lines[start])[1].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const h = /^(#+)\s/.exec(lines[i]);
    if (h && h[1].length <= level) break;
    out.push({ line: i + 1, text: lines[i] });
  }
  return out;
}

/** Body rows of every markdown table in a section (header and separator rows skipped). */
export function tableRows(section) {
  const rows = [];
  let seenHeader = false;
  let afterSeparator = false;
  for (const { line, text } of section) {
    const isRow = /^\s*\|.*\|\s*$/.test(text);
    if (!isRow) { seenHeader = false; afterSeparator = false; continue; }
    if (/^\s*\|\s*:?-{2,}/.test(text)) { afterSeparator = true; continue; }
    if (!seenHeader) { seenHeader = true; continue; }
    if (!afterSeparator) continue;
    const cells = text.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
    rows.push({ line, cells });
  }
  return rows;
}

// --- acceptance rows and spec phases ---------------------------------------------------------------
const COMMAND_RE = /`[^`]*\b(?:node|npm|npx|pnpm|yarn|make|grep|git|python|pytest|cargo|go|dotnet|pwsh|powershell|sh|bash)\s[^`]*`/;

/**
 * Parse one acceptance row, or null when the line is not one. `kind` is what the row binds to:
 * `test` (a named test), `visual-only`, `none` (the spec says this layer has nothing to prove),
 * `command` (the proof is a shell command exiting 0) or `unnamed` (a defect: nothing can bind it).
 */
export function parseAcceptanceRow(line) {
  const head = /^\s*-\s*\[([ xX])\]\s*(.*)$/.exec(line);
  if (!head) return null;
  const tagM = /^`?\[(unit|integration|e2e|visual-only)\]`?\s*(.*)$/.exec(head[2]);
  if (!tagM) return null;
  const tag = tagM[1];
  let rest = tagM[2];
  let name = null;
  const quoted = /^`([^`]+)`\s*(.*)$/.exec(rest);
  if (quoted && !COMMAND_RE.test(`\`${quoted[1]}\``)) {
    name = quoted[1].trim();
    rest = quoted[2];
  } else if (!quoted) {
    const bare = /^([A-Za-z][\w.-]*)`?(?=\s|$)\s*(.*)$/.exec(rest);
    if (bare && !/^none$/i.test(bare[1])) { name = bare[1]; rest = bare[2]; }
  }
  const text = rest.replace(/^(?:—|–|--|-)\s*/, '').trim();
  const isCommand = COMMAND_RE.test(line);
  let kind = 'test';
  if (tag === 'visual-only') kind = 'visual-only';
  else if (!name && /^none\b/i.test(text)) kind = 'none';
  else if (!name && isCommand) kind = 'command';
  else if (!name) kind = 'unnamed';
  return { ticked: /[xX]/.test(head[1]), tag, name, text, kind, isCommand };
}

const SPEC_PHASE_RE = /^(#{2,4})\s+(?:\[[^\]]*\]\s*)?(?:Phase\s+(\d+[a-z]?)\b\s*[:—–-]?\s*(.*)|(Exit Gate)\b\s*[:—–-]?\s*(.*))$/i;

/**
 * The spec's phases with their acceptance rows. A row continues onto following indented
 * non-bullet lines (its Given/When/Then often wraps).
 * @returns {{ id, key, aliases, title, line, level, hasAcceptanceBlock, rows, body }[]}
 */
export function parseSpecPhases(specText) {
  const lines = markFences(splitLines(specText));
  const phases = [];
  let current = null;
  let row = null;
  lines.forEach(({ text: raw, fenced }, i) => {
    if (fenced) return;
    const h = SPEC_PHASE_RE.exec(raw);
    if (h) {
      row = null;
      const isExit = Boolean(h[4]);
      const title = (isExit ? h[5] : h[3] ?? '').trim();
      current = {
        id: isExit ? null : h[2], key: isExit ? 'exit-gate' : phaseKey(h[2]),
        aliases: isExit || /exit gate/i.test(title) ? ['exit-gate'] : [],
        title: isExit ? `Exit Gate${title ? `: ${title}` : ''}` : title, line: i + 1, level: h[1].length,
        hasAcceptanceBlock: false, rows: [], body: [],
      };
      phases.push(current);
      return;
    }
    const heading = /^(#{1,6})\s/.exec(raw);
    if (heading) {
      row = null;
      if (heading[1].length <= 3 || (current && heading[1].length <= current.level)) current = null;
      return;
    }
    if (!current) return;
    if (/^\*\*Acceptance Tests\*\*/i.test(raw.trim())) { current.hasAcceptanceBlock = true; row = null; return; }
    const parsed = parseAcceptanceRow(raw);
    if (parsed) { row = { ...parsed, line: i + 1 }; current.rows.push(row); return; }
    if (row && /^\s{2,}\S/.test(raw) && !/^\s*[-*]\s/.test(raw)) { row.text = `${row.text} ${raw.trim()}`.trim(); return; }
    row = null;
    if (raw.trim()) current.body.push({ line: i + 1, text: raw, inAcceptance: current.hasAcceptanceBlock });
  });
  return phases;
}

/** `- [ ] SC1: text` success criteria anywhere in the spec: `{ id: 'SC1', ticked, text, line }`. */
export function parseSuccessCriteria(specText) {
  const out = [];
  markFences(splitLines(specText)).forEach(({ text, fenced }, i) => {
    if (fenced) return;
    const m = /^\s*-\s*\[([ xX])\]\s*\*{0,2}(SC-?\d+)\*{0,2}\s*[:—–-]?\s*(.*)$/.exec(text);
    if (m) out.push({ id: m[2].replace('-', '').toUpperCase(), ticked: /[xX]/.test(m[1]), text: m[3], line: i + 1 });
  });
  return out;
}

/** Decision-log entries `**D3 — title**` or `D3:` at the start of a (bulleted) line. */
export function parseDecisions(specText) {
  const lines = splitLines(specText);
  const out = [];
  lines.forEach((raw, i) => {
    const m = /^\s*-?\s*(?:\[[ xX]\]\s*)?\*\*D(\d+)\b/.exec(raw) ?? /^\s*(?:-\s*)?D(\d+)\s*[:—–-]\s/.exec(raw);
    if (!m) return;
    let text = raw;
    for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\s*-\s*(?:\[[ xX]\]\s*)?\*\*D\d+/.test(lines[j]); j += 1) text += ` ${lines[j].trim()}`;
    out.push({ id: `D${m[1]}`, line: i + 1, text });
  });
  return out;
}

// --- plan ----------------------------------------------------------------------------------------
const PLAN_PHASE_RE = /^-\s*\[([ xX])\]\s*(?:\*\*)?\s*(?:Phase\s+(\d+[a-z]?)\b\s*[:—–-]?\s*([^*]*)|(Exit Gate))/i;
const NEXT_RE = /(?:←|<-)\s*NEXT\b/;

/** The phase a plan line ticks (or leaves open), or null when it is not a column-0 phase line. */
export function planPhaseOf(line) {
  const m = PLAN_PHASE_RE.exec(line);
  if (!m) return null;
  return { ticked: /[xX]/.test(m[1]), key: m[2] ? phaseKey(m[2]) : 'exit-gate', id: m[2] ?? null, title: (m[3] ?? 'Exit Gate').replace(NEXT_RE, '').trim() };
}

/**
 * The plan's phases with their tasks. A phase owns every line up to the next column-0
 * checkbox or heading; tasks are its indented checkboxes, each with `Files:` / `Tests:`
 * continuation lines. `gate:` lines belong to the phase.
 */
export function parsePlan(planText) {
  const lines = splitLines(planText);
  const phases = [];
  let current = null;
  let task = null;
  lines.forEach((raw, i) => {
    if (/^#{1,6}\s/.test(raw)) { current = null; task = null; return; }
    const p = planPhaseOf(raw);
    if (p) {
      current = { ...p, line: i + 1, text: raw, next: NEXT_RE.test(raw), gate: null, tasks: [], block: [] };
      phases.push(current);
      task = null;
      return;
    }
    if (/^-\s*\[[ xX]\]/.test(raw)) { current = null; task = null; return; }
    if (!current) return;
    current.block.push({ line: i + 1, text: raw });
    const g = /^\s*gate:\s*(.*)$/i.exec(raw);
    if (g) { current.gate = g[1].trim(); return; }
    const t = /^\s+-\s*\[([ xX])\]\s*(.*)$/.exec(raw);
    if (t) {
      task = { line: i + 1, ticked: /[xX]/.test(t[1]), text: t[2], files: [], tests: [] };
      current.tasks.push(task);
      return;
    }
    if (!task) return;
    const f = /^\s+Files:\s*(.*)$/i.exec(raw);
    const ts = /^\s+Tests:\s*(.*)$/i.exec(raw);
    if (f) task.files.push(...f[1].split(',').map((s) => s.trim()).filter(Boolean));
    else if (ts) task.tests.push(...ts[1].split(/[,;]/).map((s) => s.trim().replace(/^`|`$/g, '')).filter(Boolean));
  });
  return phases;
}

/** Every plan phase line with its 1-based line number. */
export function parsePlanPhases(planText) {
  return parsePlan(planText).map((p) => ({ ticked: p.ticked, key: p.key, id: p.id, line: p.line, text: p.text }));
}

/** The spec phase a plan phase key names: by key, then by alias (`Exit Gate` <-> `Phase 5: Exit Gate`). */
export function findSpecPhase(phases, key) {
  return phases.find((p) => p.key === key) ?? phases.find((p) => p.aliases.includes(key)) ?? null;
}

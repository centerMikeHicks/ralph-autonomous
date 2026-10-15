#!/usr/bin/env node
/**
 * lint-spec.mjs — the structural defects a spec can carry into a build loop.
 *
 *   node scripts/lint-spec.mjs --spec S [--strict] [--json]
 *
 * Errors always fail (exit 1); advisories fail only under --strict. Exit 2 = cannot run.
 * Every finding carries a rule id and a file:line.
 *
 *   front-matter      the spec opens with a `---` block; with tracker.provider "jira" it carries
 *                     `tracker_issue:`
 *   section           a required `##` section is missing
 *   phase-acceptance  a phase has no `**Acceptance Tests**` block, or the block holds no rows
 *   row-tag           a checkbox under Acceptance Tests has no `[unit|integration|e2e|visual-only]` tag
 *   row-name          a tagged row names no test (and is not `none`, a command, or visual-only)
 *   row-form          advisory: a named row lacks the Given / When / Then it should state
 *   sc-trace          a Success Criterion `SCn` is cited by no acceptance row or phase
 *   open-question     an Open Questions entry is not tagged `[product]` or `[tooling]`
 *   todo              a bare TODO / TBD / FIXME outside code
 *   decision-dup      a decision id `Dn` is defined twice
 *   contradiction     one Then says "disabled" and "absent/hidden" (or similar) of the same subject
 *   grep-row          advisory: a row asserts by grep / "returns nothing" (tests words, not behaviour)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, usageExit } from './lib/args.mjs';
import { getContext, readText } from './lib/context.mjs';
import {
  parseFrontMatter, parseHeadings, parseSpecPhases, parseSuccessCriteria, parseDecisions,
  markFences, splitLines, sectionLines,
} from './lib/spec-parse.mjs';

/** `contradiction` vocabulary: phrases in `a` and `b` cannot both be true of one control. Add rows, not special cases. */
export const CONTRADICTIONS = [
  {
    a: ['disabled', 'greyed out', 'grayed out', 'greyed-out'],
    b: ['absent', 'hidden', 'not rendered', 'not shown', 'does not render', 'removed'],
    why: 'a control cannot be both disabled and not rendered (a disabled control shows its reason; an absent one shows nothing)',
  },
  {
    a: ['disabled'],
    b: ['when attempted', 'is attempted', 'a blocked attempt', 'on click fires', 'click fires', 'when clicked', 'when pressed'],
    why: 'a disabled control cannot be attempted or clicked, so nothing can fire from it',
  },
];

export const REQUIRED_SECTIONS = [
  ['Overview', /^overview\b/i],
  ['Problem Statement', /^problem statement\b/i],
  ['Scope', /^scope\b/i],
  ['Technical Design', /^technical design\b/i],
  ['Implementation Plan', /^implementation plan\b/i],
  ['Edge Cases', /^edge cases\b/i],
  ['Security Considerations', /^security considerations\b/i],
  ['Testing Strategy', /^testing strategy\b/i],
  ['Open Questions', /^open questions\b/i],
  ['References', /^references\b/i],
];

const GREP_RE = /\bgrep\b|\brg\b(?=\s)|search(?:ing)? the repo|returns nothing|no hits\b/i;
const strip = (s) => String(s).replace(/[`*_"“”]/g, '');

function subjectBefore(words, idx) {
  for (let j = idx - 1; j >= Math.max(0, idx - 8); j -= 1) {
    const w = words[j].replace(/^[("'`]+|[)"'`,.;:]+$/g, '');
    if (/^[A-Z]/.test(w) || /^`/.test(words[j])) return w.toLowerCase();
    if (/^(is|are|stays|remains|be|being)$/i.test(w) && j > 0) return words[j - 1].replace(/^[("'`]+|[)"'`,.;:]+$/g, '').toLowerCase();
  }
  return null;
}

export function findContradictions(text) {
  const t = String(text);
  const lower = t.toLowerCase();
  const words = t.split(/\s+/);
  const wordStart = [];
  let pos = 0;
  for (const w of words) { const at = t.indexOf(w, pos); wordStart.push(at); pos = at + w.length; }
  const wordIndexAt = (offset) => { let k = 0; while (k + 1 < wordStart.length && wordStart[k + 1] <= offset) k += 1; return k; };
  const hits = (phrases) => phrases.flatMap((p) => {
    const out = [];
    let i = lower.indexOf(p);
    while (i >= 0) { out.push({ phrase: p, subject: subjectBefore(words, wordIndexAt(i)) }); i = lower.indexOf(p, i + 1); }
    return out;
  });
  const found = [];
  for (const rule of CONTRADICTIONS) {
    for (const a of hits(rule.a)) {
      for (const b of hits(rule.b)) {
        if (a.subject && b.subject && a.subject === b.subject) found.push({ a: a.phrase, b: b.phrase, subject: a.subject, why: rule.why, severity: 'error' });
        else if (!a.subject || !b.subject) found.push({ a: a.phrase, b: b.phrase, subject: a.subject ?? b.subject ?? null, why: rule.why, severity: 'advisory' });
      }
    }
  }
  return found;
}

/**
 * Lint a spec's text. `options.trackerProvider` ("none" | "jira") enables the tracker front-matter rule.
 * @returns {{ spec, findings, errors, advisories }}
 */
export function lintSpec(text, { specPath = 'spec.md', trackerProvider = 'none', strict = false } = {}) {
  const findings = [];
  const add = (rule, severity, line, message) => findings.push({ rule, severity: strict && severity === 'advisory' ? 'error' : severity, file: specPath, line, message });
  const lines = splitLines(text);
  const marked = markFences(lines);
  const headings = parseHeadings(text);

  // front-matter
  const fm = parseFrontMatter(text);
  if (!fm.present) add('front-matter', 'error', 1, fm.unterminated ? 'front matter opened with `---` is never closed' : 'the spec must open with a `---` front-matter block');
  else if (trackerProvider === 'jira' && !fm.data.tracker_issue) add('front-matter', 'error', 1, 'tracker.provider is "jira" but the front matter has no `tracker_issue:`');

  // section
  for (const [name, re] of REQUIRED_SECTIONS) {
    if (!headings.some((h) => h.level === 2 && re.test(h.text))) add('section', 'error', 1, `required section "## ${name}" is missing`);
  }

  // phases
  const phases = parseSpecPhases(text);
  const nonExit = phases.filter((p) => p.key !== 'exit-gate');
  if (!phases.length) add('phase-acceptance', 'error', 1, 'the Implementation Plan has no `### Phase N:` headings');
  for (const p of phases) {
    if (!p.hasAcceptanceBlock) add('phase-acceptance', 'error', p.line, `"${p.title.slice(0, 60)}" has no **Acceptance Tests** block`);
    else if (!p.rows.length) add('phase-acceptance', 'error', p.line, `"${p.title.slice(0, 60)}" has an **Acceptance Tests** block with no rows`);
  }

  // rows: a checkbox under an Acceptance Tests block that parsed as no row has no valid tag
  for (const p of phases) {
    for (const b of p.body) {
      if (b.inAcceptance && /^\s*-\s*\[[ xX]\]\s/.test(b.text)) {
        add('row-tag', 'error', b.line, 'acceptance row has no tag: start it with `[unit]`, `[integration]`, `[e2e]` or `[visual-only]`');
      }
    }
  }
  for (const p of phases) {
    for (const r of p.rows) {
      if (r.kind === 'unnamed') add('row-name', 'error', r.line, `\`[${r.tag}]\` row names no test — write \`[${r.tag}] testName — Given X, When Y, Then Z\` (or \`none: why\`)`);
      if (r.kind === 'test') {
        const missing = ['Given', 'When', 'Then'].filter((w) => !new RegExp(`\\b${w}\\b`).test(r.text));
        if (missing.length) add('row-form', 'advisory', r.line, `row \`${r.name}\` does not state ${missing.join(', ')} (form: \`[tag] name — Given X, When Y, Then Z\`)`);
      }
      if (GREP_RE.test(strip(r.text))) add('grep-row', 'advisory', r.line, 'a grep-style assertion tests the presence of words, not behaviour — reword as a behaviour check');
      const then = /\bThen\b(.*)$/.exec(r.text);
      if (then) {
        for (const c of findContradictions(then[1])) {
          add('contradiction', c.severity, r.line, `"${c.a}" and "${c.b}"${c.subject ? ` both said of "${c.subject}"` : ' in one Then'} — ${c.why}`);
        }
      }
    }
  }

  // sc-trace: an SCn must be cited by an acceptance row/phase body or anywhere in the Implementation Plan section
  const criteria = parseSuccessCriteria(text);
  const planSection = sectionLines(lines, /^##\s+Implementation Plan\b/i);
  const planText = planSection.map((l) => l.text).join('\n');
  for (const sc of criteria) {
    const cited = new RegExp(`\\b${sc.id.replace('SC', 'SC-?')}\\b`, 'i').test(planText);
    if (!cited) add('sc-trace', 'error', sc.line, `${sc.id} is traced to no acceptance row — cite it (e.g. "(${sc.id})") in a row or its phase`);
  }
  if (nonExit.length && !criteria.length && headings.some((h) => /^success criteria/i.test(h.text))) {
    add('sc-trace', 'error', 1, 'Success Criteria section has no `- [ ] SCn:` entries');
  }

  // open-question
  const oq = sectionLines(lines, /^##\s+Open Questions\b/i);
  for (const { line, text: l } of oq) {
    const m = /^\s*-\s*(?:\[[ xX]\]\s*)?(.*)$/.exec(l);
    if (!m || !m[1].trim()) continue;
    if (/^(none|n\/a|—|-)\.?$/i.test(strip(m[1]).trim())) continue;
    if (!/`?\[(product|tooling)\]`?/i.test(m[1])) add('open-question', 'error', line, 'open question is not tagged `[product]` (a person decides) or `[tooling]` (the build loop resolves it)');
  }

  // todo
  marked.forEach(({ text: l, fenced }, i) => {
    if (fenced) return;
    const noCode = l.replace(/`[^`]*`/g, '');
    if (/\b(TODO|TBD|FIXME)\b/.test(noCode)) add('todo', 'error', i + 1, 'bare TODO/TBD/FIXME — decide it, or move it to Open Questions with a tag');
  });

  // decision-dup
  const seen = new Map();
  for (const d of parseDecisions(text)) {
    if (seen.has(d.id)) add('decision-dup', 'error', d.line, `${d.id} is defined again here (first at line ${seen.get(d.id)}); define each decision once`);
    else seen.set(d.id, d.line);
  }

  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return { spec: specPath, findings, errors: findings.filter((f) => f.severity === 'error').length, advisories: findings.filter((f) => f.severity === 'advisory').length };
}

function main() {
  const USAGE = 'lint-spec.mjs --spec S [--strict] [--json]';
  let args;
  try { args = parseArgs(process.argv.slice(2), { flags: ['strict', 'json'], opts: ['spec'] }); } catch (e) { usageExit(e.message, USAGE); }
  const ctx = getContext();
  const specArg = args.spec ?? ctx.activeSpec();
  if (!specArg) usageExit('lint-spec: no spec — pass --spec', USAGE);
  const specPath = ctx.resolve(specArg);
  if (!fs.existsSync(specPath)) usageExit(`lint-spec: spec not found: ${specArg}`, USAGE);
  const rel = path.relative(process.cwd(), specPath).split(path.sep).join('/');
  const result = lintSpec(readText(specPath), { specPath: rel, trackerProvider: ctx.config.tracker.provider, strict: Boolean(args.strict) });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const f of result.findings) console.log(`${f.rule} [${f.severity}] ${f.file}:${f.line} — ${f.message}`);
    console.log(`lint-spec ${rel}: ${result.errors} error(s), ${result.advisories} advisory${args.strict ? ' (strict: advisories count as errors)' : ''}`);
  }
  process.exit(result.errors ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

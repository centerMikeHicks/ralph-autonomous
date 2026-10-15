#!/usr/bin/env node
/**
 * Decisions to review: one list of everything the loops and the supervising skill decided, asked or
 * deferred, gathered from the places they record it, so a person coming back reads one report
 * instead of six files.
 *
 *   NEEDS YOU     parked queue lines, open [product] questions, review findings left for a person,
 *                 candidate waivers, [ASK] entries in a talk log
 *   DECIDED FOR YOU
 *                 [REVIEW] / [REVIEW: SCOPE] calls in a talk log or a spec's Open Questions, plan
 *                 decisions (D<n> under the plan's ## Decisions), Tooling: commits and commits
 *                 tagged [REVIEW: SCOPE] on this branch
 *   DEFERRED      CANDIDATE-SPEC rows: findings outside the spec's scope, recorded instead of built
 *
 * An entry the person has accepted is marked [REVIEWED] (replace the [REVIEW] tag, or append
 * [REVIEWED] to a plan decision) and drops out of the report; --all shows it again.
 *
 * Sources: <specsDir>/**.md, <stateDir>/IMPLEMENTATION_PLAN.md and archived IMPLEMENTATION_PLAN.<spec>.md,
 * .claude-temp/<topic>/TALK.md (or --talk FILE), .claude-temp/ralph-queue/QUEUE.md (or --queue FILE),
 * and git log <base>..HEAD.
 *
 * Usage: node scripts/ralph-decisions.mjs [--spec NAME] [--since DATE] [--all] [--json]
 *                                         [--talk FILE] [--queue FILE] [--base REF]
 * Exit: 0 report printed (whether or not anything needs you), 2 usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, usageExit } from './lib/args.mjs';
import { getContext, readText, specName } from './lib/context.mjs';
import { sectionLines, splitLines } from './lib/spec-parse.mjs';

const REVIEWED = /\[REVIEWED\b/i;
const REVIEW_TAG = /\[REVIEW(?::\s*SCOPE)?\]/i;
const one = (s) => String(s).replace(/\s+/g, ' ').trim();

/** A markdown bullet with its continuation lines folded in: [{ line, text }]. */
function bullets(lines) {
  const out = [];
  for (const { line, text } of lines) {
    if (/^\s*-\s/.test(text)) out.push({ line, text: text.trim() });
    else if (out.length && /^\s{2,}\S/.test(text)) out[out.length - 1].text += ` ${text.trim()}`;
  }
  return out;
}

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

/** Open Questions of a spec: open [product] questions, and agent-made calls tagged [REVIEW]. */
export function fromSpec(text, file) {
  const items = [];
  const section = sectionLines(splitLines(text), /^#+\s*Open Questions/i);
  for (const b of bullets(section)) {
    const open = /^-\s*\[ \]/.test(b.text);
    const body = one(b.text.replace(/^-\s*\[[ xX]\]\s*/, ''));
    if (REVIEW_TAG.test(body) && !REVIEWED.test(body)) {
      items.push({ group: 'decided', kind: /SCOPE/i.test(body) ? 'scope' : 'agent call', text: body, file, line: b.line, reviewed: false });
    } else if (REVIEWED.test(body)) {
      items.push({ group: 'decided', kind: 'agent call', text: body, file, line: b.line, reviewed: true });
    } else if (open && !/\[tooling\]/i.test(body)) { // untagged counts as [product] (CONVENTIONS section 7)
      items.push({ group: 'needs', kind: 'question', text: body, file, line: b.line });
    }
  }
  return items;
}

/** A plan's Decisions, Waivers and Open Questions / Blocked. */
export function fromPlan(text, file) {
  const lines = splitLines(text);
  const items = [];
  const spec = (sectionLines(lines, /^##\s*Active Spec/i).map((l) => l.text).join(' ').match(/`([^`]+)`/) || [])[1] || null;
  for (const b of bullets(sectionLines(lines, /^##\s*Decisions/i))) {
    const body = one(b.text.replace(/^-\s*/, ''));
    if (!/^D\d+\b/.test(body)) continue;
    items.push({ group: 'decided', kind: 'plan decision', spec, text: body, file, line: b.line, reviewed: REVIEWED.test(body) });
  }
  for (const b of bullets(sectionLines(lines, /^##\s*Waivers/i))) {
    const body = one(b.text.replace(/^-\s*(\[[ xX]\]\s*)?/, ''));
    if (body && !/^\(none\)$/i.test(body)) items.push({ group: 'needs', kind: 'waiver', spec, text: body, file, line: b.line });
  }
  for (const b of bullets(sectionLines(lines, /^##\s*Open Questions/i))) {
    if (!/^-\s*\[ \]/.test(b.text)) continue;
    const body = one(b.text.replace(/^-\s*\[ \]\s*/, ''));
    if (/CANDIDATE-SPEC/i.test(body)) items.push({ group: 'deferred', kind: 'candidate', spec, text: body, file, line: b.line });
    else if (/\[tooling\]/i.test(body)) continue; // the build loop fixes these itself
    else items.push({ group: 'needs', kind: /\bREVIEW:/.test(body) ? 'finding' : 'question', spec, text: body, file, line: b.line });
  }
  return items;
}

/** A supervisor's talk log: `- [REVIEW] ...`, `- [REVIEW: SCOPE] ...`, `- [ASK] ...`, `- [REVIEWED] ...`. */
export function fromTalk(text, file) {
  const items = [];
  for (const b of bullets(splitLines(text).map((t, i) => ({ line: i + 1, text: t })))) {
    const body = one(b.text.replace(/^-\s*/, ''));
    if (/^\[ASK\]/i.test(body)) items.push({ group: 'needs', kind: 'ask', text: body, file, line: b.line });
    else if (/^\[REVIEWED\b/i.test(body)) items.push({ group: 'decided', kind: 'supervisor', text: body, file, line: b.line, reviewed: true });
    else if (/^\[REVIEW:\s*SCOPE\]/i.test(body)) items.push({ group: 'decided', kind: 'scope', text: body, file, line: b.line, reviewed: false });
    else if (/^\[REVIEW\]/i.test(body)) items.push({ group: 'decided', kind: 'supervisor', text: body, file, line: b.line, reviewed: false });
  }
  return items;
}

/** Parked queue lines. */
export function fromQueue(text, file) {
  return splitLines(text).flatMap((t, i) => {
    const m = /^\s*-\s*\[!\]\s*(\S+)\s*(?:[—–-]\s*(.*))?$/.exec(t);
    if (!m || /MOVED to lane/i.test(m[2] || '')) return [];
    return [{ group: 'needs', kind: 'parked', spec: m[1], text: `${m[1]} — ${one(m[2] || 'parked')}`, file, line: i + 1 }];
  });
}

/** Tooling: commits and commits tagged [REVIEW: SCOPE] between the base and HEAD. */
export function fromGit(root, { base, since } = {}) {
  const range = base ? `${base}..HEAD` : 'HEAD';
  const args = ['log', '--format=%h%x1f%s%x1f%b%x1e', range];
  if (since) args.splice(1, 0, `--since=${since}`);
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\x1e').map((c) => c.trim()).filter(Boolean).flatMap((c) => {
    const [sha, subject = '', body = ''] = c.split('\x1f');
    const scope = REVIEW_TAG.test(`${subject}\n${body}`) && /SCOPE/i.test(`${subject}\n${body}`);
    const tooling = /\bTooling:/.test(subject);
    if (!scope && !tooling) return [];
    return [{ group: 'decided', kind: scope ? 'scope' : 'tooling', text: `${sha} ${one(subject)}`, file: 'git', line: null, sha, reviewed: false }];
  });
}

function mdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return mdFiles(p);
    return e.isFile() && e.name.endsWith('.md') ? [p] : [];
  });
}

function defaultBase(root, config) {
  const b = config.project.baseBranch || 'main';
  for (const ref of [`origin/${b}`, b]) {
    const mb = spawnSync('git', ['merge-base', 'HEAD', ref], { cwd: root, encoding: 'utf8' });
    if (mb.status === 0 && mb.stdout.trim()) {
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
      return mb.stdout.trim() === head ? null : mb.stdout.trim();
    }
  }
  return null;
}

/** Gather every item. `opts`: { spec, since, all, talk, queue, base }. */
export function collect(ctx, opts = {}) {
  const { root } = ctx;
  const items = [];
  for (const f of mdFiles(ctx.specsDir)) items.push(...fromSpec(readText(f), rel(root, f)).map((i) => ({ spec: rel(root, f), ...i })));
  const plans = fs.existsSync(ctx.stateDir)
    ? fs.readdirSync(ctx.stateDir).filter((n) => /^IMPLEMENTATION_PLAN(\..+)?\.md$/.test(n)).map((n) => path.join(ctx.stateDir, n))
    : [];
  for (const f of plans) items.push(...fromPlan(readText(f), rel(root, f)));
  const temp = path.join(root, '.claude-temp');
  const talks = opts.talk ? [ctx.resolve(opts.talk)]
    : fs.existsSync(temp) ? fs.readdirSync(temp).map((d) => path.join(temp, d, 'TALK.md')).filter((f) => fs.existsSync(f)) : [];
  for (const f of talks) if (fs.existsSync(f)) items.push(...fromTalk(readText(f), rel(root, f)));
  const queue = opts.queue ? ctx.resolve(opts.queue) : path.join(temp, 'ralph-queue', 'QUEUE.md');
  if (fs.existsSync(queue)) items.push(...fromQueue(readText(queue), rel(root, queue)));
  const base = opts.base ?? defaultBase(root, ctx.config);
  items.push(...fromGit(root, { base, since: opts.since }));

  let out = items;
  if (!opts.all) out = out.filter((i) => !i.reviewed);
  if (opts.spec) {
    const name = specName(opts.spec);
    out = out.filter((i) => (i.spec && specName(i.spec) === name) || i.text.includes(name));
  }
  return out;
}

const GROUPS = [
  ['needs', 'NEEDS YOU', 'answer it, then set the queue line back to [ ] or tick the question'],
  ['decided', 'DECIDED FOR YOU', 'read each; mark it [REVIEWED] when you accept it, or change it (docs/DECISIONS.md)'],
  ['deferred', 'DEFERRED', 'findings outside the spec, recorded instead of built: file a spec or accept the risk'],
];

export function render(items, { width = 160 } = {}) {
  const lines = [];
  for (const [key, title, hint] of GROUPS) {
    const group = items.filter((i) => i.group === key);
    lines.push(`${title} (${group.length})${group.length ? `  - ${hint}` : ''}`);
    for (const i of group) {
      const where = i.file === 'git' ? 'commit' : `${i.file}${i.line ? `:${i.line}` : ''}`;
      const mark = i.reviewed ? ' (reviewed)' : '';
      const head = `  ${i.kind.padEnd(13)} `;
      const room = Math.max(40, width - head.length - where.length - 3);
      const text = i.text.length > room ? `${i.text.slice(0, room - 1)}…` : i.text;
      lines.push(`${head}${text}${mark}  ${where}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  let args;
  const usage = 'ralph-decisions.mjs [--spec NAME] [--since DATE] [--all] [--json] [--talk FILE] [--queue FILE] [--base REF]';
  try { args = parseArgs(process.argv.slice(2), { flags: ['all', 'json'], opts: ['spec', 'since', 'talk', 'queue', 'base'] }); } catch (e) { usageExit(e.message, usage); }
  const ctx = getContext();
  const items = collect(ctx, args);
  if (args.json) {
    const by = (g) => items.filter((i) => i.group === g);
    console.log(JSON.stringify({ needsYou: by('needs'), decided: by('decided'), deferred: by('deferred') }, null, 2));
    return;
  }
  console.log(render(items, { width: process.stdout.columns || 160 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

// The Kairos tracker: the driver, not the agent, tells Kairos what the loop is doing, and asks it before each step
// whether the loop may go on. So a stop, a pause or a cap holds whatever the agent does, and nothing depends on a prompt.
//
//   KAIROS_URL (or tracker.kairos.url)   where Kairos's runner endpoints are
//   KAIROS_RUN_TOKEN                     a run key: for one item, made by a person on its Build tab
//
// When Kairos cannot be reached: a plan can still be written, but a build or review does not start. A run going carries on
// with the last answer, under the local caps and kill switch. If nobody is watching it (RALPH_KAIROS_ATTENDED is not 1) it
// stops after RALPH_KAIROS_OUTAGE_MIN minutes (30), since a stop placed in Kairos cannot be seen. Reporting never blocks
// the work: what could not be sent is kept in a file, sent in order when Kairos answers, and each report is safe to send
// twice.
//
// The plan: the file on disk stays the loop's working copy, and Kairos holds every version (planForKairos, withTicks).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { splitTaskId } from './plan-parse.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WORTH_RETRYING = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
export const DEFAULT_OUTAGE_MIN = 30;

/** Where Kairos is and the key to use, from the environment and config. */
export function kairosSettings(cfg, env = process.env) {
  const url = String(env.KAIROS_URL || cfg?.tracker?.kairos?.url || '').replace(/\/+$/, '');
  return { url, token: env.KAIROS_RUN_TOKEN || '' };
}

/** What is missing before a run can use Kairos, or null. */
export function kairosProblem({ url, token }) {
  if (!url) return 'set KAIROS_URL (or tracker.kairos.url in ralph.config.json) to where Kairos is';
  if (!/^https?:\/\//.test(url)) return `KAIROS_URL "${url}" is not an address`;
  if (!token) return "KAIROS_RUN_TOKEN is not set: the item's owner makes a key on its Build tab in Kairos";
  return null;
}

/** Reports not yet sent, kept in a file so they outlive the run, one file per item. */
export function fileOutbox(dir, item) {
  const file = path.join(dir, `kairos-outbox.${String(item).replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
  return {
    load: () => {
      try {
        return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    },
    save: (queue) => {
      if (queue.length) fs.writeFileSync(file, `${queue.map((e) => JSON.stringify(e)).join('\n')}\n`);
      else fs.rmSync(file, { force: true });
    },
  };
}

/** A client for one item. `fetchImpl` and `wait` are for tests. */
export function createKairos({ url, token, item, fetchImpl = globalThis.fetch, wait = sleep, retryMs = 1000, timeoutMs = 45000, onLost = () => {}, outbox = null }) {
  const call = async (method, path, body, attempts) => {
    let last = { ok: false, status: 0, retry: true, message: 'Kairos could not be reached' };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let delay = 2 ** attempt * retryMs;
      try {
        const res = await fetchImpl(`${url}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return { ok: true, status: res.status, data };
        last = { ok: false, status: res.status, retry: WORTH_RETRYING.has(res.status), message: data.message || `Kairos answered ${res.status}` };
        if (!last.retry) return last;
        const after = Number(res.headers.get('retry-after'));
        if (after > 0) delay = Math.min(after, 30) * retryMs;
      } catch (e) {
        last = { ok: false, status: 0, retry: true, message: `Kairos could not be reached: ${e?.message || e}` };
      }
      if (attempt < attempts) await wait(delay);
    }
    return last;
  };

  const queue = outbox ? outbox.load() : [];
  /** Sends everything waiting, in order, stopping at the first that is worth trying again later. */
  const flush = async () => {
    let answer = null;
    while (queue.length) {
      const r = await call('POST', '/run/events', queue[0], 3);
      if (!r.ok && r.retry) return { sent: answer, failed: r };
      queue.shift();
      outbox?.save(queue);
      if (r.ok) answer = r.data;
      else onLost(queue, r);
    }
    return { sent: answer, failed: null };
  };

  return {
    controls: (mode) => call('GET', `/run/controls?item=${encodeURIComponent(item)}&mode=${encodeURIComponent(mode)}`, null, 5),
    /** The latest version of the plan, and what is known to be done. */
    plan: () => call('GET', '/run/plan', null, 5),
    /** Reports one event, with any still waiting. Never throws. */
    report: async (event) => {
      queue.push(event);
      outbox?.save(queue);
      return flush();
    },
    flush,
    pending: () => queue.length,
  };
}

const lower = (...values) => {
  const set = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return set.length ? Math.min(...set) : null;
};

/** The caps in force: the lower of this repository's and Kairos's. Kairos can only ever lower them. An iteration may
 *  also spend no more than the item has left. */
export function capsWithKairos(budget, caps) {
  if (!caps) return budget;
  return {
    iterationUsd: lower(budget.iterationUsd, caps.iterationUsd, caps.remainingUsd),
    runUsd: lower(budget.runUsd, caps.runUsd),
    dayUsd: budget.dayUsd,
  };
}

/** Why the run stops, from what Kairos said. */
export const stopReasonFor = (code) => (code === 'over-cap' ? 'budget_item' : 'kairos_stop');

/** The plan's open questions for a person, for the one answering to read. */
export function productQuestions(planText) {
  const out = [];
  let inside = false;
  for (const line of String(planText || '').split(/\r?\n/)) {
    if (/^##\s/.test(line)) inside = /^##\s+Open Questions/i.test(line);
    else if (inside && /^\s*-\s*\[ \]/.test(line) && !/\[tooling\]/.test(line)) out.push(line.trim().replace(/^-\s*\[ \]\s*/, '- '));
  }
  return out;
}

const SHA_AT_END = /\s*\(([0-9a-f]{7,40})\)\s*$/;
const MODEL_TAG = /\s*\[(?:haiku|sonnet|mechanical)\]/gi;
const NEXT_MARK = /\s*(?:←|<-)\s*NEXT\b/;
const TEST_ROW = /^`?\[(?:unit|integration|e2e|visual-only)\]/;

/** A plan line's words, without its checkbox, emphasis, marker, model tag or commit, so a tick can be matched to its line. */
const lineWords = (text) => splitTaskId(String(text).trimStart()).words.replace(NEXT_MARK, '').replace(MODEL_TAG, '').replace(SHA_AT_END, '').replace(/\*\*/g, '').replace(SHA_AT_END, '').trim();
const phaseId = (title) => {
  const n = /^Phase\s+(\d+[a-z]?)\b/i.exec(title);
  if (n) return `phase-${n[1].toLowerCase()}`;
  if (/exit gate/i.test(title)) return 'exit-gate';
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'phase';
};

/** Whether this is a plan someone wrote, rather than the placeholder the driver starts with. */
export const planIsWritten = (planText) => Boolean(String(planText || '').trim()) && !/_The planning iteration writes this section\._/.test(planText);

const shortHash = (text) => createHash('sha1').update(String(text)).digest('hex').slice(0, 8);
/* Kairos refuses a whole plan past these, so the plan it is sent stays within them. */
const MAX_LISTED = 200;
const MAX_PHASES = 200;
const MAX_TASKS = 100;
const CANDIDATE = /^`?\[product\]`?\s*CANDIDATE-SPEC:\s*(.+)$/i;
const SCOPE_LINE = /^- (S\d+)\s+(included|filed|blocking)(?:\s+([a-z-]+))?\s+-\s+(.+)$/i;
const SCOPE_FIELDS = /\s*\b(Blocks|Evidence|Commits|Route|Area):\s*/;

/** The paths a plan's `Files:` line names, without the symbols beside them. */
const filesIn = (line) => line.split(/,(?![^(]*\))/).map((f) => f.trim().replace(/`/g, '').split(/\s/)[0]).filter(Boolean);

/** One row of the plan's `## Scope changes`, as Kairos takes it. */
function scopeRow(line) {
  const m = SCOPE_LINE.exec(line);
  if (!m) return null;
  const [what, ...rest] = m[4].split(SCOPE_FIELDS);
  const fields = {};
  for (let i = 0; i < rest.length; i += 2) fields[rest[i]] = rest[i + 1].trim().replace(/\.$/, '');
  return {
    id: m[1],
    kind: m[2].toLowerCase(),
    what: what.trim().replace(/\.$/, '').slice(0, 2000),
    ...(m[3] ? { itemKind: m[3].toLowerCase() } : {}),
    ...(fields.Blocks ? { blocks: fields.Blocks.slice(0, 500) } : {}),
    ...(fields.Evidence ? { evidence: fields.Evidence.slice(0, 4000) } : {}),
    ...(fields.Commits ? { commits: fields.Commits.split(/[\s,]+/).filter(Boolean).slice(0, 50) } : {}),
    ...(fields.Route ? { route: fields.Route } : {}),
    ...(fields.Area ? { riskArea: fields.Area.slice(0, 120) } : {}),
  };
}

/** The plan in words any tracker can hold: its phases and tasks, what the build decided, what is open for a person, and what
 *  it found outside the spec. A deferred finding in the older form counts as one of those, not as a question. */
export function planForKairos(planText) {
  const phases = [];
  const decisions = [];
  const scope = [];
  let section = '';
  let phase = null;
  for (const raw of String(planText || '').split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(raw);
    if (heading) {
      section = /phases/i.test(heading[1]) ? 'phases' : /^decisions/i.test(heading[1]) ? 'decisions' : /^scope changes/i.test(heading[1]) ? 'scope' : '';
      phase = null;
      continue;
    }
    if (section === 'scope') {
      const row = scopeRow(raw);
      if (row) scope.push(row);
    }
    if (section === 'decisions') {
      const d = /^\s*-\s+(.+)$/.exec(raw);
      if (d) decisions.push(d[1].trim().slice(0, 1000));
    }
    if (section !== 'phases') continue;
    const p = /^- \[(.)\] (.+)$/.exec(raw);
    if (p) {
      const title = lineWords(p[2]).slice(0, 500);
      /* A line with no words is not a phase Kairos can hold, nor are the tasks under it. */
      if (!title) {
        phase = null;
        continue;
      }
      phase ={ id: phaseId(title), title, done: p[1].toLowerCase() === 'x', commit: SHA_AT_END.exec(p[2].replace(NEXT_MARK, ''))?.[1] ?? null, tests: [], files: [], tasks: [] };
      phases.push(phase);
      continue;
    }
    if (!phase) continue;
    const t = /^\s+- \[(.)\] (.+)$/.exec(raw);
    const tests = /^\s+Tests:\s*(.+)$/i.exec(raw);
    const files = /^\s+Files:\s*(.+)$/i.exec(raw);
    if (t && TEST_ROW.test(t[2].trim())) phase.tests.push(t[2].trim().slice(0, 1000));
    else if (t && lineWords(t[2])) phase.tasks.push({ ...(splitTaskId(t[2].trimStart()).id ? { id: splitTaskId(t[2].trimStart()).id } : {}), text: lineWords(t[2]).slice(0, 1000), done: t[1].toLowerCase() === 'x', commit: SHA_AT_END.exec(t[2])?.[1] ?? null });
    else if (tests) phase.tests.push(tests[1].trim().slice(0, 1000));
    else if (files) phase.files.push(...filesIn(files[1]));
  }
  const open = productQuestions(planText).map((q) => q.replace(/^- /, ''));
  for (const q of open) {
    const c = CANDIDATE.exec(q);
    if (c) scope.push({ id: `C-${shortHash(c[1])}`, kind: 'filed', what: c[1].trim().slice(0, 2000), itemKind: 'follow-up' });
  }
  /* A phase may be named twice by accident; Kairos needs each once. */
  const seen = new Set();
  return {
    phases: phases.filter((p) => !seen.has(p.id) && seen.add(p.id)).slice(0, MAX_PHASES).map((p) => ({ ...p, tests: p.tests.slice(0, MAX_LISTED), files: p.files.slice(0, MAX_LISTED), tasks: p.tasks.slice(0, MAX_TASKS) })),
    decisions: decisions.slice(0, 50),
    questions: open.filter((q) => !CANDIDATE.test(q)).map((q) => q.slice(0, 1000)).slice(0, 50),
    scope: scope.slice(0, 100),
  };
}

/** What the commits say about scope: each `S<n>` a message names, and any change marked `[REVIEW: SCOPE]` that names none. */
export function scopeFromCommits(commits) {
  const named = new Map();
  const unnamed = [];
  for (const { sha, message } of commits) {
    const ids = [...new Set(String(message).match(/\bS\d+\b/g) ?? [])];
    for (const id of ids) named.set(id, [...(named.get(id) ?? []), sha]);
    if (/\[REVIEW: SCOPE\]/.test(message) && !ids.length) unnamed.push({ id: `C-${sha.slice(0, 8)}`, kind: 'included', what: String(message).split(/\r?\n/)[0].trim().slice(0, 2000), commits: [sha.slice(0, 12)] });
  }
  return { named, unnamed };
}

/** Whether a paths belongs to the work, rather than the loop's own records. */
export const isWorkFile = (file) => !/^(\.ralph|\.claude-temp|records|specs)\//.test(file);

/** The plan Kairos holds, with what this copy and Kairos both know to be done ticked. So a person's words never lose a tick. */
export function withTicks(markdown, localText, phases = []) {
  const doneIds = new Set();
  const doneWords = new Set();
  const doneUnnumbered = new Set();
  const note = (text, id = null) => {
    const own = id ?? splitTaskId(String(text).trimStart()).id;
    const words = lineWords(text);
    doneWords.add(words);
    if (own) doneIds.add(own);
    else doneUnnumbered.add(words);
  };
  for (const line of String(localText || '').split(/\r?\n/)) {
    const m = /^\s*- \[[xX]\] (.+)$/.exec(line);
    if (m) note(m[1]);
  }
  for (const p of phases) {
    if (p.done) note(p.title);
    for (const t of p.tasks ?? []) if (t.done) note(t.text, t.id ?? null);
  }
  return String(markdown).split('\n').map((line) => {
    const m = /^(\s*- \[) (\] )(.+?)(\r?)$/.exec(line);
    if (!m) return line;
    const id = splitTaskId(m[3].trimStart()).id;
    const words = lineWords(m[3]);
    /* A line with an id is ticked by that id, or by a done task that has none; it is never ticked by another id's words. */
    const ticked = id ? doneIds.has(id) || doneUnnumbered.has(words) : doneWords.has(words);
    return ticked ? `${m[1]}x${m[2]}${m[3]}${m[4]}` : line;
  }).join('\n');
}

/** What a person answered, for the prompt. */
export function answersBlock(answers) {
  if (!answers?.length) return '';
  return answers.map((a) => `- **${a.question}** ${a.choice ?? ''}${a.note ? ` (${a.note})` : ''}`.trim()).join('\n');
}

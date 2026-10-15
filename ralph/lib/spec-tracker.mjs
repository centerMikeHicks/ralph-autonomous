// Spec resolution, the tracker binding in a spec's front matter, and plan bootstrap/archive.
import fs from 'node:fs';
import path from 'node:path';
import { readText, splitLines, toPosix, writeText } from './fsutil.mjs';
import { planActiveSpec } from './plan-parse.mjs';

export const ISSUE_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/;

export function specBaseName(specPath) {
  return specPath ? path.basename(specPath).replace(/\.md$/i, '') : 'no-spec';
}

/** Value of `key:` in the spec's YAML front matter, or ''. */
export function frontMatterValue(specText, key) {
  const lines = splitLines(specText || '');
  if (lines[0] !== '---') return '';
  for (let i = 1; i < lines.length && lines[i] !== '---'; i += 1) {
    const m = new RegExp(`^${key}:\\s*["']?([^"'\\s#]*)`).exec(lines[i]);
    if (m) return m[1];
  }
  return '';
}

/** Return spec text with `key: value` set in the front matter (created when absent). */
export function setFrontMatterValue(specText, key, value) {
  const eol = /\r\n/.test(specText) ? '\r\n' : '\n';
  const lines = splitLines(specText || '');
  if (lines[0] !== '---') return `---${eol}${key}: ${value}${eol}---${eol}${eol}${specText}`;
  let end = lines.indexOf('---', 1);
  if (end < 0) end = lines.length;
  for (let i = 1; i < end; i += 1) {
    if (new RegExp(`^${key}:`).test(lines[i])) {
      lines[i] = `${key}: ${value}`;
      return lines.join(eol);
    }
  }
  lines.splice(end, 0, `${key}: ${value}`);
  return lines.join(eol);
}

/**
 * Work out the active spec. `specArg` wins and is recorded in ACTIVE_SPEC; otherwise the
 * recorded one is used. Returns {spec, source, missing}; spec is '' when none is known.
 */
export function resolveSpec({ root, stateDir, specArg }) {
  const activeFile = path.join(stateDir, 'ACTIVE_SPEC');
  if (specArg) {
    const rel = toPosix(specArg);
    if (!fs.existsSync(path.resolve(root, rel))) return { spec: rel, source: 'arg', missing: true };
    writeText(activeFile, rel);
    return { spec: rel, source: 'arg', missing: false };
  }
  const recorded = readText(activeFile).trim().split(/\r?\n/)[0]?.trim() || '';
  if (!recorded) return { spec: '', source: 'none', missing: false };
  const rel = toPosix(recorded);
  return { spec: rel, source: 'active', missing: !fs.existsSync(path.resolve(root, rel)) };
}

/**
 * Tracker binding for the run. Only provider "jira" has one.
 * @returns {{enabled:boolean, issue:string, project:string, error?:string, written?:boolean}}
 */
export function resolveTracker({ cfg, root, spec, issueArg, skip }) {
  const t = cfg.tracker || {};
  if (t.provider !== 'jira' || skip) return { enabled: false, issue: '', project: '' };
  const project = (t.jira && t.jira.project) || '';
  if (!spec) return { enabled: true, issue: issueArg || '', project };
  const file = path.resolve(root, spec);
  const text = readText(file);
  if (issueArg) {
    if (!ISSUE_RE.test(issueArg)) return { enabled: true, issue: '', project, error: `--issue '${issueArg}' is not a ticket key like ${project || 'PROJ'}-123` };
    if (text && frontMatterValue(text, 'tracker_issue') !== issueArg) {
      writeText(file, setFrontMatterValue(text, 'tracker_issue', issueArg));
    }
    return { enabled: true, issue: issueArg, project: frontMatterValue(text, 'tracker_project') || project, written: true };
  }
  const issue = frontMatterValue(text, 'tracker_issue');
  if (!issue) return { enabled: true, issue: '', project, error: `spec '${spec}' has no tracker_issue binding (add it to the front matter, pass --issue KEY, or --skip-tracker)` };
  return { enabled: true, issue, project: frontMatterValue(text, 'tracker_project') || project };
}

/** Parse `claude mcp list` style output: true when a Connected atlassian row exists. */
export function atlassianConnected(listing) {
  return splitLines(listing).some((l) => /^\s*(\S*atlassian\S*)\s*:/i.test(l) && /connected/i.test(l) && !/not connected|disconnected/i.test(l));
}

export function initialPlan(spec) {
  return [
    '# Implementation Plan',
    '',
    '## Status: Not yet planned',
    '',
    '## Active Spec',
    `\`${spec || 'None'}\``,
    '',
    '## Phases',
    '',
    '_The planning iteration writes this section._',
    '',
  ].join('\n');
}

/**
 * Plans are history. Before plan mode overwrites a plan that belongs to a different spec,
 * keep it as IMPLEMENTATION_PLAN.<spec>.md. Returns the archive path or ''.
 */
export function archiveOutgoingPlan({ stateDir, newSpec }) {
  const planFile = path.join(stateDir, 'IMPLEMENTATION_PLAN.md');
  const text = readText(planFile);
  if (!text.trim()) return '';
  const old = planActiveSpec(text);
  if (!old || old === 'None' || toPosix(old) === toPosix(newSpec)) return '';
  if (/_The planning iteration writes this section\._/.test(text)) return '';
  const dest = path.join(stateDir, `IMPLEMENTATION_PLAN.${specBaseName(old)}.md`);
  if (fs.existsSync(dest)) return '';
  writeText(dest, text);
  return dest;
}

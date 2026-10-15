#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for the Agent tool: every subagent launch names
 * its model, so work runs on the smallest model that can do it rather than
 * silently inheriting the parent session's (usually the largest) model.
 *
 * Wired in `.claude/settings.json` (hooks.PreToolUse, matcher `Agent|Task`).
 * Reads the hook payload as JSON on stdin; exit 0 allows the call, exit 2
 * blocks it and hands the stderr message (the model rubric) back to Claude.
 *
 * A call passes without a `model` when the model is already decided elsewhere:
 *   - `subagent_type: "fork"`: a fork always runs on the parent's model;
 *   - a project agent (`.claude/agents/<name>.md`) whose front matter fixes a
 *     model other than `inherit`.
 * Everything else (general-purpose, Explore, Plan, plugin agents) must pass
 * `model` explicitly.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BOM = new RegExp('^' + String.fromCharCode(0xfeff));

const RUBRIC = [
  'Agent call blocked: pass an explicit `model` (haiku | sonnet | opus). Start small and escalate on purpose:',
  '  haiku  - find/list files, simple greps, run a command and report pass/fail, docs lookups.',
  '  sonnet - read and reason over code: research, diagnosing test failures, building patches, applying a known change.',
  '  opus   - only when you can say why: new design with open trade-offs, root-causing a subtle bug, security review.',
  'Or use a project agent whose .claude/agents/<name>.md front matter pins a model. See ralph/AGENTS.md.',
].join('\n');

/** The `model:` value in an agent file's YAML front matter, or null when absent. */
function frontmatterModel(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown.replace(BOM, ''));
  if (!match) return null;
  const line = match[1].split(/\r?\n/).find((l) => /^model\s*:/.test(l));
  if (!line) return null;
  return line.replace(/^model\s*:/, '').trim().replace(/^['"]|['"]$/g, '') || null;
}

/** Whether a project agent of this name fixes its own model. */
function agentFixesModel(projectDir, subagentType) {
  if (!subagentType || !/^[\w.-]+$/.test(subagentType)) return false;
  const file = path.join(projectDir, '.claude', 'agents', `${subagentType}.md`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const model = frontmatterModel(text);
  return Boolean(model) && model !== 'inherit';
}

/** Decide one hook payload: `{ allow: true }` or `{ allow: false, message }`. */
function decide(payload, projectDir) {
  const input = (payload && payload.tool_input) || {};
  if (typeof input.model === 'string' && input.model.trim()) return { allow: true };
  if (input.subagent_type === 'fork') return { allow: true };
  if (agentFixesModel(projectDir, input.subagent_type)) return { allow: true };
  return { allow: false, message: RUBRIC };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(raw.replace(BOM, ''));
    } catch {
      // Not a payload this hook understands; never block on our own parse failure.
      process.exit(0);
    }
    const projectDir = process.env.CLAUDE_PROJECT_DIR || (payload && payload.cwd) || process.cwd();
    const verdict = decide(payload, projectDir);
    if (verdict.allow) process.exit(0);
    process.stderr.write(`${verdict.message}\n`);
    process.exit(2);
  });
}

if (require.main === module) main();

module.exports = { decide, frontmatterModel, agentFixesModel, RUBRIC };

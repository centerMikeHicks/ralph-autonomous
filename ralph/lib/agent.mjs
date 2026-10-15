// Agent CLI invocation: resolves the command (config or RALPH_AGENT_CMD), builds argv, spawns it
// with the prompt on stdin and streams stdout lines to a callback.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

/** Split a command string on whitespace, honouring single and double quotes. */
export function splitCommand(text) {
  const out = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const ch of String(text)) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** @returns {{command:string, baseArgs:string[], isClaude:boolean, override:boolean}} */
export function resolveAgent(cfg, env = process.env) {
  const agent = cfg.agent || {};
  const baseArgs = Array.isArray(agent.args) ? [...agent.args] : [];
  if (env.RALPH_AGENT_CMD) {
    const [command, ...pre] = splitCommand(env.RALPH_AGENT_CMD);
    return { command, baseArgs: [...pre, ...baseArgs], isClaude: false, override: true };
  }
  const command = agent.command || 'claude';
  const isClaude = path.basename(command).replace(/\.(exe|cmd|bat)$/i, '') === 'claude';
  return { command, baseArgs, isClaude, override: false };
}

/** argv for one iteration: configured args + model flag + effort flag (+ claude-only extras). */
export function buildAgentArgs({ agent, cfg, model, effort, root }) {
  const a = cfg.agent || {};
  const args = [...agent.baseArgs];
  if (model && a.modelFlag) args.push(a.modelFlag, model);
  if (effort && a.effortFlag) args.push(a.effortFlag, effort);
  if (agent.isClaude) {
    args.push('--max-turns', String(a.maxTurns || 250));
    // Tools that only work interactively end a headless session instead of waiting.
    args.push('--disallowedTools', (a.disallowedTools || ['ScheduleWakeup', 'Monitor']).join(','));
    const mcp = path.join(root, '.mcp.json');
    if (fs.existsSync(mcp)) args.push('--mcp-config', mcp);
  }
  return args;
}

/** Environment for the agent process. Claude-only toggles are set only for the claude CLI. */
export function buildAgentEnv(agent, env = process.env) {
  const out = { ...env };
  if (agent.isClaude) {
    // A background task belongs to the iteration's process and dies with it; run foreground.
    out.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ??= '1';
    out.BASH_DEFAULT_TIMEOUT_MS ??= '600000';
    out.BASH_MAX_TIMEOUT_MS ??= '600000';
    out.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ??= '0';
  }
  return out;
}

/** Find an executable on PATH (with PATHEXT on Windows). Returns the input when not found. */
export function resolveExecutable(command, env = process.env, platform = process.platform) {
  if (/[\\/]/.test(command) || path.isAbsolute(command)) return command;
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return command;
}

function quoteForShell(arg) {
  return /^[\w./:=@,\\-]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '\\"')}"`;
}

/**
 * Spawn the agent. A .cmd/.bat shim (npm-installed CLIs on Windows) cannot be spawned without
 * a shell; its argv is the kit's own flags and model names, never the prompt (stdin).
 * @returns {{child: import('node:child_process').ChildProcess, done: Promise<{exitCode:number, error?:string}>}}
 */
export function spawnAgent({ root, agent, args, env, prompt, onLine, onStderr }) {
  const exe = resolveExecutable(agent.command, env);
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
  const child = viaShell
    ? spawn([quoteForShell(exe), ...args.map(quoteForShell)].join(' '), { cwd: root, env, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(exe, args, { cwd: root, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => onLine && onLine(line));
  if (onStderr) child.stderr.on('data', (d) => onStderr(String(d)));
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const done = new Promise((resolve) => {
    let error;
    child.on('error', (e) => {
      error = e.code === 'ENOENT' ? `agent command not found: ${agent.command}` : e.message;
    });
    child.on('close', (code) => resolve({ exitCode: code === null ? 1 : code, error }));
  });
  return { child, done };
}

/** One-line console rendering of a stream-json event; null to stay quiet. */
export function renderEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    const bits = [];
    for (const b of obj.message.content) {
      if (b.type === 'text' && b.text && b.text.trim()) bits.push(b.text.trim().split(/\r?\n/)[0].slice(0, 160));
      if (b.type === 'tool_use') bits.push(`-> ${b.name}`);
    }
    return bits.length ? bits.join('  ') : null;
  }
  if (obj.type === 'result') return `result: ${obj.is_error ? 'error' : 'ok'}${obj.num_turns ? `, ${obj.num_turns} turns` : ''}`;
  return null;
}

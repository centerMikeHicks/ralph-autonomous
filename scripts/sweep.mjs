#!/usr/bin/env node
/**
 * The process owner for long-running tooling: the only thing in the kit that starts a
 * detached job or kills a process. The logic is in lib/sweep.cjs (unit-tested); this is
 * the CLI. Defaults come from `ralph.config.json` (`sweep.*`); flags override.
 *
 *   node scripts/sweep.mjs run --dir <dir> [--name X] [--env K=V]... [--timeout-min N]
 *                              [--stall-min N] [--service] [--log <file>] -- <command> [args...]
 *       Start `<command>` detached under a watcher, recorded in <dir>/sweep.json, its
 *       output in <dir>/run.log ending in `exit=<verdict>`. Returns as soon as the
 *       record exists. `npm`, `npx` and `node` need no shell on either OS; anything
 *       else must be a real executable on PATH.
 *       --timeout-min  hard ceiling (default sweep.timeoutMin, 180; 0 = none)
 *       --stall-min    kill when run.log and heartbeat.json both stop advancing for
 *                      this long (default sweep.stallMin, 20; 0 = none)
 *       --service      a server: no ceilings, not waited on, and bound to its owner,
 *                      the outermost Ralph loop or agent CLI process that started it
 *                      (names in sweep.ownerProcessNames); the watcher stops it once
 *                      that owner exits
 *       --owner <pid>  services: bind to this process instead of the detected session
 *                      (`none` = no owner)
 *       --detached     services: no owner, outlives the session (idle ceiling applies)
 *       --idle-min N   services: stop after N min with no output or heartbeat
 *                      (default: none when owned, 240 when not; 0 = never)
 *       --max-mem-mb N stop the sweep's whole tree once its private memory (RSS on
 *                      POSIX) exceeds N MB on two consecutive checks (exit=memory)
 *       --cwd <dir>    working directory for the command (default: the current one)
 *
 *   node scripts/sweep.mjs wait [--root <dir>] [--max-min N] [--summary <file>]
 *       Block until no check is running under <root>/.claude-temp. Adopts a sweep
 *       whose watcher died (its own ceilings still apply) and kills everything left
 *       at --max-min (default 240). --summary writes a JSON array of what was waited
 *       on: { dir, name, seconds, verdict }.
 *
 *   node scripts/sweep.mjs kill (--dir <dir> | --pid <pid> [--started <iso>]) [--reason "..."]
 *       End a sweep (its whole tree, then orphaned headless browsers), stamp
 *       `exit=killed`. With --pid, kill that tree instead; --started refuses a pid
 *       another process has since reused.
 *
 *   node scripts/sweep.mjs reap [--stale] [--root <dir>]
 *       Kill headless browsers whose parent is gone, whoever left them. With --stale,
 *       also stop every service under <root>/.claude-temp whose owner has exited and
 *       close records whose processes are all gone (run at session and loop start).
 *
 *   node scripts/sweep.mjs status [--root <dir>] [--json]
 *       List sweeps under <root>/.claude-temp with age, liveness and last progress.
 *
 * <root> is the project root: the nearest directory holding ralph.config.json (else
 * the kit's parent, else the nearest .git directory, else the current directory);
 * RALPH_ROOT overrides.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveRoot } from './lib/config.mjs';

const require = createRequire(import.meta.url);
const sweep = require('./lib/sweep.cjs');

const here = fileURLToPath(import.meta.url);

const BOOLEAN_FLAGS = new Set(['service', 'json', 'detached', 'stale']);

export function parseArgs(argv) {
  const opts = { _: [], env: {}, rest: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { opts.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      let value = eq === -1 ? undefined : a.slice(eq + 1);
      if (value === undefined && BOOLEAN_FLAGS.has(key)) { opts[key] = true; i += 1; continue; }
      if (value === undefined) { value = argv[i + 1]; i += 1; }
      if (key === 'env') {
        const [k, ...v] = String(value).split('=');
        if (!k || v.length === 0) throw new Error(`--env expects NAME=value, got ${JSON.stringify(value)}`);
        opts.env[k] = v.join('=');
      } else {
        opts[key] = value;
      }
      i += 1;
      continue;
    }
    opts._.push(a);
    i += 1;
  }
  return opts;
}

export function minutes(value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`expected a non-negative number of minutes, got ${JSON.stringify(value)}`);
  return n;
}

/** The `owner` option for sweep.run from the CLI flags. */
export function ownerOption(opts) {
  if (opts.detached) return null;
  if (opts.owner === undefined || opts.owner === 'auto') return 'auto';
  if (opts.owner === 'none') return null;
  const pid = Number(opts.owner);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`--owner expects a pid, "auto" or "none", got ${JSON.stringify(opts.owner)}`);
  return pid;
}

const say = (line) => console.log(`[sweep] ${line}`);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const root = path.resolve(opts.root ?? resolveRoot(import.meta.url));
  switch (cmd) {
    case 'run': {
      if (!opts.dir) throw new Error('run: --dir <dir> is required');
      if (opts.rest.length === 0) throw new Error('run: the command goes after `--`');
      const config = loadConfig(root);
      const [command, ...args] = opts.rest;
      const record = await sweep.run({
        dir: path.resolve(opts.dir),
        command,
        args,
        name: opts.name,
        env: opts.env,
        cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
        timeoutMin: minutes(opts.timeoutMin, config.sweep.timeoutMin),
        stallMin: minutes(opts.stallMin, config.sweep.stallMin),
        service: Boolean(opts.service),
        owner: ownerOption(opts),
        ownerProcessNames: config.sweep.ownerProcessNames,
        idleMin: minutes(opts.idleMin, undefined),
        maxMemMb: opts.maxMemMb === undefined ? undefined : minutes(opts.maxMemMb, undefined),
        log: opts.log,
        watcherEntry: here,
      });
      say(`started '${record.name}' (pid ${record.pid}, watcher ${record.watcherPid}${record.service ? `, owner ${record.owner ? `${record.owner.kind}:${record.owner.pid}` : `none, idle ceiling ${record.idleMin} min`}` : ''}) — log ${record.log}`);
      if (opts.json) console.log(JSON.stringify(record));
      return 0;
    }
    case '_watch': {
      // Internal: the detached watcher `run` starts. argv: the spec file.
      return sweep.watch(opts._[0]);
    }
    case 'wait': {
      const waited = await sweep.wait({ root, maxMin: minutes(opts.maxMin, 240), onProgress: say });
      if (waited.length) say(`sweep(s) finished: ${waited.map((w) => `${w.name}=${w.verdict ?? '?'} (${w.seconds}s)`).join(', ')}`);
      if (opts.summary) {
        fs.mkdirSync(path.dirname(path.resolve(opts.summary)), { recursive: true });
        fs.writeFileSync(path.resolve(opts.summary), JSON.stringify(waited, null, 2));
      }
      return 0;
    }
    case 'kill': {
      if (!opts.dir && !opts.pid) throw new Error('kill: --dir <dir> or --pid <pid> is required');
      const r = await sweep.kill({
        dir: opts.dir ? path.resolve(opts.dir) : null,
        pid: opts.pid ? Number(opts.pid) : null,
        startedAt: opts.started ?? null,
        reason: opts.reason ?? 'killed on request',
      });
      if (r.skipped) say(r.skipped);
      say(`killed ${r.killed.length} process(es)${r.killed.length ? `: ${r.killed.join(', ')}` : ''}; reaped ${r.orphansReaped.length} orphaned browser process(es)${r.note ? ` (${r.note})` : ''}`);
      if (r.survivors?.length) { say(`WARNING: still alive: ${r.survivors.join(', ')}`); return 1; }
      return 0;
    }
    case 'reap': {
      if (opts.stale) {
        const actions = await sweep.reapStale({ root });
        for (const a of actions) say(`${a.action === 'stopped' ? 'stopped' : 'closed as lost'} '${a.name}'${a.reason ? ` — ${a.reason}` : ''}`);
        if (!actions.length) say('no stale sweeps');
      }
      const r = await sweep.reapOrphans();
      say(`reaped ${r.killed.length} orphaned headless browser process(es)${r.killed.length ? `: ${r.killed.join(', ')}` : ''}`);
      return 0;
    }
    case 'status': {
      const rows = sweep.status({ root });
      if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      if (!rows.length) { say('no sweeps recorded'); return 0; }
      for (const r of rows) say(`${r.line}\n        ${r.dir}`);
      return 0;
    }
    default:
      console.error('usage: sweep.mjs run|wait|kill|reap|status ... (see the header of scripts/sweep.mjs)');
      return 2;
  }
}

const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
if (process.argv[1] && norm(process.argv[1]) === norm(here)) {
  main().then((code) => process.exit(code), (err) => { console.error(`[sweep] ${err?.message ?? err}`); process.exit(1); });
}

'use strict';
/**
 * The one process owner for long-running tooling. A "sweep" is a check that outlives a
 * model turn (a test suite, a long build, a dev server). This module launches it
 * detached, watches it, records it in `<dir>/sweep.json`, ends it (hard timeout, stall
 * timeout, memory ceiling, owner exit or on request) by killing its WHOLE process tree,
 * and reaps the headless browsers a dead tree leaves behind. Nothing else in the kit
 * starts a detached job or kills a process.
 *
 * Its authority is a file, not a handle: `sweep.json` names the child pid and the
 * watcher pid with their start times, so a kill works from any process on the
 * machine (a loop shell, a later model turn, a human) and a reused pid is never
 * mistaken for the job that wrote the record.
 *
 * Every OS branch lives here, in one function each (listProcesses, signal):
 *   - process listing: Windows reads Win32_Process through powershell.exe (pid,
 *     parent, creation time, memory, command line); POSIX reads `ps -A -ww -o ...`.
 *   - termination: Node's process.kill (TerminateProcess on Windows, SIGTERM then
 *     SIGKILL on POSIX). No taskkill, no pkill.
 *   - neither a Job Object nor a process group is relied on: a tree is found by
 *     walking parent links in a fresh listing, leaves last, so it is cleaned up
 *     even after the process that started it is gone (Windows does not cascade a
 *     kill; POSIX reparents orphans to init).
 *
 * Files in a sweep directory:
 *   sweep.json      the live record; its absence means "not running"
 *   sweep.done.json the verdict once it ended (exit code, timeout, killed, lost, ...)
 *   run.log         the check's stdout+stderr, ending in an `exit=<verdict>` line
 *   heartbeat.json  progress the check itself reports (heartbeat below), read by
 *                   the stall watchdog and by `status`
 *   sweep.log       the watcher's own diagnostics
 *
 * Service lifetime. A check ends on its own (exit, or its ceilings); a service
 * (`--service`, a dev server or a queue runner) does not, so it is bound to an OWNER:
 * the outermost session that started it, a Ralph loop if one is in the caller's
 * ancestry, else an agent CLI process named in `sweep.ownerProcessNames`. The watcher
 * stops the service once that owner is gone, so a server dies with the session that
 * needed it. A service started outside any session (a human's terminal) has no owner
 * and gets an idle ceiling instead (DEFAULT_UNOWNED_IDLE_MIN of no output). A service
 * that must outlive its session opts out explicitly (`--detached`). `reapStale` stops
 * services whose owner is gone and closes records whose processes are all gone, the
 * backstop for a watcher that was itself killed.
 *
 * scripts/sweep.mjs is the CLI over this module.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RECORD = 'sweep.json';
const DONE = 'sweep.done.json';
const RUN_LOG = 'run.log';
const HEARTBEAT = 'heartbeat.json';
const WATCH_LOG = 'sweep.log';
const RECORD_VERSION = 1;

/** Defaults for a check (not a service): hard ceiling and no-progress ceiling, in minutes. */
const DEFAULT_TIMEOUT_MIN = 180;
const DEFAULT_STALL_MIN = 20;
/** Idle ceiling for a service no session owns: this long with no output or heartbeat ends it. */
const DEFAULT_UNOWNED_IDLE_MIN = 240;
/** How often a service's watcher confirms its owner still runs. */
const OWNER_CHECK_MS = 60_000;
/** How often a sweep with a memory ceiling measures its tree. */
const MEM_CHECK_MS = 60_000;
/** Agent CLI names that count as a session when `sweep.ownerProcessNames` is not given. */
const DEFAULT_OWNER_PROCESS_NAMES = ['claude'];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Processes that own a session: a Ralph loop script (its shell's command line names it)
 * and an agent CLI named in `names` (matched on the executable name without `.exe`, or,
 * for an npm-installed CLI that runs under node, a `node_modules/.../<name>*` path in the
 * command line). The OUTERMOST match in the caller's ancestry wins, so a service started
 * by a model turn inside a loop lives as long as the loop, not the turn.
 */
function sessionRoots(names = DEFAULT_OWNER_PROCESS_NAMES) {
  const roots = [{ kind: 'ralph-loop', test: (p) => /ralph[\\/]loop\.(ps1|sh)\b/i.test(p.commandLine ?? '') }];
  for (const raw of names) {
    const name = String(raw).replace(/\.exe$/i, '');
    if (!name) continue;
    const n = escapeRegExp(name);
    const byName = new RegExp(`^${n}(\\.exe)?$`, 'i');
    const byPackage = new RegExp(`[\\\\/]node_modules[\\\\/](?:@[^\\\\/\\s"]+[\\\\/])?[^\\\\/\\s"]*${n}[^\\\\/\\s"]*[\\\\/]`, 'i');
    roots.push({ kind: name, test: (p) => byName.test(p.name ?? '') || byPackage.test(p.commandLine ?? '') });
  }
  return roots;
}
/** A process start time this far from the recorded one is a different process (pid reuse). */
const START_TOLERANCE_MS = 15_000;
/** SIGTERM → SIGKILL grace on POSIX. */
const TERM_GRACE_MS = 3_000;
/** Headless browser processes a killed test tree leaves behind. Never a user's own browser. */
const BROWSER_NAME = /(^|[\\/])(chrome|chromium|chromium-browser|headless_shell|chrome-headless-shell|msedge)(\.exe)?$/i;
const BROWSER_HEADLESS = /--headless/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const fmtMin = (min) => (min < 10 ? min.toFixed(1) : String(Math.round(min)));
/** Default `onProgress`: a caller that wants no running commentary. */
function noop() { /* the caller wants no progress lines */ }

// ---------------------------------------------------------------------------
// Process listing — the one place the OS differs for "what is running"
// ---------------------------------------------------------------------------

// Fields separated by the unit separator so a command line (which can hold tabs)
// never splits a line; newlines inside a command line are flattened.
const WIN_LIST_SCRIPT = [
  '$u=[string][char]31;',
  'Get-CimInstance Win32_Process | ForEach-Object {',
  "$s=''; if ($_.CreationDate) { $s=$_.CreationDate.ToUniversalTime().ToString('o') };",
  "$c=''; if ($_.CommandLine) { $c=($_.CommandLine -replace '[\\r\\n]',' ') };",
  "$_.ProcessId.ToString()+$u+$_.ParentProcessId.ToString()+$u+$s+$u+$_.WorkingSetSize.ToString()+$u+$_.PrivatePageCount.ToString()+$u+$_.Name+$u+$c",
  '}',
].join(' ');

/** Parse the Windows listing (unit-separated `pid ppid startedAt workingSet privateBytes name commandLine`). */
function parseWindowsListing(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const [pid, ppid, startedAt, ws, priv, name, commandLine = ''] = line.split('\u001f');
    const p = Number(pid);
    if (!Number.isInteger(p)) continue;
    out.push({ pid: p, ppid: Number(ppid), startedAt: startedAt || null, rssBytes: Number(ws) || 0, privateBytes: Number(priv) || 0, name: name ?? '', commandLine, state: '' });
  }
  return out;
}

/** `ps` etime (`[[dd-]hh:]mm:ss`) → seconds, or null when unparsable. */
function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return null;
  const [, d = '0', h = '0', mi, se] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(mi) * 60 + Number(se);
}

/**
 * Parse `ps -A -ww -o pid=,ppid=,stat=,etime=,rss=,args=` output (rss in KiB). `args` is last
 * so an executable path with spaces stays whole; the process name is the
 * basename of its first token, which is all the orphan matcher needs.
 */
function parsePosixListing(text, now = Date.now()) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const elapsed = parseEtime(m[4]);
    const commandLine = m[6] ?? '';
    const first = commandLine.split(/\s+/)[0] ?? '';
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      state: m[3],
      rssBytes: Number(m[5]) * 1024,
      privateBytes: Number(m[5]) * 1024,
      startedAt: elapsed === null ? null : new Date(now - elapsed * 1000).toISOString(),
      name: path.posix.basename(first),
      commandLine,
    });
  }
  return out;
}

/**
 * Every process on the machine: `{ pid, ppid, name, commandLine, startedAt, state }`.
 * `startedAt` is an ISO instant or null when the OS did not say. Throws when the
 * listing itself cannot be produced — a caller must never treat "no listing" as
 * "no processes".
 */
function listProcesses() {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_LIST_SCRIPT], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) throw new Error(`sweep: cannot list processes: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`sweep: cannot list processes (powershell exit ${r.status}): ${r.stderr}`);
    return parseWindowsListing(r.stdout);
  }
  const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,stat=,etime=,rss=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`sweep: cannot list processes: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`sweep: cannot list processes (ps exit ${r.status}): ${r.stderr}`);
  return parsePosixListing(r.stdout);
}

/** Alive by the OS's own account (a POSIX zombie counts as dead: it can never run again). */
function isAlive(pid, procs = null) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (procs) {
    const p = procs.find((x) => x.pid === pid);
    return Boolean(p) && !/^Z/.test(p.state ?? '');
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Whether the listed process is the one a record describes: same pid, and — when
 * both sides know a start time — started within START_TOLERANCE_MS of it. A pid
 * reused by an unrelated process after the job ended fails this, so a stale record
 * is never mistaken for a live job.
 */
function sameProcess(proc, recordedStartedAt) {
  if (!proc) return false;
  if (!recordedStartedAt || !proc.startedAt) return true;
  const a = Date.parse(proc.startedAt);
  const b = Date.parse(recordedStartedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(a - b) <= START_TOLERANCE_MS;
}

/** Every descendant of `pid` in the listing, parents before children. */
function descendantsOf(pid, procs) {
  const byParent = new Map();
  for (const p of procs) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const out = [];
  const seen = new Set([pid]);
  const queue = [pid];
  while (queue.length) {
    const cur = queue.shift();
    for (const child of byParent.get(cur) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** The pids to terminate for a tree rooted at `pid`: the root first, then descendants top-down. */
function killOrder(pid, procs) {
  return [pid, ...descendantsOf(pid, procs).map((p) => p.pid)];
}

/**
 * The session that owns work started by `startPid`: the outermost ancestor matching
 * sessionRoots(names) (a loop beats the agent process it runs). Returns
 * `{ pid, startedAt, name, kind }` or null when no session is in the ancestry.
 */
function findOwner(procs, startPid, names = DEFAULT_OWNER_PROCESS_NAMES) {
  const roots = sessionRoots(names);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let owner = null;
  const seen = new Set();
  let cur = byPid.get(startPid);
  while (cur && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    const root = roots.find((r) => r.test(cur));
    if (root) owner = { pid: cur.pid, startedAt: cur.startedAt ?? null, name: cur.name, kind: root.kind };
    cur = byPid.get(cur.ppid);
  }
  return owner;
}

/**
 * The lifetime a sweep runs under. Checks keep their ceilings and have no owner.
 * A service has no ceilings; it is bound to `owner` (`'auto'` → findOwner from
 * `callerPid`, a pid → that process, null → none) and, when it has no owner, to an
 * idle ceiling (default DEFAULT_UNOWNED_IDLE_MIN; `idleMin` overrides, 0 disables).
 */
function serviceLifetime({ service, owner = 'auto', idleMin, procs, callerPid = process.pid, ownerProcessNames }) {
  if (!service) return { owner: null, idleMin: 0 };
  let resolved = null;
  if (owner === 'auto') {
    resolved = findOwner(procs, callerPid, ownerProcessNames);
  } else if (owner !== null && owner !== undefined) {
    const p = procs.find((x) => x.pid === Number(owner));
    if (!p) throw new Error(`sweep run: --owner ${owner} is not a running process`);
    resolved = { pid: p.pid, startedAt: p.startedAt ?? null, name: p.name, kind: 'explicit' };
  }
  return { owner: resolved, idleMin: idleMin ?? (resolved ? 0 : DEFAULT_UNOWNED_IDLE_MIN) };
}

/**
 * Private memory (RSS on POSIX) held by `pid` and every descendant, in MB, from a
 * fresh listing (or the `procs` given).
 */
function treeMemoryMb(pid, procs = listProcesses()) {
  const tree = [pid, ...descendantsOf(pid, procs).map((p) => p.pid)];
  const bytes = tree.reduce((sum, id) => {
    const p = procs.find((x) => x.pid === id);
    return sum + (p ? (p.privateBytes ?? p.rssBytes ?? 0) : 0);
  }, 0);
  return Math.round(bytes / 1048576);
}

/** Whether a recorded owner is still the same live process (pid reuse ruled out). */
function ownerAlive(owner, procs) {
  if (!owner) return true;
  const p = procs.find((x) => x.pid === owner.pid);
  return Boolean(p) && isAlive(owner.pid, procs) && sameProcess(p, owner.startedAt);
}

// ---------------------------------------------------------------------------
// Termination — the one place the OS differs for "stop that"
// ---------------------------------------------------------------------------

/** Send `sig` to one pid; false when it was already gone. Windows terminates on any signal. */
function signal(pid, sig) {
  try {
    process.kill(pid, sig);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}

/**
 * Terminate `pids`, gently first where the OS has a gentle option. Returns the
 * pids still alive afterwards (should be none).
 */
async function killPids(pids) {
  const targets = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid);
  for (const pid of targets) signal(pid, 'SIGTERM');
  const deadline = Date.now() + TERM_GRACE_MS;
  let alive = targets.filter((p) => isAlive(p));
  while (alive.length && Date.now() < deadline) {
    await sleep(200);
    alive = alive.filter((p) => isAlive(p));
  }
  for (const pid of alive) signal(pid, 'SIGKILL');
  if (alive.length) await sleep(300);
  return targets.filter((p) => isAlive(p));
}

/**
 * Kill the whole tree under `pid` (root included), from a fresh listing. With
 * `startedAt`, a root whose start time does not match is left alone — it is not
 * the process the caller meant — but any descendants recorded under it are not
 * consulted either, since a reused pid has none of ours.
 * @returns {{ killed: number[], skipped: string|null, survivors: number[] }}
 */
async function killTree(pid, { startedAt = null, procs = null } = {}) {
  const listing = procs ?? listProcesses();
  const root = listing.find((p) => p.pid === pid);
  if (!root) return { killed: [], skipped: `pid ${pid} is not running`, survivors: [] };
  if (!sameProcess(root, startedAt)) {
    return { killed: [], skipped: `pid ${pid} started at ${root.startedAt}, not ${startedAt}: reused by another process`, survivors: [] };
  }
  const order = killOrder(pid, listing);
  const survivors = await killPids(order);
  return { killed: order.filter((p) => !survivors.includes(p)), skipped: null, survivors };
}

/**
 * Headless browsers whose parent is gone: a test runner's chromium after the
 * runner was killed (Windows never cascades), or after it was reparented to
 * launchd/init (POSIX). Matched on the executable name AND a --headless
 * marker in the command line, so an interactive browser is never a candidate.
 */
function orphanBrowsers(procs) {
  const pids = new Set(procs.map((p) => p.pid));
  return procs.filter((p) => {
    const first = p.commandLine.split(/\s+/)[0] ?? '';
    if (!BROWSER_NAME.test(p.name) && !BROWSER_NAME.test(first)) return false;
    if (!BROWSER_HEADLESS.test(p.commandLine)) return false;
    const parentGone = !pids.has(p.ppid) || (process.platform !== 'win32' && p.ppid === 1);
    return parentGone;
  });
}

/** Kill every orphaned headless browser. Returns what was killed. */
async function reapOrphans({ procs = null } = {}) {
  const listing = procs ?? listProcesses();
  const orphans = orphanBrowsers(listing);
  // Roots only: a browser's own helper processes go with it through killTree.
  const orphanPids = new Set(orphans.map((p) => p.pid));
  const roots = orphans.filter((p) => !orphanPids.has(p.ppid));
  const killed = [];
  for (const root of roots) {
    const r = await killTree(root.pid, { procs: listing });
    killed.push(...r.killed);
  }
  return { killed, candidates: orphans.map((p) => p.pid) };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

const recordPath = (dir) => path.join(dir, RECORD);
const donePath = (dir) => path.join(dir, DONE);
const runLogPath = (dir) => path.join(dir, RUN_LOG);
const heartbeatPath = (dir) => path.join(dir, HEARTBEAT);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\u{FEFF}/u, ''));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const readRecord = (dir) => readJson(recordPath(dir));
const readDone = (dir) => readJson(donePath(dir));

/** Every `sweep.json` under `root` (recursively), as `{ dir, record }`. */
function findRecords(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        if (depth < 8) walk(path.join(dir, e.name), depth + 1);
      } else if (e.name === RECORD) {
        const record = readRecord(dir);
        if (record) out.push({ dir, record });
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Last non-empty line of a text file, or null. */
function lastLine(file, maxBytes = 64 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return lines.length ? lines[lines.length - 1] : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Progress a check reports about itself. A no-op unless the check runs under a
 * sweep (`SWEEP_DIR` is set by the watcher). The stall watchdog treats a new
 * heartbeat as progress, so a quiet phase (a long write with no stdout) is not
 * mistaken for a hang.
 */
function heartbeat(phase, detail = null, dir = process.env.SWEEP_DIR) {
  if (!dir) return false;
  try {
    writeJson(heartbeatPath(dir), { at: nowIso(), pid: process.pid, phase, detail });
    return true;
  } catch {
    return false;
  }
}

/** Live-ness of a record's processes, with pid reuse ruled out. */
function recordLiveness(record, procs) {
  const child = procs.find((p) => p.pid === record.pid);
  const watcher = procs.find((p) => p.pid === record.watcherPid);
  return {
    childAlive: Boolean(child) && isAlive(record.pid, procs) && sameProcess(child, record.processStartedAt),
    watcherAlive: Boolean(watcher) && isAlive(record.watcherPid, procs) && sameProcess(watcher, record.watcherStartedAt),
  };
}

// ---------------------------------------------------------------------------
// Commands: npm/npx/node without a shell on either OS
// ---------------------------------------------------------------------------

/** `npm-cli.js` / `npx-cli.js` for the Node that runs this, or null. */
function findNpmCli(name, { execPath = process.execPath, env = process.env, exists = fs.existsSync } = {}) {
  const candidates = [];
  if (env.npm_execpath) candidates.push(path.join(path.dirname(env.npm_execpath), `${name}-cli.js`));
  const bin = path.dirname(execPath);
  // Windows installs npm beside node.exe; POSIX installs (brew, nvm, volta,
  // nodejs.org) put it under the prefix's lib/.
  candidates.push(path.join(bin, 'node_modules', 'npm', 'bin', `${name}-cli.js`));
  candidates.push(path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', `${name}-cli.js`));
  return candidates.find((c) => exists(c)) ?? null;
}

/**
 * The executable + argv to spawn for a command, with `shell: false` on both OSes.
 * `node`, `npm` and `npx` resolve to this Node and npm's own CLI entry: on Windows
 * `npm` is `npm.cmd`, which Node refuses to spawn without a shell, and a shell string
 * is what the cross-platform rule forbids. Anything else must be a real executable on
 * PATH; a bare .cmd/.bat is refused.
 */
function resolveCommand(command, args = [], opts = {}) {
  const execPath = opts.execPath ?? process.execPath;
  if (command === 'node') return { file: execPath, args: [...args] };
  if (command === 'npm' || command === 'npx') {
    const cli = findNpmCli(command, opts);
    if (cli) return { file: execPath, args: [cli, ...args] };
    if ((opts.platform ?? process.platform) === 'win32') {
      throw new Error(`sweep: cannot find ${command}-cli.js beside ${execPath}; on Windows ${command} cannot be spawned without it`);
    }
    return { file: command, args: [...args] };
  }
  if (/\.(cmd|bat)$/i.test(command)) {
    throw new Error(`sweep: ${command} is a Windows shell shim and cannot be spawned without a shell; call the program it wraps (for npm/npx/node, use those names)`);
  }
  return { file: command, args: [...args] };
}

// ---------------------------------------------------------------------------
// run — launch a check detached under a watcher
// ---------------------------------------------------------------------------

/**
 * Start `command args…` detached under a watcher process, recorded in `dir`.
 * Returns once the record exists (the child is running) — the caller's own
 * process may then exit; the watcher lives on. Options:
 *   name        label for status output (default: the dir's basename)
 *   env         extra environment for the child (object)
 *   cwd         working directory (default: process.cwd())
 *   timeoutMin  hard ceiling; 0 disables (default DEFAULT_TIMEOUT_MIN; services: 0)
 *   stallMin    kill when neither run.log nor heartbeat.json advanced for this long;
 *               0 disables (default DEFAULT_STALL_MIN; services: 0)
 *   service     true for a server that runs until killed: no timeouts, and
 *               `wait` does not wait on it; bound to its owner (below)
 *   owner       services only: 'auto' (default — the outermost loop/agent process
 *               in the caller's ancestry), a pid, or null for none (`--detached`)
 *   idleMin     services only: stop after this long with no output or heartbeat;
 *               default 0 when owned, DEFAULT_UNOWNED_IDLE_MIN when not
 *   ownerCheckMs how often the watcher confirms the owner (default OWNER_CHECK_MS)
 *   maxMemMb    any sweep: stop the whole tree once its private memory (RSS on POSIX)
 *               exceeds this on two consecutive checks — verdict `memory`; 0/unset = none
 *   memCheckMs  how often that is measured (default MEM_CHECK_MS)
 *   log         where stdout+stderr go (default `<dir>/run.log`)
 *   watcherEntry the CLI file that dispatches `_watch` (scripts/sweep.mjs)
 */
async function run({ dir, command, args = [], name, env = {}, cwd = process.cwd(), timeoutMin, stallMin, service = false, owner = 'auto', idleMin, ownerCheckMs, maxMemMb, memCheckMs, log, watcherEntry }) {
  if (!dir) throw new Error('sweep run: --dir is required');
  if (!command) throw new Error('sweep run: a command is required after --');
  if (!watcherEntry) throw new Error('sweep run: watcherEntry is required');
  const absDir = path.resolve(dir);
  fs.mkdirSync(absDir, { recursive: true });
  const listingAtStart = listProcesses();
  const lifetime = serviceLifetime({ service, owner, idleMin, procs: listingAtStart });
  const existing = readRecord(absDir);
  if (existing) {
    const { childAlive, watcherAlive } = recordLiveness(existing, listingAtStart);
    if (childAlive || watcherAlive) {
      throw new Error(`sweep run: ${absDir} already has a running sweep (pid ${existing.pid}, since ${existing.startedAt}); kill it first`);
    }
    fs.unlinkSync(recordPath(absDir));
  }
  for (const f of [donePath(absDir), heartbeatPath(absDir)]) {
    try { fs.unlinkSync(f); } catch { /* not there */ }
  }
  // Resolved before detaching so an unspawnable command fails here, in the
  // caller's face, not silently in a detached watcher.
  resolveCommand(command, args);
  // The log is opened here for the same reason. On Windows a file another process
  // holds open for writing cannot be truncated (EBUSY); the watcher would die on it
  // and the caller would see only "no record appeared".
  const logFile = log ? path.resolve(log) : runLogPath(absDir);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  try {
    fs.closeSync(fs.openSync(logFile, 'w'));
  } catch (err) {
    throw new Error(`sweep run: cannot write ${logFile}: ${err.message}`
      + (err.code === 'EBUSY' ? ' — another process still holds it open; find it with `node scripts/sweep.mjs status`, or choose another --log' : ''));
  }

  const spec = {
    version: RECORD_VERSION,
    name: name ?? path.basename(absDir),
    dir: absDir,
    command,
    args,
    cwd: path.resolve(cwd),
    env,
    service: Boolean(service),
    timeoutMin: service ? 0 : (timeoutMin ?? DEFAULT_TIMEOUT_MIN),
    stallMin: service ? 0 : (stallMin ?? DEFAULT_STALL_MIN),
    owner: lifetime.owner,
    idleMin: lifetime.idleMin,
    ownerCheckMs: ownerCheckMs ?? OWNER_CHECK_MS,
    maxMemMb: maxMemMb ?? 0,
    memCheckMs: memCheckMs ?? MEM_CHECK_MS,
    log: logFile,
  };
  const specFile = path.join(absDir, `.spec-${process.pid}.json`);
  writeJson(specFile, spec);
  const watchLog = fs.openSync(path.join(absDir, WATCH_LOG), 'a');
  const watcher = spawn(process.execPath, [watcherEntry, '_watch', specFile], {
    detached: true,
    stdio: ['ignore', watchLog, watchLog],
    windowsHide: true,
    cwd: spec.cwd,
  });
  watcher.unref();
  fs.closeSync(watchLog);

  const failed = (why) => {
    const tail = lastLine(path.join(absDir, WATCH_LOG));
    return new Error(`sweep run: ${why}${tail ? `: ${tail.replace(/^\S+\s/, '')}` : ''} (see ${path.join(absDir, WATCH_LOG)})`);
  };
  const deadline = Date.now() + 20_000;
  for (;;) {
    const record = readRecord(absDir);
    if (record && record.watcherPid === watcher.pid) return record;
    // A watcher that gave up says so in its done file; one that died outright says
    // nothing, so its liveness is the other half of the answer. Either way the
    // caller hears immediately, not after the full deadline.
    const done = readDone(absDir);
    if (done) throw failed(done.error ?? `the watcher could not start the sweep (${done.verdict})`);
    if (!isAlive(watcher.pid)) throw failed('the watcher exited without recording the sweep');
    if (Date.now() >= deadline) throw failed('no record appeared within 20s');
    await sleep(100);
  }
}

/**
 * The watcher (a detached process started by `run`): starts the child, writes the
 * record, enforces the timeouts, and on any ending kills what the child left
 * running, reaps orphaned browsers, stamps `exit=` on the log and replaces the
 * record with a `sweep.done.json`. Never returns until the sweep is over.
 */
async function watch(specFile) {
  const spec = readJson(specFile);
  if (!spec) throw new Error(`sweep watch: cannot read ${specFile}`);
  const dir = spec.dir;
  const wlog = (line) => {
    try { fs.appendFileSync(path.join(dir, WATCH_LOG), `${nowIso()} ${line}\n`); } catch { /* best effort */ }
  };
  const finish = (done) => {
    writeJson(donePath(dir), { ...done, endedAt: nowIso() });
    try { fs.unlinkSync(recordPath(dir)); } catch { /* already gone */ }
    try { fs.unlinkSync(specFile); } catch { /* already gone */ }
  };

  let resolved;
  try {
    resolved = resolveCommand(spec.command, spec.args);
  } catch (err) {
    wlog(`cannot resolve ${spec.command}: ${err.message}`);
    finish({ name: spec.name, verdict: 'lost', error: err.message });
    return 1;
  }
  let out;
  try {
    fs.mkdirSync(path.dirname(spec.log), { recursive: true });
    out = fs.openSync(spec.log, 'w');
  } catch (err) {
    // Every failure in here ends in `finish`, never in an uncaught throw: a watcher
    // that dies without writing a record or a done file leaves the caller polling a
    // directory that will never change.
    wlog(`cannot open ${spec.log}: ${err.message}`);
    finish({ name: spec.name, verdict: 'lost', error: `cannot open ${spec.log}: ${err.message}` });
    return 1;
  }
  let child;
  try {
    child = spawn(resolved.file, resolved.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, SWEEP_DIR: dir },
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
  } catch (err) {
    fs.closeSync(out);
    wlog(`spawn failed: ${err.message}`);
    finish({ name: spec.name, verdict: 'lost', error: err.message });
    return 1;
  }
  let exit = null;
  const exited = new Promise((resolve) => {
    child.on('exit', (code, sig) => { exit = { code, signal: sig }; resolve(); });
    child.on('error', (err) => { wlog(`child error: ${err.message}`); exit = { code: null, signal: null, error: err.message }; resolve(); });
  });
  fs.closeSync(out);
  if (!child.pid) {
    await exited;
    wlog(`child did not start: ${exit?.error ?? 'unknown'}`);
    finish({ name: spec.name, verdict: 'lost', error: exit?.error ?? 'child did not start' });
    return 1;
  }

  const startedAt = nowIso();
  const listing = listProcesses();
  const record = {
    version: RECORD_VERSION,
    name: spec.name,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    service: spec.service,
    timeoutMin: spec.timeoutMin,
    stallMin: spec.stallMin,
    owner: spec.owner ?? null,
    idleMin: spec.idleMin ?? 0,
    maxMemMb: spec.maxMemMb ?? 0,
    log: spec.log,
    pid: child.pid,
    processStartedAt: listing.find((p) => p.pid === child.pid)?.startedAt ?? startedAt,
    watcherPid: process.pid,
    watcherStartedAt: listing.find((p) => p.pid === process.pid)?.startedAt ?? startedAt,
    startedAt,
    host: os.hostname(),
    platform: process.platform,
  };
  writeJson(recordPath(dir), record);
  try { fs.unlinkSync(specFile); } catch { /* already gone */ }
  wlog(`started ${spec.name}: pid ${child.pid} (${spec.command} ${spec.args.join(' ')}) timeout=${spec.timeoutMin}min stall=${spec.stallMin}min service=${spec.service}`
    + ` owner=${spec.owner ? `${spec.owner.kind}:${spec.owner.pid}` : 'none'} idle=${spec.idleMin ?? 0}min`);

  let verdict = null;
  let reason = null;
  // Detached, so no terminal Ctrl+C ever reaches this process: a signal here is
  // `kill()` ending the sweep, and `kill()` owns the cleanup — this watcher must
  // not race it by stamping the log or closing the record on its way out.
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { wlog(`watcher received ${s}; exiting`); process.exit(130); });

  const startedMs = Date.now();
  let ownerCheckedMs = startedMs;
  let memCheckedMs = startedMs;
  let memOverCount = 0;
  while (!exit) {
    await Promise.race([exited, sleep(5_000)]);
    if (exit || verdict) break;
    const elapsedMin = (Date.now() - startedMs) / 60_000;
    const quietMin = (Date.now() - Math.max(mtimeMs(spec.log) ?? startedMs, mtimeMs(heartbeatPath(dir)) ?? 0, startedMs)) / 60_000;
    if (spec.owner && Date.now() - ownerCheckedMs >= (spec.ownerCheckMs ?? OWNER_CHECK_MS)) {
      ownerCheckedMs = Date.now();
      let alive = true;
      try { alive = ownerAlive(spec.owner, listProcesses()); } catch (err) { wlog(`owner check skipped: ${err.message}`); }
      if (!alive) {
        verdict = 'owner-gone';
        reason = `owner ${spec.owner.kind} (pid ${spec.owner.pid}) has exited`;
      }
    }
    if (!verdict && spec.maxMemMb > 0 && Date.now() - memCheckedMs >= (spec.memCheckMs ?? MEM_CHECK_MS)) {
      memCheckedMs = Date.now();
      try {
        const mb = treeMemoryMb(child.pid);
        // Two consecutive readings over the ceiling: one spike (a short burst of allocation) is not a runaway.
        memOverCount = mb > spec.maxMemMb ? memOverCount + 1 : 0;
        if (memOverCount >= 2) {
          verdict = 'memory';
          reason = `memory: the tree holds ${mb} MB, over its ceiling of ${spec.maxMemMb} MB`;
        }
      } catch (err) { wlog(`memory check skipped: ${err.message}`); }
    }
    if (verdict) {
      // fall through to the kill below
    } else if (spec.idleMin > 0 && quietMin > spec.idleMin) {
      verdict = 'idle';
      reason = `idle: no output or heartbeat for ${fmtMin(quietMin)} min (ceiling ${spec.idleMin} min)`;
    } else if (spec.timeoutMin > 0 && elapsedMin > spec.timeoutMin) {
      verdict = 'timeout';
      reason = `hard timeout: ${spec.timeoutMin} min elapsed`;
    } else if (spec.stallMin > 0) {
      const last = Math.max(mtimeMs(spec.log) ?? startedMs, mtimeMs(heartbeatPath(dir)) ?? 0, startedMs);
      const stalledMin = (Date.now() - last) / 60_000;
      if (stalledMin > spec.stallMin) {
        verdict = 'timeout';
        const hb = readJson(heartbeatPath(dir));
        reason = `stalled: no output or heartbeat for ${fmtMin(stalledMin)} min${hb ? ` (last heartbeat: ${hb.phase}${hb.detail ? ` — ${hb.detail}` : ''})` : ''}`;
      }
    }
    if (verdict) {
      wlog(reason);
      await killTree(child.pid, { startedAt: record.processStartedAt });
      break;
    }
  }
  await Promise.race([exited, sleep(TERM_GRACE_MS + 2_000)]);
  if (!verdict) {
    verdict = exit?.signal ? 'killed' : String(exit?.code ?? 1);
    if (exit?.signal) reason = `child ended by ${exit.signal}`;
  }
  // The leak fix: whatever the child spawned and did not stop (a headless
  // browser, a test worker) goes with it, then the machine's orphaned
  // browsers, whoever left them.
  const survivors = descendantsOf(child.pid, listProcesses()).map((p) => p.pid);
  if (survivors.length) {
    wlog(`killing ${survivors.length} process(es) the child left running: ${survivors.join(', ')}`);
    await killPids(survivors);
  }
  const reaped = await reapOrphans();
  if (reaped.killed.length) wlog(`reaped ${reaped.killed.length} orphaned headless browser process(es): ${reaped.killed.join(', ')}`);
  const stamp = `${reason ? `sweep: ${reason}\n` : ''}exit=${verdict}\n`;
  try { fs.appendFileSync(spec.log, stamp); } catch (err) { wlog(`cannot stamp ${spec.log}: ${err.message}`); }
  const done = {
    name: spec.name, verdict, reason, code: exit?.code ?? null, signal: exit?.signal ?? null,
    startedAt, wallSeconds: Math.round((Date.now() - startedMs) / 1000),
    survivorsKilled: survivors, orphansReaped: reaped.killed, log: spec.log,
  };
  finish(done);
  wlog(`ended ${spec.name}: exit=${verdict}${reason ? ` (${reason})` : ''} after ${done.wallSeconds}s`);
  return verdict === '0' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// kill / wait / status
// ---------------------------------------------------------------------------

/**
 * End the sweep recorded in `dir` (or, with `pid`, an arbitrary tree). The
 * record's process is killed with its tree, the watcher is killed too (it would
 * otherwise stamp the log as if the child had exited on its own), orphans are
 * reaped, `exit=killed` is stamped, and the record becomes a done file.
 */
async function kill({ dir = null, pid = null, startedAt = null, reason = 'killed on request' }) {
  const procs = listProcesses();
  if (pid !== null) {
    const r = await killTree(pid, { startedAt, procs });
    const reaped = await reapOrphans();
    return { pid, ...r, orphansReaped: reaped.killed };
  }
  const absDir = path.resolve(dir);
  const record = readRecord(absDir);
  if (!record) {
    const reaped = await reapOrphans({ procs });
    return { dir: absDir, record: null, killed: [], orphansReaped: reaped.killed, note: 'no live record' };
  }
  const killed = [];
  if (record.watcherPid && record.watcherPid !== process.pid) {
    const w = await killTree(record.watcherPid, { startedAt: record.watcherStartedAt, procs });
    killed.push(...w.killed);
  }
  const c = await killTree(record.pid, { startedAt: record.processStartedAt, procs: listProcesses() });
  killed.push(...c.killed);
  const reaped = await reapOrphans();
  try { fs.appendFileSync(record.log ?? runLogPath(absDir), `sweep: ${reason}\nexit=killed\n`); } catch { /* log may be gone */ }
  writeJson(donePath(absDir), {
    name: record.name, verdict: 'killed', reason, startedAt: record.startedAt, endedAt: nowIso(),
    killed, orphansReaped: reaped.killed, log: record.log,
  });
  try { fs.unlinkSync(recordPath(absDir)); } catch { /* already gone */ }
  return { dir: absDir, record, killed: [...new Set(killed)], orphansReaped: reaped.killed, note: null };
}

/** One line describing a running sweep for the console. */
function describe(dir, record, procs) {
  const { childAlive, watcherAlive } = recordLiveness(record, procs);
  const minutes = Math.round((Date.now() - Date.parse(record.startedAt)) / 60_000);
  const hb = readJson(heartbeatPath(dir));
  const tail = lastLine(record.log ?? runLogPath(dir));
  const hbAge = hb?.at ? Math.round((Date.now() - Date.parse(hb.at)) / 60_000) : null;
  return {
    dir, name: record.name, pid: record.pid, watcherPid: record.watcherPid, service: Boolean(record.service),
    minutes, childAlive, watcherAlive,
    heartbeat: hb ? { phase: hb.phase, detail: hb.detail ?? null, ageMin: hbAge } : null,
    lastLine: tail,
    owner: record.owner ?? null,
    ownerAlive: record.owner ? ownerAlive(record.owner, procs) : null,
    line: `${record.name} (pid ${record.pid}${record.service ? `, service, owner ${record.owner ? `${record.owner.kind}:${record.owner.pid}${ownerAlive(record.owner, procs) ? '' : ' [gone]'}` : 'none'}` : ''}) ${minutes} min`
      + `${childAlive ? '' : ' [process gone]'}${watcherAlive ? '' : ' [watcher gone]'}`
      + `${hb ? ` — ${hb.phase}${hb.detail ? `: ${hb.detail}` : ''} (${hbAge} min ago)` : tail ? ` — ${tail.slice(0, 120)}` : ''}`,
  };
}

/** Every sweep under `root`'s `.claude-temp` (or `root` itself), described. */
function status({ root, procs = null }) {
  const base = fs.existsSync(path.join(root, '.claude-temp')) ? path.join(root, '.claude-temp') : root;
  const listing = procs ?? listProcesses();
  return findRecords(base).map(({ dir, record }) => describe(dir, record, listing));
}

/**
 * Stop what no session needs any more under `root`: every service whose owner has
 * exited (killed with its tree via `killFn`, stamped `exit=killed`), and every record
 * whose child and watcher are both gone (closed as `lost`). Checks with a live
 * process are left to their own ceilings and to `wait`. Returns one row per action.
 */
async function reapStale({ root, procs = null, killFn = kill }) {
  const base = fs.existsSync(path.join(root, '.claude-temp')) ? path.join(root, '.claude-temp') : root;
  const listing = procs ?? listProcesses();
  const actions = [];
  for (const { dir, record } of findRecords(base)) {
    const live = recordLiveness(record, listing);
    if (!live.childAlive && !live.watcherAlive) {
      try { fs.appendFileSync(record.log ?? runLogPath(dir), 'sweep: watcher and process are gone; closed by reap --stale\nexit=lost\n'); } catch { /* no log */ }
      writeJson(donePath(dir), { name: record.name, verdict: 'lost', reason: 'watcher and process gone', startedAt: record.startedAt, endedAt: nowIso(), log: record.log });
      try { fs.unlinkSync(recordPath(dir)); } catch { /* already gone */ }
      actions.push({ dir, name: record.name, action: 'closed-lost' });
      continue;
    }
    if (record.service && record.owner && !ownerAlive(record.owner, listing)) {
      const reason = `owner ${record.owner.kind} (pid ${record.owner.pid}) has exited; stopped by reap --stale`;
      await killFn({ dir, reason });
      actions.push({ dir, name: record.name, action: 'stopped', reason });
    }
  }
  return actions;
}

/**
 * Wait until no check (non-service sweep) under `root` is running. Progress goes
 * through `onProgress(line)` every `noteEveryMin`. A record whose watcher is gone
 * is adopted: its own timeouts are enforced here, and a record whose processes
 * are all gone is closed as `lost`. `maxMin` is the ceiling on THIS wait: on
 * breach every remaining check is killed (a watcher that stopped enforcing its
 * own ceiling is exactly the case the ceiling exists for).
 * @returns {Array<{dir,name,seconds,verdict}>}
 */
async function wait({ root, maxMin = 240, pollMs = 30_000, noteEveryMin = 5, onProgress = noop, insideDir = process.env.SWEEP_DIR }) {
  const base = fs.existsSync(path.join(root, '.claude-temp')) ? path.join(root, '.claude-temp') : root;
  // A caller running INSIDE a sweep (the watcher sets SWEEP_DIR for the child and every
  // descendant inherits it) must never wait on that sweep: it would be waiting for its
  // own exit (a loop launched through `sweep.mjs run` would block at its first
  // between-iterations wait).
  const self = insideDir ? path.resolve(insideDir) : null;
  const waited = new Map();
  const startedMs = Date.now();
  let lastNote = Date.now();
  let announced = false;
  for (;;) {
    const procs = listProcesses();
    const running = findRecords(base).filter(({ dir, record }) => !record.service && path.resolve(dir) !== self);
    const still = [];
    for (const { dir, record } of running) {
      if (!waited.has(dir)) waited.set(dir, { dir, name: record.name, startedMs: Date.now(), verdict: null });
      const live = recordLiveness(record, procs);
      if (!live.childAlive && !live.watcherAlive) {
        // Nothing of it runs, yet the watcher never closed the record: it was
        // killed, or the machine rebooted. Close it so nothing waits on it again.
        const reaped = await reapOrphans({ procs });
        try { fs.appendFileSync(record.log ?? runLogPath(dir), 'sweep: watcher and process are gone; closed by wait\nexit=lost\n'); } catch { /* no log */ }
        writeJson(donePath(dir), { name: record.name, verdict: 'lost', reason: 'watcher and process gone', startedAt: record.startedAt, endedAt: nowIso(), orphansReaped: reaped.killed, log: record.log });
        try { fs.unlinkSync(recordPath(dir)); } catch { /* already gone */ }
        waited.get(dir).verdict = 'lost';
        onProgress(`'${record.name}' has no running process and no watcher — closed as lost`);
        continue;
      }
      if (!live.watcherAlive) {
        // Adopt the watcher's job: the record's own ceilings still apply.
        const elapsedMin = (Date.now() - Date.parse(record.startedAt)) / 60_000;
        const last = Math.max(mtimeMs(record.log ?? runLogPath(dir)) ?? 0, mtimeMs(heartbeatPath(dir)) ?? 0, Date.parse(record.startedAt));
        const stalledMin = (Date.now() - last) / 60_000;
        let why = null;
        if (record.timeoutMin > 0 && elapsedMin > record.timeoutMin) why = `hard timeout: ${record.timeoutMin} min elapsed (watcher gone; enforced by wait)`;
        else if (record.stallMin > 0 && stalledMin > record.stallMin) why = `stalled: no output or heartbeat for ${fmtMin(stalledMin)} min (watcher gone; enforced by wait)`;
        if (why) {
          await kill({ dir, reason: why });
          waited.get(dir).verdict = 'timeout';
          onProgress(`'${record.name}' killed — ${why}`);
          continue;
        }
      }
      still.push({ dir, record });
    }
    if (still.length === 0) break;
    if (!announced) {
      for (const { dir, record } of still) onProgress(`detached sweep ${describe(dir, record, procs).line} is still running — waiting for it (no model turn while waiting)`);
      announced = true;
    }
    if ((Date.now() - startedMs) / 60_000 > maxMin) {
      for (const { dir, record } of still) {
        const why = `wait ceiling: ${maxMin} min waited by the caller`;
        await kill({ dir, reason: why });
        waited.get(dir).verdict = 'timeout';
        onProgress(`'${record.name}' killed — ${why}`);
      }
      break;
    }
    if ((Date.now() - lastNote) / 60_000 >= noteEveryMin) {
      for (const { dir, record } of still) onProgress(`... ${describe(dir, record, procs).line}`);
      lastNote = Date.now();
    }
    await sleep(pollMs);
  }
  return [...waited.values()].map((w) => ({
    dir: w.dir,
    name: w.name,
    seconds: Math.round((Date.now() - w.startedMs) / 1000),
    verdict: w.verdict ?? readDone(w.dir)?.verdict ?? null,
  }));
}

module.exports = {
  RECORD, DONE, RUN_LOG, HEARTBEAT, WATCH_LOG,
  DEFAULT_TIMEOUT_MIN, DEFAULT_STALL_MIN, DEFAULT_UNOWNED_IDLE_MIN, DEFAULT_OWNER_PROCESS_NAMES, START_TOLERANCE_MS,
  sessionRoots, findOwner, serviceLifetime, ownerAlive, reapStale, treeMemoryMb,
  parseWindowsListing, parsePosixListing, parseEtime, listProcesses, isAlive, sameProcess,
  descendantsOf, killOrder, killPids, killTree, orphanBrowsers, reapOrphans,
  readRecord, readDone, findRecords, heartbeat, recordLiveness, lastLine,
  findNpmCli, resolveCommand,
  run, watch, kill, status, wait,
};

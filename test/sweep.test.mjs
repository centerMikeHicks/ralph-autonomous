import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs, minutes, ownerOption } from '../scripts/sweep.mjs';

const require = createRequire(import.meta.url);
const sweep = require('../scripts/lib/sweep.cjs');

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sweep.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A node process that idles until killed; the _WITH_CHILD variant spawns one more like it. */
const IDLE = 'setInterval(() => {}, 1000)';
const IDLE_WITH_CHILD = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(IDLE)}],{stdio:'inherit'});console.log('child='+c.pid);${IDLE}`;

async function until(predicate, { timeoutMs = 20_000, everyMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(everyMs);
  }
  return predicate();
}

describe('CLI argument parsing', () => {
  it('parses flags, boolean flags, --env pairs and the command after --', () => {
    const o = parseArgs(['--dir', 'd', '--service', '--env', 'A=b=c', '--timeout-min=5', '--', 'node', '-e', '1']);
    assert.equal(o.dir, 'd');
    assert.equal(o.service, true);
    assert.deepEqual(o.env, { A: 'b=c' });
    assert.equal(o.timeoutMin, '5');
    assert.deepEqual(o.rest, ['node', '-e', '1']);
    assert.throws(() => parseArgs(['--env', 'novalue']), /NAME=value/);
  });

  it('minutes and ownerOption validate their input', () => {
    assert.equal(minutes(undefined, 7), 7);
    assert.equal(minutes('0', 7), 0);
    assert.throws(() => minutes('-1', 7), /non-negative/);
    assert.equal(ownerOption({}), 'auto');
    assert.equal(ownerOption({ detached: true, owner: '12' }), null);
    assert.equal(ownerOption({ owner: 'none' }), null);
    assert.equal(ownerOption({ owner: '12' }), 12);
    assert.throws(() => ownerOption({ owner: 'abc' }), /expects a pid/);
  });
});

describe('listing parsers', () => {
  it('parseEtime reads ss, mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
    assert.equal(sweep.parseEtime('00:05'), 5);
    assert.equal(sweep.parseEtime('01:02:03'), 3723);
    assert.equal(sweep.parseEtime('2-01:02:03'), 2 * 86400 + 3723);
    assert.equal(sweep.parseEtime('garbage'), null);
  });

  it('parsePosixListing keeps a command line whole, derives the name from its first token, and reads rss', () => {
    const now = Date.parse('2026-09-18T12:00:00Z');
    const text = [
      '    1     0 Ss   10-00:00:00   1024 /sbin/init',
      ' 4242  4000 S       00:01:30  20480 /Applications/Some App.app/Contents/MacOS/Some App --type=renderer',
      ' 4300     1 Z       00:00:02      0 [node] <defunct>',
      ' 5000  4999 R+      01:00:00 512000 node /repo/scripts/long-job.mjs --flag',
    ].join('\n');
    const procs = sweep.parsePosixListing(text, now);
    assert.deepEqual(procs.map((p) => p.pid), [1, 4242, 4300, 5000]);
    assert.equal(procs[1].ppid, 4000);
    assert.equal(procs[1].name, 'Some');
    assert.equal(procs[1].state, 'S');
    assert.match(procs[1].commandLine, /Some App --type=renderer/);
    assert.equal(procs[1].rssBytes, 20480 * 1024);
    assert.equal(procs[3].startedAt, new Date(now - 3600 * 1000).toISOString());
    assert.equal(procs[2].state, 'Z');
  });

  it('parseWindowsListing splits on the unit separator and tolerates a missing creation time', () => {
    const u = '\u001f';
    const text = [
      `4${u}0${u}${u}0${u}0${u}System${u}`,
      `1234${u}4${u}2026-09-18T11:00:00.0000000Z${u}1048576${u}2097152${u}chrome.exe${u}"C:\\x\\chrome.exe" --headless\t--type=renderer`,
    ].join('\r\n');
    const procs = sweep.parseWindowsListing(text);
    assert.equal(procs.length, 2);
    assert.deepEqual([procs[0].pid, procs[0].ppid, procs[0].startedAt, procs[0].name, procs[0].commandLine], [4, 0, null, 'System', '']);
    assert.deepEqual([procs[1].pid, procs[1].ppid, procs[1].name, procs[1].rssBytes, procs[1].privateBytes], [1234, 4, 'chrome.exe', 1048576, 2097152]);
    assert.match(procs[1].commandLine, /--headless\t--type=renderer/);
  });
});

describe('tree and identity', () => {
  const procs = [
    { pid: 1, ppid: 0, name: 'init', commandLine: 'init', startedAt: null, state: 'S' },
    { pid: 10, ppid: 1, name: 'node', commandLine: 'node watcher', startedAt: '2026-09-18T10:00:00Z', state: 'S' },
    { pid: 11, ppid: 10, name: 'node', commandLine: 'node child', startedAt: '2026-09-18T10:00:01Z', state: 'S' },
    { pid: 12, ppid: 11, name: 'node', commandLine: 'node grandchild', startedAt: '2026-09-18T10:00:02Z', state: 'S' },
    { pid: 13, ppid: 11, name: 'chrome', commandLine: 'chrome --headless', startedAt: '2026-09-18T10:00:03Z', state: 'S' },
    { pid: 20, ppid: 1, name: 'node', commandLine: 'node unrelated', startedAt: '2026-09-18T10:00:00Z', state: 'S' },
  ];

  it('descendantsOf walks parent links breadth-first; killOrder puts the root first', () => {
    assert.deepEqual(sweep.descendantsOf(10, procs).map((p) => p.pid), [11, 12, 13]);
    assert.deepEqual(sweep.descendantsOf(20, procs), []);
    assert.deepEqual(sweep.killOrder(11, procs), [11, 12, 13]);
  });

  it('sameProcess tolerates clock skew but rejects a reused pid', () => {
    const p = procs[1];
    assert.equal(sweep.sameProcess(p, '2026-09-18T10:00:05Z'), true);
    assert.equal(sweep.sameProcess(p, '2026-09-18T10:05:00Z'), false);
    assert.equal(sweep.sameProcess(p, null), true);
    assert.equal(sweep.sameProcess({ ...p, startedAt: null }, '2026-09-18T10:05:00Z'), true);
    assert.equal(sweep.sameProcess(null, '2026-09-18T10:00:00Z'), false);
  });

  it('orphanBrowsers: headless browsers with a dead parent only', () => {
    const list = [
      { pid: 100, ppid: 99, name: 'chrome.exe', commandLine: '"C:\\browsers\\chrome.exe" --headless --type=renderer', startedAt: null, state: '' },
      { pid: 101, ppid: 99, name: 'headless_shell', commandLine: '/x/headless_shell --headless --remote-debugging-pipe', startedAt: null, state: '' },
      { pid: 102, ppid: 99, name: 'chrome.exe', commandLine: '"C:\\Program Files\\Google\\Chrome\\chrome.exe" --profile-directory=Default', startedAt: null, state: '' },
      { pid: 103, ppid: 50, name: 'chrome.exe', commandLine: '"C:\\browsers\\chrome.exe" --headless', startedAt: null, state: '' },
      { pid: 50, ppid: 1, name: 'node.exe', commandLine: 'node runner', startedAt: null, state: '' },
      { pid: 1, ppid: 0, name: 'init', commandLine: 'init', startedAt: null, state: '' },
    ];
    // 100/101: headless, parent 99 is gone. 102: an interactive browser, never. 103: parent 50 is alive.
    assert.deepEqual(sweep.orphanBrowsers(list).map((p) => p.pid), [100, 101]);
  });

  it('treeMemoryMb sums the private bytes of a tree from a listing', () => {
    const mb = 1048576;
    const list = [
      { pid: 1, ppid: 0, privateBytes: 100 * mb },
      { pid: 2, ppid: 1, privateBytes: 30 * mb },
      { pid: 3, ppid: 2, rssBytes: 20 * mb },
      { pid: 4, ppid: 0, privateBytes: 999 * mb },
    ];
    assert.equal(sweep.treeMemoryMb(1, list), 150);
  });
});

describe('resolveCommand', () => {
  const exists = (set) => (p) => set.has(path.normalize(p));

  it("npm and npx resolve to this Node plus npm's own CLI entry", () => {
    const execPath = path.join('/opt/homebrew/bin', 'node');
    const cli = path.normalize(path.join('/opt/homebrew/bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    const r = sweep.resolveCommand('npm', ['run', 'x'], { execPath, env: {}, exists: exists(new Set([cli])), platform: 'darwin' });
    assert.deepEqual(r, { file: execPath, args: [cli, 'run', 'x'] });
  });

  it('npm_execpath wins when set (a script started by npm)', () => {
    const execPath = path.join(path.sep, 'nodejs', 'node');
    const npmBin = path.join(path.sep, 'home', 'me', '.volta', 'npm', 'bin');
    const cli = path.join(npmBin, 'npx-cli.js');
    const r = sweep.resolveCommand('npx', ['tool'], { execPath, env: { npm_execpath: path.join(npmBin, 'npm-cli.js') }, exists: exists(new Set([cli])), platform: 'win32' });
    assert.equal(r.args[0], cli);
  });

  it('on Windows a missing npm-cli.js is an error, not a shell fallback; a .cmd shim is refused everywhere', () => {
    assert.throws(() => sweep.resolveCommand('npm', [], { execPath: 'C:\\nodejs\\node.exe', env: {}, exists: () => false, platform: 'win32' }), /npm-cli\.js/);
    assert.deepEqual(sweep.resolveCommand('npm', ['ci'], { execPath: '/usr/bin/node', env: {}, exists: () => false, platform: 'linux' }), { file: 'npm', args: ['ci'] });
    assert.throws(() => sweep.resolveCommand('tool.cmd', []), /shell shim/);
  });

  it('node resolves to this Node; anything else is passed through', () => {
    assert.equal(sweep.resolveCommand('node', ['x.mjs']).file, process.execPath);
    assert.deepEqual(sweep.resolveCommand('git', ['status']), { file: 'git', args: ['status'] });
  });
});

describe('records', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('heartbeat writes into the sweep dir it is given and is a no-op without one', () => {
    // `dir` defaults to process.env.SWEEP_DIR, which is set when this suite itself runs inside a sweep.
    const outer = process.env.SWEEP_DIR;
    delete process.env.SWEEP_DIR;
    try {
      assert.equal(sweep.heartbeat('phase', 'detail', undefined), false);
    } finally {
      if (outer !== undefined) process.env.SWEEP_DIR = outer;
    }
    assert.equal(sweep.heartbeat('manifest', '3 of 9', dir), true);
    const hb = JSON.parse(fs.readFileSync(path.join(dir, 'heartbeat.json'), 'utf8'));
    assert.equal(hb.phase, 'manifest');
    assert.equal(hb.detail, '3 of 9');
    assert.equal(hb.pid, process.pid);
    assert.ok(Date.parse(hb.at) > 0);
  });

  it('findRecords finds sweep.json files below a root and lastLine reads the tail', () => {
    const a = path.join(dir, 'verify', 'a');
    fs.mkdirSync(a, { recursive: true });
    fs.writeFileSync(path.join(a, 'sweep.json'), JSON.stringify({ name: 'a', pid: 1 }));
    fs.writeFileSync(path.join(a, 'run.log'), 'first\r\nsecond\r\n\r\n');
    assert.deepEqual(sweep.findRecords(dir).map((r) => r.record.name), ['a']);
    assert.equal(sweep.lastLine(path.join(a, 'run.log')), 'second');
    assert.equal(sweep.lastLine(path.join(a, 'missing.log')), null);
  });
});

describe('on this OS', () => {
  it('listProcesses sees this process, its parent, a start time and memory', () => {
    const procs = sweep.listProcesses();
    const me = procs.find((p) => p.pid === process.pid);
    assert.ok(me);
    assert.equal(me.ppid, process.ppid);
    assert.ok(Math.abs(Date.now() - Date.parse(me.startedAt)) < 60 * 60 * 1000);
    assert.match(me.commandLine, /node/i);
    assert.ok(me.rssBytes > 0 || me.privateBytes > 0);
    assert.equal(sweep.isAlive(process.pid, procs), true);
    assert.ok(sweep.treeMemoryMb(process.pid, procs) > 10);
  });

  it('killTree ends a process and its grandchild, and refuses a start time that does not match', async () => {
    const parent = spawn(process.execPath, ['-e', IDLE_WITH_CHILD], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    parent.stdout.on('data', (d) => { out += d; });
    assert.equal(await until(() => /child=(\d+)/.test(out)), true);
    const grandchild = Number(/child=(\d+)/.exec(out)[1]);
    assert.equal(await until(() => sweep.isAlive(grandchild)), true);

    const refused = await sweep.killTree(parent.pid, { startedAt: '2000-01-01T00:00:00Z' });
    assert.match(refused.skipped, /reused/);
    assert.equal(sweep.isAlive(parent.pid), true);

    const r = await sweep.killTree(parent.pid);
    assert.equal(r.skipped, null);
    assert.ok(r.killed.includes(parent.pid) && r.killed.includes(grandchild));
    assert.deepEqual(r.survivors, []);
    assert.equal(await until(() => !sweep.isAlive(parent.pid) && !sweep.isAlive(grandchild)), true);
  });
});

describe('service lifetime', () => {
  const P = (pid, ppid, name, commandLine = '', startedAt = null) => ({ pid, ppid, name, commandLine, startedAt, state: '' });
  const tree = [
    P(1, 0, 'explorer.exe'),
    P(2, 1, 'pwsh.exe', 'pwsh -File C:\\proj\\ralph\\loop.ps1 build 5'),
    P(3, 2, 'claude.exe', 'claude -p'),
    P(4, 3, 'bash.exe', 'bash -c node scripts/sweep.mjs run'),
    P(5, 4, 'node.exe', 'node scripts/sweep.mjs run --service'),
    P(10, 1, 'claude.exe', 'claude'),
    P(11, 10, 'node.exe', 'node scripts/sweep.mjs run --service'),
    P(20, 1, 'node', 'node /usr/local/lib/node_modules/@vendor/claude-code/cli.js'),
    P(21, 20, 'node', 'node scripts/sweep.mjs run --service'),
    P(30, 1, 'powershell.exe', 'powershell'),
    P(31, 30, 'node.exe', 'node scripts/sweep.mjs run --service'),
    P(40, 1, 'mycli', 'mycli chat'),
    P(41, 40, 'node', 'node scripts/sweep.mjs run --service'),
  ];

  it('findOwner picks the outermost session: a loop beats the agent turn it runs', () => {
    const o = sweep.findOwner(tree, 5);
    assert.equal(o.pid, 2);
    assert.equal(o.kind, 'ralph-loop');
  });

  it('findOwner finds an interactive agent session, native or npm-installed', () => {
    assert.equal(sweep.findOwner(tree, 11).pid, 10);
    assert.equal(sweep.findOwner(tree, 11).kind, 'claude');
    assert.equal(sweep.findOwner(tree, 21).pid, 20);
  });

  it('findOwner returns null outside any session, and honours a configured name list', () => {
    assert.equal(sweep.findOwner(tree, 31), null);
    assert.equal(sweep.findOwner(tree, 41), null);
    assert.equal(sweep.findOwner(tree, 41, ['mycli']).pid, 40);
    assert.equal(sweep.findOwner(tree, 41, ['mycli.exe']).kind, 'mycli');
    assert.equal(sweep.findOwner(tree, 11, ['mycli']), null);
  });

  it('serviceLifetime: checks have no owner; an owned service has no idle ceiling; an unowned one gets the default', () => {
    assert.deepEqual(sweep.serviceLifetime({ service: false, procs: tree, callerPid: 11 }), { owner: null, idleMin: 0 });
    const owned = sweep.serviceLifetime({ service: true, procs: tree, callerPid: 11 });
    assert.equal(owned.owner.pid, 10);
    assert.equal(owned.idleMin, 0);
    assert.deepEqual(sweep.serviceLifetime({ service: true, procs: tree, callerPid: 31 }), { owner: null, idleMin: sweep.DEFAULT_UNOWNED_IDLE_MIN });
    assert.deepEqual(sweep.serviceLifetime({ service: true, owner: null, idleMin: 0, procs: tree, callerPid: 11 }), { owner: null, idleMin: 0 });
  });

  it('serviceLifetime binds an explicit owner pid and refuses one that is not running', () => {
    const r = sweep.serviceLifetime({ service: true, owner: 30, procs: tree });
    assert.equal(r.owner.pid, 30);
    assert.equal(r.owner.kind, 'explicit');
    assert.throws(() => sweep.serviceLifetime({ service: true, owner: 999, procs: tree }), /--owner 999 is not a running process/);
  });

  it('ownerAlive rejects an exited owner and a pid reused by another process', () => {
    const procs = [P(10, 1, 'claude.exe', 'claude', '2026-09-23T08:00:00Z')];
    assert.equal(sweep.ownerAlive(null, procs), true);
    assert.equal(sweep.ownerAlive({ pid: 10, startedAt: '2026-09-23T08:00:05Z' }, procs), true);
    assert.equal(sweep.ownerAlive({ pid: 10, startedAt: '2026-09-20T08:00:00Z' }, procs), false);
    assert.equal(sweep.ownerAlive({ pid: 11, startedAt: null }, procs), false);
  });
});

describe('reapStale', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-stale-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const writeRecord = (name, record) => {
    const dir = path.join(root, '.claude-temp', 'sweeps', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sweep.json'), JSON.stringify({ version: 1, name, command: 'node', args: [], startedAt: '2026-09-20T00:00:00Z', log: path.join(dir, 'run.log'), ...record }));
    return dir;
  };

  it('stops a service whose owner exited, leaves live-owned and unowned services alone, closes a dead record as lost', async () => {
    const proc = (pid, name = 'node.exe') => ({ pid, ppid: 1, name, commandLine: '', startedAt: null, state: '' });
    const procs = [proc(100), proc(101), proc(200), proc(201), proc(210, 'claude.exe'), proc(300)];
    const orphaned = writeRecord('orphaned', { service: true, pid: 100, watcherPid: 101, owner: { pid: 999, kind: 'claude', startedAt: null } });
    writeRecord('owned', { service: true, pid: 200, watcherPid: 201, owner: { pid: 210, kind: 'claude', startedAt: null } });
    writeRecord('unowned', { service: true, pid: 300, watcherPid: 301, owner: null, idleMin: 240 });
    const dead = writeRecord('dead', { service: false, pid: 2147483000, watcherPid: 2147483001 });
    const killCalls = [];
    const killFn = async (arg) => { killCalls.push(arg); return {}; };

    const actions = await sweep.reapStale({ root, procs, killFn });

    assert.equal(killCalls.length, 1);
    assert.equal(killCalls[0].dir, orphaned);
    assert.match(killCalls[0].reason, /owner claude \(pid 999\) has exited/);
    assert.deepEqual(actions.map((a) => `${a.name}:${a.action}`).sort(), ['dead:closed-lost', 'orphaned:stopped']);
    assert.equal(fs.existsSync(path.join(dead, 'sweep.json')), false);
    assert.match(fs.readFileSync(path.join(dead, 'run.log'), 'utf8'), /exit=lost/);
  });
});

describe('run -> watch -> wait (real detached watcher on this OS)', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-run-')); });
  afterEach(async () => {
    for (const { dir } of sweep.findRecords(root)) await sweep.kill({ dir });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a check runs detached with its env and SWEEP_DIR, ends with exit=<code>, and wait reports it', async () => {
    const dir = path.join(root, 'verify', 'smoke');
    // Lives ~2s: `wait` reports the sweeps it OBSERVES running, and a command that exits
    // instantly can be finished (record cleaned up) before wait's first poll.
    const record = await sweep.run({
      dir, command: 'node', args: ['-e', 'console.log("hi", process.env.HELLO, process.env.SWEEP_DIR); setTimeout(() => process.exit(3), 2000)'],
      env: { HELLO: 'world' }, watcherEntry: CLI, timeoutMin: 1, stallMin: 1,
    });
    assert.equal(record.name, 'smoke');
    assert.equal(record.service, false);
    assert.equal(record.timeoutMin, 1);
    assert.ok(record.pid > 0 && record.watcherPid > 0);

    const waited = await sweep.wait({ root, pollMs: 500, maxMin: 1 });
    assert.equal(waited.length, 1);
    assert.equal(waited[0].name, 'smoke');
    assert.equal(waited[0].verdict, '3');
    assert.equal(fs.existsSync(path.join(dir, 'sweep.json')), false);
    const log = fs.readFileSync(path.join(dir, 'run.log'), 'utf8');
    assert.ok(log.includes(`hi world ${dir}`));
    assert.equal(log.trim().split(/\r?\n/).pop(), 'exit=3');
    const done = sweep.readDone(dir);
    assert.equal(done.verdict, '3');
    assert.equal(done.code, 3);
  });

  it('a stalled check is killed with its whole tree and stamped exit=timeout', async () => {
    const dir = path.join(root, 'verify', 'stall');
    const record = await sweep.run({ dir, command: 'node', args: ['-e', IDLE_WITH_CHILD], watcherEntry: CLI, stallMin: 0.05 });
    const logOf = () => (fs.existsSync(path.join(dir, 'run.log')) ? fs.readFileSync(path.join(dir, 'run.log'), 'utf8') : '');
    assert.equal(await until(() => /child=\d+/.test(logOf())), true);
    const grandchild = Number(/child=(\d+)/.exec(logOf())[1]);

    const waited = await sweep.wait({ root, pollMs: 500, maxMin: 2 });
    assert.equal(waited[0].name, 'stall');
    assert.equal(waited[0].verdict, 'timeout');
    assert.match(logOf(), /sweep: stalled: no output or heartbeat/);
    assert.equal(logOf().trim().split(/\r?\n/).pop(), 'exit=timeout');
    assert.equal(await until(() => !sweep.isAlive(record.pid) && !sweep.isAlive(grandchild)), true);
  });

  it('a heartbeat counts as progress for the stall watchdog', async () => {
    const dir = path.join(root, 'verify', 'beat');
    const script = `const hb=require(${JSON.stringify(path.resolve(path.dirname(CLI), 'lib', 'sweep.cjs'))}).heartbeat;let n=0;const t=setInterval(()=>{hb('work','tick '+(++n));if(n>=40){clearInterval(t)}},1000);`;
    await sweep.run({ dir, command: 'node', args: ['-e', script], watcherEntry: CLI, stallMin: 0.05, timeoutMin: 2 });
    await sleep(8000);
    assert.ok(sweep.readRecord(dir), 'still running after more than the 3s stall ceiling because it keeps beating');
    await sweep.kill({ dir, reason: 'test done' });
  });

  it('run refuses a directory whose sweep is still running; kill ends it, its watcher and its tree', async () => {
    const dir = path.join(root, 'verify', 'kill');
    const record = await sweep.run({ dir, command: 'node', args: ['-e', IDLE_WITH_CHILD], watcherEntry: CLI, service: true, owner: null });
    assert.equal(record.service, true);
    await assert.rejects(sweep.run({ dir, command: 'node', args: ['-e', '1'], watcherEntry: CLI }), /already has a running sweep/);
    // A service is not waited on.
    assert.deepEqual(await sweep.wait({ root, pollMs: 200, maxMin: 1 }), []);

    const r = await sweep.kill({ dir, reason: 'test' });
    assert.ok(r.killed.includes(record.pid) && r.killed.includes(record.watcherPid));
    assert.equal(await until(() => !sweep.isAlive(record.pid) && !sweep.isAlive(record.watcherPid)), true);
    assert.equal(fs.existsSync(path.join(dir, 'sweep.json')), false);
    assert.match(fs.readFileSync(path.join(dir, 'run.log'), 'utf8'), /sweep: test\r?\nexit=killed/);
    const done = sweep.readDone(dir);
    assert.equal(done.verdict, 'killed');
    assert.equal(done.reason, 'test');
  });

  it('run reports a watcher that exits without recording, without waiting out the deadline', async () => {
    const stub = path.join(root, 'stub-watcher.mjs');
    fs.writeFileSync(stub, 'process.exit(7);\n');
    const started = Date.now();
    await assert.rejects(sweep.run({ dir: path.join(root, 'verify', 'nowatcher'), command: 'node', args: ['-e', '1'], watcherEntry: stub, owner: null }), /watcher exited without recording/);
    assert.ok(Date.now() - started < 15_000);
  });

  it('a service is stopped with its tree once its owner exits, and records the owner', async () => {
    const owner = spawn(process.execPath, ['-e', IDLE], { stdio: 'ignore' });
    try {
      await until(() => sweep.isAlive(owner.pid));
      const dir = path.join(root, 'sweeps', 'owned-service');
      const record = await sweep.run({
        dir, command: 'node', args: ['-e', IDLE_WITH_CHILD], service: true, owner: owner.pid, ownerCheckMs: 500, watcherEntry: CLI,
      });
      assert.equal(record.service, true);
      assert.equal(record.owner.pid, owner.pid);
      assert.equal(record.owner.kind, 'explicit');
      assert.equal(record.idleMin, 0);
      assert.equal(record.timeoutMin, 0);
      assert.equal(record.stallMin, 0);
      const readLog = () => fs.readFileSync(path.join(dir, 'run.log'), 'utf8');
      await until(() => /child=\d+/.test(readLog()));
      const grandchild = Number(/child=(\d+)/.exec(readLog())[1]);

      owner.kill();
      assert.equal(await until(() => sweep.readDone(dir) !== null, { timeoutMs: 30_000 }), true);
      const done = sweep.readDone(dir);
      assert.equal(done.verdict, 'owner-gone');
      assert.match(done.reason, /owner explicit \(pid \d+\) has exited/);
      assert.equal(await until(() => !sweep.isAlive(record.pid) && !sweep.isAlive(grandchild)), true);
      assert.equal(readLog().trim().split(/\r?\n/).pop(), 'exit=owner-gone');
    } finally {
      if (sweep.isAlive(owner.pid)) owner.kill();
    }
  });

  it('a sweep over its memory ceiling is stopped with its tree and stamped exit=memory', async () => {
    const dir = path.join(root, 'sweeps', 'hungry');
    // Holds ~120 MB of private memory; the ceiling is 50 MB.
    const HOG = 'const b=[];for(let i=0;i<12;i++){const a=Buffer.alloc(10*1024*1024,1);b.push(a)};setInterval(()=>b.length,1000)';
    const record = await sweep.run({ dir, command: 'node', args: ['-e', HOG], service: true, owner: null, idleMin: 0, maxMemMb: 50, memCheckMs: 500, watcherEntry: CLI });
    assert.equal(record.maxMemMb, 50);
    assert.equal(await until(() => sweep.readDone(dir) !== null, { timeoutMs: 45_000 }), true);
    const done = sweep.readDone(dir);
    assert.equal(done.verdict, 'memory');
    assert.match(done.reason, /over its ceiling of 50 MB/);
    assert.equal(sweep.isAlive(record.pid), false);
  });

  it('wait never waits on the sweep it is running inside (SWEEP_DIR)', async () => {
    const dir = path.join(root, 'verify', 'self');
    await sweep.run({ dir, command: 'node', args: ['-e', IDLE], watcherEntry: CLI, timeoutMin: 2, stallMin: 2 });
    const started = Date.now();
    const waited = await sweep.wait({ root, pollMs: 200, maxMin: 1, insideDir: dir });
    assert.deepEqual(waited, []);
    assert.ok(Date.now() - started < 5_000);
    assert.notEqual(sweep.readRecord(dir), null);
  });

  it('wait closes a record whose watcher and process are both gone as lost', async () => {
    const dir = path.join(root, 'verify', 'lost');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sweep.json'), JSON.stringify({
      version: 1, name: 'lost', command: 'node', args: [], pid: 2147483000, watcherPid: 2147483001,
      startedAt: '2026-01-01T00:00:00Z', timeoutMin: 1, stallMin: 1, service: false, log: path.join(dir, 'run.log'),
    }));
    const waited = await sweep.wait({ root, pollMs: 200, maxMin: 1 });
    assert.equal(waited[0].name, 'lost');
    assert.equal(waited[0].verdict, 'lost');
    assert.equal(fs.existsSync(path.join(dir, 'sweep.json')), false);
    assert.match(fs.readFileSync(path.join(dir, 'run.log'), 'utf8'), /exit=lost/);
  });

  it('status describes a running sweep', async () => {
    const dir = path.join(root, 'verify', 'shown');
    await sweep.run({ dir, command: 'node', args: ['-e', IDLE], watcherEntry: CLI, timeoutMin: 2, stallMin: 2 });
    const rows = sweep.status({ root });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'shown');
    assert.equal(rows[0].childAlive, true);
    assert.equal(rows[0].watcherAlive, true);
  });
});

test('module exports the documented surface', () => {
  for (const name of ['run', 'wait', 'kill', 'reapStale', 'reapOrphans', 'status', 'heartbeat', 'listProcesses', 'killTree', 'killPids', 'findOwner']) {
    assert.equal(typeof sweep[name], 'function', name);
  }
});

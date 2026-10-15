import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { acquireKeepAwake, holderCommand, windowsHolderScript } = require('../scripts/lib/keep-awake.cjs');

function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    child.kill = () => {};
    calls.push({ cmd, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}
const recorder = () => {
  const calls = [];
  const fn = (...args) => { calls.push(args); };
  fn.calls = calls;
  return fn;
};
const found = () => ({ status: 0 });
const missing = () => ({ error: new Error('ENOENT'), status: null });
const noKill = async () => [];

test('windows: PowerShell holder sets ES_CONTINUOUS|ES_SYSTEM_REQUIRED and watches the owner pid', () => {
  const spawnFn = fakeSpawn();
  const log = recorder();
  const hold = acquireKeepAwake({ ownerPid: 777, log, platform: 'win32', spawnFn, killFn: noKill });
  const { cmd, args, opts } = spawnFn.calls[0];
  assert.equal(cmd, 'powershell.exe');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(args[3], /SetThreadExecutionState/);
  assert.match(args[3], /0x80000001/);
  assert.match(args[3], /Get-Process -Id 777/);
  assert.equal(opts.shell, false);
  assert.equal(hold.held, true);
  assert.equal(log.calls[0][0], 'keep_awake_on');
  assert.match(log.calls[0][1], /4242/);
  assert.match(windowsHolderScript(5), /Id 5/);
});

test('macOS: caffeinate bound to the owner pid', () => {
  const spawnFn = fakeSpawn();
  acquireKeepAwake({ ownerPid: 9, platform: 'darwin', spawnFn, killFn: noKill });
  assert.equal(spawnFn.calls[0].cmd, 'caffeinate');
  assert.deepEqual(spawnFn.calls[0].args, ['-i', '-w', '9']);
});

test('linux: systemd-inhibit holder when present, logged no-op when absent', () => {
  const spawnFn = fakeSpawn();
  acquireKeepAwake({ ownerPid: 9, platform: 'linux', spawnFn, spawnSyncFn: found, killFn: noKill });
  assert.equal(spawnFn.calls[0].cmd, 'systemd-inhibit');
  // Bound to the owner: the holder ends when the runner does, even if it never released.
  assert.deepEqual(spawnFn.calls[0].args, ['--what=sleep', '--why=ralph-queue', '--mode=block', 'tail', '--pid=9', '-f', '/dev/null']);

  const spawn2 = fakeSpawn();
  const log = recorder();
  const hold = acquireKeepAwake({ platform: 'linux', spawnFn: spawn2, spawnSyncFn: missing, log });
  assert.equal(spawn2.calls.length, 0);
  assert.equal(hold.held, false);
  assert.equal(log.calls[0][0], 'keep_awake_unavailable');
});

test('an unsupported platform is a no-op', () => {
  assert.match(holderCommand('freebsd', 1, found).unavailable, /freebsd/);
});

test('release stops the holder once, is idempotent, and logs keep_awake_off', async () => {
  const spawnFn = fakeSpawn();
  const killed = [];
  const killFn = async (pids) => { killed.push(pids); return []; };
  const log = recorder();
  const hold = acquireKeepAwake({ platform: 'darwin', spawnFn, killFn, log });
  await hold.release();
  await hold.release();
  assert.deepEqual(killed, [[4242]]);
  assert.equal(log.calls.filter(([e]) => e === 'keep_awake_off').length, 1);
});

test('acquire failure is non-fatal: spawn throwing or an invalid owner logs and returns a no-op hold', async () => {
  const log = recorder();
  const boom = () => { throw new Error('spawn exploded'); };
  const hold = acquireKeepAwake({ platform: 'win32', spawnFn: boom, log });
  assert.equal(hold.held, false);
  assert.equal(await hold.release(), undefined);
  assert.deepEqual(log.calls[0], ['keep_awake_failed', 'spawn exploded']);

  const log2 = recorder();
  assert.equal(acquireKeepAwake({ ownerPid: -1, platform: 'win32', spawnFn: fakeSpawn(), log: log2 }).held, false);
  assert.equal(log2.calls[0][0], 'keep_awake_failed');
  assert.match(log2.calls[0][1], /ownerPid/);
});

test('a holder that errors asynchronously is logged and release then skips the kill', async () => {
  const spawnFn = fakeSpawn();
  const killed = [];
  const log = recorder();
  const hold = acquireKeepAwake({ platform: 'darwin', spawnFn, killFn: async (p) => { killed.push(p); return []; }, log });
  spawnFn.calls[0].child.emit('error', new Error('ENOENT'));
  await hold.release();
  assert.equal(killed.length, 0);
  assert.ok(log.calls.some(([e, d]) => e === 'keep_awake_failed' && /ENOENT/.test(d)));
});

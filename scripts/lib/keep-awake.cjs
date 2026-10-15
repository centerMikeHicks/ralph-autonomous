/**
 * Keep the machine from SYSTEM sleep while a long-running owner process works.
 *
 *   const hold = acquireKeepAwake({ ownerPid: process.pid, log });
 *   ...
 *   await hold.release();
 *
 * The OS branch lives here, behind this one function:
 *   win32  — a PowerShell holder that calls kernel32 SetThreadExecutionState
 *            (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) and exits when the owner is gone.
 *   darwin — `caffeinate -i -w <ownerPid>` (idle-sleep assertion that ends with the owner).
 *   linux  — `systemd-inhibit --what=sleep ... tail --pid=<ownerPid> -f /dev/null` when systemd-inhibit exists,
 *            otherwise a logged no-op (CI has no inhibitor and must not fail).
 * The holder is always a child of the caller, so it is terminated through sweep's
 * killPids (Node process.kill; no taskkill/pkill). Failing to acquire is logged and
 * never throws: the caller still runs, just without the sleep guard.
 */
const { spawn, spawnSync } = require('node:child_process');
const sweep = require('./sweep.cjs');

const ES_CONTINUOUS_SYSTEM_REQUIRED = '0x80000001';

/** PowerShell source for the Windows holder. `ownerPid` is validated to an integer by the caller. */
function windowsHolderScript(ownerPid) {
  return [
    "Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    `[void][Win32.Power]::SetThreadExecutionState([uint32]${ES_CONTINUOUS_SYSTEM_REQUIRED})`,
    `while (Get-Process -Id ${ownerPid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }`,
  ].join('; ');
}

function hasCommand(command, spawnSyncFn) {
  try {
    const r = spawnSyncFn(command, ['--version'], { stdio: 'ignore', shell: false });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/** The holder command for a platform as `[cmd, args]`, or `{ unavailable }` with the reason. */
function holderCommand(platform, ownerPid, spawnSyncFn) {
  if (platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsHolderScript(ownerPid)]];
  }
  if (platform === 'darwin') return ['caffeinate', ['-i', '-w', String(ownerPid)]];
  if (platform === 'linux') {
    if (!hasCommand('systemd-inhibit', spawnSyncFn)) return { unavailable: 'systemd-inhibit not found' };
    // `tail --pid` (GNU coreutils) exits when the owner does, so the inhibitor cannot outlive a
    // runner that was killed before it could release.
    return [
      'systemd-inhibit',
      ['--what=sleep', '--why=ralph-queue', '--mode=block', 'tail', `--pid=${ownerPid}`, '-f', '/dev/null'],
    ];
  }
  return { unavailable: `no keep-awake support on ${platform}` };
}

/**
 * @param {{ ownerPid?: number, log?: (event: string, detail?: string) => void,
 *           platform?: string, spawnFn?: Function, spawnSyncFn?: Function, killFn?: Function }} options
 * @returns {{ held: boolean, pid: number|null, release: () => Promise<void> }}
 */
function acquireKeepAwake({
  ownerPid = process.pid,
  log = () => {
    /* no logger: events are dropped */
  },
  platform = process.platform,
  spawnFn = spawn,
  spawnSyncFn = spawnSync,
  killFn = sweep.killPids,
} = {}) {
  const none = {
    held: false,
    pid: null,
    release: async () => {
      /* nothing is held, so there is nothing to release */
    },
  };
  try {
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error(`invalid ownerPid ${ownerPid}`);
    const command = holderCommand(platform, ownerPid, spawnSyncFn);
    if (!Array.isArray(command)) {
      log('keep_awake_unavailable', command.unavailable);
      return none;
    }
    const [cmd, args] = command;
    const child = spawnFn(cmd, args, { stdio: 'ignore', shell: false, windowsHide: true });
    if (!child || !child.pid) throw new Error(`${cmd} did not start`);
    let released = false;
    child.on?.('error', (error) => {
      released = true;
      log('keep_awake_failed', `${cmd}: ${error.message}`);
    });
    child.unref?.();
    log('keep_awake_on', `${cmd} pid ${child.pid}`);
    // Last resort when the owner exits without releasing: the holder is ours, so stop it.
    const onExit = () => {
      if (released) return;
      released = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    process.once('exit', onExit);
    return {
      held: true,
      pid: child.pid,
      async release() {
        process.removeListener('exit', onExit);
        if (released) return;
        released = true;
        try {
          await killFn([child.pid]);
        } catch (error) {
          log('keep_awake_failed', `release: ${error.message}`);
        }
        log('keep_awake_off', `pid ${child.pid}`);
      },
    };
  } catch (error) {
    log('keep_awake_failed', error.message);
    return none;
  }
}

module.exports = { acquireKeepAwake, holderCommand, windowsHolderScript };

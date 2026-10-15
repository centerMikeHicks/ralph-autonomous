import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmDir, runScript, writeFiles } from './helpers/kit.mjs';

test('verify-jira-sync CLI: exit codes for each provider/marker combination', () => {
  const dir = tmpDir('kit-jira-');
  try {
    writeFiles(dir, { 'ralph.config.json': JSON.stringify({ tracker: { provider: 'jira' } }), '.ralph/PROGRESS.md': 'ok\n', '.ralph/ACTIVE_SPEC': 'specs/x.md\n' });
    assert.equal(runScript('verify-jira-sync.mjs', [], { cwd: dir }).status, 0);
    fs.writeFileSync(path.join(dir, '.ralph', 'PROGRESS.md'), 'line\n⚠️ JIRA DEGRADED - 401\n');
    const blocked = runScript('verify-jira-sync.mjs', [], { cwd: dir });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /tracker\/x\.json/);
    fs.writeFileSync(path.join(dir, 'ralph.config.json'), JSON.stringify({ tracker: { provider: 'none' } }));
    assert.equal(runScript('verify-jira-sync.mjs', [], { cwd: dir }).status, 0);
    fs.rmSync(path.join(dir, '.ralph', 'PROGRESS.md'));
    fs.writeFileSync(path.join(dir, 'ralph.config.json'), JSON.stringify({ tracker: { provider: 'jira' } }));
    assert.equal(runScript('verify-jira-sync.mjs', [], { cwd: dir }).status, 0);
  } finally { rmDir(dir); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptMetrics, buildIterationRow } from '../ralph/lib/telemetry.mjs';
import { parseTestOutput, testMatcher, redactCommand } from '../ralph/lib/test-runs.mjs';

const j = JSON.stringify;
const use = (id, command, timestamp = '2026-11-06T10:00:00Z') =>
  j({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const res = (id, content, is_error = false) =>
  j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });

const VITEST_PASS = ' Test Files  2 passed (2)\n      Tests  12 passed (12)\n   Duration  1.2s';
const VITEST_FAIL = ' Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 11 passed | 2 skipped (14)\n';
const NX = 'NX   Successfully ran target test for 3 projects';

test('a configured commands.test no longer hides the common forms of a test run', () => {
  const lines = [
    use('1', 'cd packages/factory-profile && pnpm test 2>&1 | tail -15'),
    use('2', 'pnpm exec vitest run src/a.test.ts'),
    use('3', 'pnpm --filter @x/y test'),
    use('4', 'pnpm exec nx run x:test'),
    use('5', 'pnpm exec nx affected -t test'),
    use('6', 'pnpm exec nx run-many -t test'),
    use('7', 'pnpm test:e2e'),
    use('8', 'pnpm typecheck'),
    use('9', 'pnpm check:rules'),
    use('10', 'pnpm exec tsc -p .'),
    use('11', 'pnpm exec nx run-many -t typecheck'),
  ];
  const m = transcriptMetrics(lines, { testCommands: ['pnpm exec nx run-many -t test', null] });
  assert.equal(m.tests_run, 7);
});

test('a configured command adds to the default and the affected-test command counts too', () => {
  const lines = [use('1', './bin/check-it --fast'), use('2', 'pnpm lint')];
  assert.equal(transcriptMetrics(lines).tests_run, 0);
  assert.equal(transcriptMetrics(lines, { testCommands: ['./bin/check-it'] }).tests_run, 1);
  assert.ok(testMatcher({ testCommands: ['make unit'] })('make unit && vitest'));
});

test('each test run is recorded with its result: passing vitest, failing vitest, nx, unparseable', () => {
  const lines = [
    use('a', 'pnpm exec vitest run', '2026-11-06T10:00:01Z'), res('a', VITEST_PASS),
    use('b', 'pnpm test', '2026-11-06T10:00:02Z'), res('b', `Exit code 1\n${VITEST_FAIL}`, true),
    use('c', 'pnpm exec nx run-many -t test'), res('c', NX),
    use('d', 'pnpm test'), res('d', [{ type: 'text', text: 'something odd happened' }]),
    use('e', 'pnpm test'),
  ];
  const { test_runs: runs, tests_run } = transcriptMetrics(lines);
  assert.equal(tests_run, 5);
  assert.deepEqual([runs[0].passed, runs[0].failed, runs[0].total, runs[0].parsed, runs[0].is_error], [12, 0, 12, true, false]);
  assert.equal(runs[0].started_at, '2026-11-06T10:00:01Z');
  assert.deepEqual([runs[1].passed, runs[1].failed, runs[1].skipped, runs[1].total, runs[1].exit_code, runs[1].is_error], [11, 1, 2, 14, 1, true]);
  assert.deepEqual([runs[2].passed, runs[2].unit, runs[2].parsed], [3, 'projects', true]);
  assert.deepEqual([runs[3].passed, runs[3].failed, runs[3].total, runs[3].parsed], [null, null, null, false]);
  assert.equal(runs[4].is_error, null, 'a run with no tool_result has an unknown result');
});

test('parseTestOutput reads jest, pytest, node --test, and adds up several packages', () => {
  assert.deepEqual(parseTestOutput('Tests:       1 failed, 11 passed, 12 total').failed, 1);
  const py = parseTestOutput('=== 2 failed, 10 passed, 1 skipped in 1.20s ===');
  assert.deepEqual([py.passed, py.failed, py.skipped, py.total], [10, 2, 1, 13]);
  const node = parseTestOutput('# tests 5\n# pass 4\n# fail 1\n# skipped 0\n');
  assert.deepEqual([node.passed, node.failed, node.total], [4, 1, 5]);
  const two = parseTestOutput(`${VITEST_PASS}\n\u001b[32m      Tests  3 passed (3)\u001b[39m`);
  assert.deepEqual([two.passed, two.total], [15, 15]);
  assert.equal(parseTestOutput('').passed, null);
});

test('redactCommand shortens and blanks credentials', () => {
  const c = redactCommand(`curl -H "Authorization: Bearer abc123" API_TOKEN=s3cret pnpm test ${'x'.repeat(300)}`);
  assert.ok(c.length <= 200);
  assert.ok(!c.includes('abc123') && !c.includes('s3cret'));
});

function rowFor(lines, status) {
  return buildIterationRow({
    run: 'r', iter: 1, branch: 'b', specName: 's', mode: 'build', modelLabel: 'm', startMs: 0, endMs: 1000, gapS: 0, exitCode: 0,
    headBefore: 'a', headAfter: 'b', status: { fresh: true, phase: 'P1', outcome: 'continue', did: 'built it', result: '', next: '', ...status },
    metrics: transcriptMetrics(lines),
  });
}

test('the row carries the runs and flags a "tests pass" claim the runs do not back', () => {
  const claim = { result: 'Phase 1 done, 6 tests green' };
  const none = rowFor([use('1', 'ls')], claim);
  assert.equal(none.test_claim_mismatch, true, 'claim with no run');
  const failed = rowFor([use('1', 'pnpm test'), res('1', VITEST_FAIL, true)], claim);
  assert.equal(failed.test_claim_mismatch, true, 'claim with a failing run');
  assert.deepEqual([failed.tests_run, failed.tests_summary.failed, failed.test_runs.length], [1, 1, 1]);
  const good = rowFor([use('1', 'pnpm test'), res('1', VITEST_PASS)], claim);
  assert.equal(good.test_claim_mismatch, false);
  assert.equal(good.tests_summary.passed, 1);
  assert.equal(rowFor([use('1', 'ls')], { result: 'refactored the loader' }).test_claim_mismatch, false, 'no claim, no flag');
});

test('red then green is not a mismatch; text written by a heredoc or quoted is not a test run', () => {
  const claim = { result: 'Phase 1 done, 6 tests green' };
  const redGreen = rowFor([use('1', 'pnpm test'), res('1', VITEST_FAIL, true), use('2', 'pnpm test'), res('2', VITEST_PASS)], claim);
  assert.equal(redGreen.tests_summary.last, 'passed');
  assert.equal(redGreen.test_claim_mismatch, false);
  const lines = [use('1', "cat > notes.md <<'EOF'\nrun pnpm test\nEOF"), use('2', "sed -i 's/a/pnpm test/' f.md")];
  assert.equal(transcriptMetrics(lines).tests_run, 0);
});

// Test runs seen in an iteration's transcript: which Bash/PowerShell commands were test runs, how each
// ended, and the counts parsed from its output. Unknown counts are null, never 0.

/**
 * A command is a test run when it matches the default pattern: a test runner, a package manager's
 * `test` script (run/exec/--filter/-C allowed between), or an nx test target. `tsc`, lint and
 * `check:rules` do not match; `test:e2e` does.
 */
export const DEFAULT_TEST_PATTERN = new RegExp([
  String.raw`\b(jest|vitest|pytest|mocha)\b|node --test`,
  String.raw`\b(npm|pnpm|yarn)\b(?: (?:run|exec|-r|-w|-C \S+|--filter[= ]\S+))* test(?::[\w:-]+)?(?=\s|$)`,
  String.raw`\bnx\b[^|;&\n]*?(?:(?:-t|--targets?)[ =]test\b|\brun \S+:test\b)`,
].join('|'));

const literal = (cmd) => new RegExp(cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/**
 * Build the matcher: the default pattern OR any configured test command (`commands.test`,
 * `commands.affectedTest`), matched literally. A configured command adds to the default, never replaces it.
 */
export function testMatcher({ testPattern, testCommands = [] } = {}) {
  const extra = [testPattern, ...testCommands.filter((c) => typeof c === 'string' && c.trim()).map(literal)].filter(Boolean);
  return (cmd) => {
    const c = executable(cmd);
    return DEFAULT_TEST_PATTERN.test(c) || extra.some((re) => re.test(c));
  };
}

/** The command without heredoc bodies and quoted strings, so text being written or searched is not mistaken for a command. */
const executable = (cmd) => String(cmd)
  .replace(/<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\s|$)/g, '')
  .replace(/'[^']*'|"[^"]*"/g, '""');

/** Shorten a command for the record and blank out anything that looks like a credential. */
export function redactCommand(cmd, max = 200) {
  const t = String(cmd).replace(/\s+/g, ' ').trim()
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 ***')
    .replace(/((?:token|key|secret|password|passwd|auth\w*|credential\w*)[\w-]*\s*[=:]\s*)\S+/gi, '$1***')
    .replace(/\b(sk|ghp|gho|xox[bp])[-_][\w-]{8,}/g, '***');
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** "1 failed, 11 passed" to { failed: 1, passed: 11 }. */
function counts(text) {
  const out = {};
  for (const m of text.matchAll(/(\d+)\s+(passed|failed|skipped|todo|total|errors?)\b/g)) {
    const k = m[2].startsWith('error') ? 'failed' : m[2];
    out[k] = (out[k] || 0) + Number(m[1]);
  }
  return out;
}

/**
 * Counts from a run's output: { passed, failed, skipped, total, unit, parsed }. Summary lines of
 * several packages in one run are added up. Recognises vitest and jest, pytest, node --test and nx.
 */
export function parseTestOutput(raw) {
  const text = String(raw || '').replace(ANSI, '');
  const none = { passed: null, failed: null, skipped: null, total: null, unit: 'tests', parsed: false };
  const sums = { passed: 0, failed: 0, skipped: 0, total: 0 };
  let found = false;
  const add = (c, total) => {
    found = true;
    const skipped = (c.skipped || 0) + (c.todo || 0);
    sums.passed += c.passed || 0;
    sums.failed += c.failed || 0;
    sums.skipped += skipped;
    sums.total += total ?? c.total ?? ((c.passed || 0) + (c.failed || 0) + skipped);
  };
  // vitest "Tests  1 failed | 11 passed (12)" and jest "Tests: 1 failed, 11 passed, 12 total"
  for (const m of text.matchAll(/^\s*Tests:?\s+(\d+ (?:passed|failed|skipped|todo|total)[^\n]*)$/gm)) {
    const paren = m[1].match(/\((\d+)\)\s*$/);
    add(counts(m[1]), paren ? Number(paren[1]) : undefined);
  }
  // pytest "=== 2 failed, 10 passed, 1 skipped in 1.2s ==="
  if (!found) {
    for (const m of text.matchAll(/^=*\s*((?:\d+ (?:passed|failed|skipped|errors?)(?:, )?)+)\s+in [\d.]+s/gm)) add(counts(m[1]));
  }
  // node --test "# pass 3" "# fail 1"
  if (!found) {
    const g = (k) => { const m = text.match(new RegExp(`^# ${k} (\\d+)`, 'm')); return m ? Number(m[1]) : null; };
    if (g('pass') !== null || g('fail') !== null) add({ passed: g('pass') || 0, failed: g('fail') || 0, skipped: g('skipped') || 0 }, g('tests') ?? undefined);
  }
  if (found) return { ...none, ...sums, parsed: true };
  // nx without a test-level summary: the counts are projects or tasks, not tests
  const ok = text.match(/Successfully ran target \S+ for (\d+) projects?/);
  const bad = text.match(/(\d+)\s+(?:out of|of)\s+(\d+)\s+tasks?\s+failed/);
  if (ok) return { ...none, passed: Number(ok[1]), failed: 0, total: Number(ok[1]), unit: 'projects', parsed: true };
  if (bad) return { ...none, failed: Number(bad[1]), total: Number(bad[2]), unit: 'tasks', parsed: true };
  return none;
}

const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n') : '');

/** Pair each test-run tool_use with its tool_result (by tool_use_id) and record one entry per run. */
export function collectTestRuns(events, isTest) {
  const runs = [];
  const byId = new Map();
  for (const e of events) {
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_use' && (b.name === 'Bash' || b.name === 'PowerShell')) {
        const cmd = b.input && typeof b.input.command === 'string' ? b.input.command : '';
        if (!isTest(cmd)) continue;
        const run = { command: redactCommand(cmd), started_at: e.timestamp || null, is_error: null, exit_code: null, passed: null, failed: null, skipped: null, total: null, unit: 'tests', parsed: false };
        runs.push(run);
        if (b.id) byId.set(b.id, run);
      } else if (b.type === 'tool_result' && byId.has(b.tool_use_id)) {
        const run = byId.get(b.tool_use_id);
        const text = resultText(b.content);
        const code = text.match(/Exit code:? (\d+)/);
        run.is_error = Boolean(b.is_error);
        run.exit_code = code ? Number(code[1]) : b.is_error ? null : 0;
        Object.assign(run, parseTestOutput(text));
      }
    }
  }
  return runs;
}

/** Totals over an iteration's runs. A run "failed" if it counted failures, or errored with nothing parsed. */
export function summariseTestRuns(runs) {
  const s = { runs: runs.length, passed: 0, failed: 0, unparsed: 0, errored: 0, no_result: 0, last: 'none' };
  for (const r of runs) {
    if (r.is_error === null) s.no_result += 1;
    if (r.is_error) s.errored += 1;
    if (!r.parsed) s.unparsed += 1;
    if (r.failed > 0 || (r.is_error && !r.parsed)) s.failed += 1;
    else if (r.is_error === false) s.passed += 1;
  }
  const last = runs[runs.length - 1];
  if (last) s.last = last.failed > 0 || (last.is_error && !last.parsed) ? 'failed' : last.is_error === false ? 'passed' : 'unknown';
  return s;
}

const CLAIM = /\b(tests?|suites?|vitest|specs?)\b[^.\n]{0,40}\b(pass(?:ed|ing)?|green)\b|\b(pass(?:ed|ing)?|green)\b[^.\n]{0,20}\b(tests?|suites?)\b|\b\d+ (?:tests? )?(?:green|passing)\b/i;

/**
 * True when the agent's own words claim passing tests but no run was recorded or the LAST one failed
 * (an earlier red run that went green is the loop working, not a mismatch).
 */
export function testClaimMismatch(statusText, summary) {
  if (!CLAIM.test(statusText || '')) return false;
  return summary.runs === 0 || summary.last === 'failed';
}

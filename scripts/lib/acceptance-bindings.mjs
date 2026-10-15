/**
 * Acceptance bindings — does the test a spec row names exist, at the layer the row's tag
 * demands, with a real assertion in it?
 *
 * "A test by this name is written somewhere" is not enough: a row whose Then is page-level can
 * be ticked on a unit test of a helper nothing calls, and a skipped or assertion-free test
 * proves nothing. A row is bound when a non-skipped test (or named function) carrying the
 * row's name exists in a file matching `tests.globs`, its body reaches an assertion-looking
 * call, and — only when `tests.layers` is configured — it sits at the tagged layer or above
 * (unit < integration < e2e). Whether the assertion matches the spec's Then is the reviewer's
 * call; this is the mechanical half.
 */
import fs from 'node:fs';
import path from 'node:path';
import { compileGlobs, walkFiles } from './glob.mjs';
import { parseSpecPhases, parsePlanPhases, findSpecPhase } from './spec-parse.mjs';

const LAYER_RANK = { unit: 0, integration: 1, e2e: 2 };

/** True when `tests.layers` configures at least one layer with at least one glob. */
export function layersConfigured(layers) {
  return Boolean(layers) && Object.values(layers).some((g) => Array.isArray(g) && g.length > 0);
}

/** The layer a test file runs at, from `tests.layers` globs (highest match wins); null when not configured. */
export function layerOf(file, layers) {
  if (!layersConfigured(layers)) return null;
  for (const layer of ['e2e', 'integration', 'unit']) {
    if (layers[layer]?.length && compileGlobs(layers[layer])(file)) return layer;
  }
  return 'unit';
}

const ASSERT_RE = /\bexpect\w*\s*\(|\bassert\b|\.should\b|\bt\.(?:is|ok|true|false|equal|deepEqual|notEqual|throws|rejects|pass|fail|snapshot|like|match)\w*\s*\(|\b(?:strictEqual|deepStrictEqual|deepEqual|notStrictEqual|toBe|toEqual)\s*\(/;

/** The text from `from` to the bracket that closes the enclosing group (depth 1 at entry), strings and comments skipped. */
function enclosedBody(src, from) {
  let depth = 1;
  let quote = null;
  let i = from;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(from, i);
}

/** A body with block and line comments removed, so a commented-out `expect(` is not an assertion. */
const hasAssertion = (body) => ASSERT_RE.test(String(body).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'));
const lineOf = (src, index) => src.slice(0, index).split('\n').length;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Test declarations in a file: `it(` / `test(` / `describe(` with any modifier chain (`.skip`,
 * `.only`, `.todo`, `.each(...)`), the `x`/`f` prefixed forms, and node:test's `{ skip: ... }` /
 * `{ todo: ... }` options. Title is the first string argument; the body is the rest of the call.
 */
export function parseTestDeclarations(text) {
  const src = String(text ?? '');
  const re = /(?<![\w.$])(it|test|xit|xtest|fit|ftest|describe|xdescribe|fdescribe|suite)((?:\.(?:skip|only|todo|concurrent|failing|each)(?:\s*\((?:[^()]|\([^()]*\))*\)|\s*`[^`]*`)?)*)\s*\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const fn = m[1];
    const mods = m[2] ?? '';
    const body = enclosedBody(src, m.index + m[0].length);
    const optionSkip = /^[\s,]*(?:\{[^{}]*\b(?:skip|todo)\s*:\s*(?!false\b)[^,}]+[^}]*\}\s*,)/.test(body);
    out.push({
      title: m[4],
      kind: /describe$|suite$/i.test(fn) ? 'describe' : 'test',
      line: lineOf(src, m.index),
      skipped: /^x/.test(fn) || /\.(skip|todo)\b/.test(mods) || optionSkip,
      hasAssertion: hasAssertion(body),
    });
  }
  return out;
}

/** Named functions / consts whose identifier is `name`: `function name(`, `async function name(`, `const name = (`, `def name(`. */
export function parseNamedFunctions(text, name) {
  const src = String(text ?? '');
  const id = escapeRe(name);
  const re = new RegExp(`(?<![\\w$])(?:(?:async\\s+)?function\\s*\\*?\\s*${id}\\s*\\(|(?:const|let|var)\\s+${id}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|\\w+\\s*=>)|def\\s+${id}\\s*\\()`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    // The body is the braces after the declaration; a Python def runs to the next dedent-free `def`/EOF.
    let body;
    if (m[0].startsWith('def')) {
      const rest = src.slice(m.index + m[0].length);
      const next = rest.search(/\n(?:def|class)\s/);
      body = next < 0 ? rest : rest.slice(0, next);
    } else {
      const open = src.indexOf('{', m.index + m[0].length - 1);
      const arrowExpr = /=>\s*[^{\s]/.test(src.slice(m.index, open < 0 ? m.index + m[0].length + 2 : open));
      body = open < 0 || arrowExpr ? src.slice(m.index, m.index + 400) : enclosedBody(src, open + 1);
    }
    out.push({ title: name, kind: 'function', line: lineOf(src, m.index), skipped: false, hasAssertion: hasAssertion(body) });
  }
  return out;
}

const wordRe = (name) => new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`);

/** Test files (repo-relative) under `root` matching `tests.globs` and not `tests.ignore`. */
export function listTestFiles(root, testsConfig) {
  const match = compileGlobs(testsConfig?.globs ?? []);
  return walkFiles(root, testsConfig?.ignore ?? []).filter(match);
}

/** Every declaration/function bound to `name` across the candidate files. */
function bindingsFor(name, files, root, layers, cache) {
  if (cache.has(name)) return cache.get(name);
  const re = wordRe(name);
  const found = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    if (!text.includes(name)) continue;
    const layer = layerOf(file, layers);
    for (const d of parseTestDeclarations(text)) {
      if (re.test(d.title)) found.push({ file, line: d.line, layer, skipped: d.skipped, hasAssertion: d.hasAssertion, title: d.title });
    }
    for (const d of parseNamedFunctions(text, name)) found.push({ file, layer, ...d });
  }
  cache.set(name, found);
  return found;
}

const where = (tests) => tests.slice(0, 3).map((t) => `${t.file}:${t.line}`).join(', ');

/** Judge one row: `{ ok, kind, message?, tests }`. */
function judgeRow(row, ctx) {
  if (['visual-only', 'none', 'command'].includes(row.kind)) return { ok: true, kind: row.kind, tests: [] };
  if (row.kind === 'unnamed') {
    return { ok: false, kind: 'unnamed', tests: [], message: `\`[${row.tag}]\` row names no test and is not a command or "none" — nothing can bind it` };
  }
  const tests = bindingsFor(row.name, ctx.files, ctx.root, ctx.layers, ctx.cache);
  if (!tests.length) return { ok: false, kind: 'missing', tests, message: `no test or function named \`${row.name}\` exists in any file matching tests.globs` };
  const live = tests.filter((t) => !t.skipped);
  if (!live.length) return { ok: false, kind: 'skipped', tests, message: `\`${row.name}\` exists only as a skipped/todo test (${where(tests)})` };
  const asserting = live.filter((t) => t.hasAssertion);
  if (!asserting.length) return { ok: false, kind: 'no-assertion', tests, message: `\`${row.name}\` has no assertion-looking call (expect/assert/should) in its body (${where(live)})` };
  if (ctx.layers && LAYER_RANK[row.tag] !== undefined) {
    const need = LAYER_RANK[row.tag];
    const best = asserting.reduce((b, t) => Math.max(b, LAYER_RANK[t.layer] ?? 0), -1);
    if (best < need) {
      return { ok: false, kind: 'wrong-layer', tests, message: `\`${row.name}\` is tagged \`[${row.tag}]\` but is bound at the ${[...new Set(asserting.map((t) => t.layer))].join('/')} layer only (${where(asserting)})` };
    }
  }
  return { ok: true, kind: 'bound', tests: asserting };
}

/**
 * Check the spec's rows for a set of phases.
 * @param {{ specText: string, planText?: string, phaseKeys?: string[], root: string, tests?: object }} opts
 *   phaseKeys — the spec phases to check; default: every phase the plan ticks `[x]`.
 * @returns {{ phases: Array, findings: Array, unknownPhases: string[], layerCheck: boolean }}
 */
export function checkAcceptanceBindings({ specText, planText = '', phaseKeys = null, root, tests = {} }) {
  const specPhases = parseSpecPhases(specText);
  const planPhases = parsePlanPhases(planText);
  const keys = phaseKeys ?? [...new Set(planPhases.filter((p) => p.ticked).map((p) => p.key))];
  const layers = layersConfigured(tests.layers) ? tests.layers : null;
  const ctx = { root, layers, files: listTestFiles(root, tests), cache: new Map() };
  const phases = [];
  const unknownPhases = [];
  for (const key of keys) {
    const phase = findSpecPhase(specPhases, key);
    const planLine = planPhases.find((p) => p.key === key)?.line ?? null;
    if (!phase) { unknownPhases.push(key); continue; }
    const rows = phase.rows.map((row) => ({ specLine: row.line, tag: row.tag, name: row.name, ...judgeRow(row, ctx) }));
    const findings = rows.filter((r) => !r.ok).map((r) => ({
      phase: phase.key, phaseTitle: phase.title, planLine, specLine: r.specLine, tag: r.tag, name: r.name, kind: r.kind, message: r.message,
      tests: r.tests.map((t) => `${t.file}:${t.line}`),
    }));
    phases.push({ key: phase.key, title: phase.title, specLine: phase.line, planLine, rows, findings });
  }
  return { phases, findings: phases.flatMap((p) => p.findings), unknownPhases, layerCheck: Boolean(layers) };
}

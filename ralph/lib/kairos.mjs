// The Kairos tracker: the driver, not the agent, tells Kairos what the loop is doing, and asks it before each step
// whether the loop may go on. So a stop, a pause or a cap holds whatever the agent does, and nothing depends on a prompt.
//
//   KAIROS_URL (or tracker.kairos.url)   where Kairos's runner endpoints are
//   KAIROS_RUN_TOKEN                     a run key: for one item, made by a person on its Build tab
//
// Reading the controls: refused at the start if it cannot be read. Later, the last answer stands through a failed read,
// and three failed reads in a row end the run, so a stop placed in Kairos holds within a few steps however the network
// behaves. Reporting never blocks the work: what could not be sent is kept and sent with the next report, and each
// report is safe to send twice.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WORTH_RETRYING = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
export const MAX_FAILED_READS = 3;

/** Where Kairos is and the key to use, from the environment and config. */
export function kairosSettings(cfg, env = process.env) {
  const url = String(env.KAIROS_URL || cfg?.tracker?.kairos?.url || '').replace(/\/+$/, '');
  return { url, token: env.KAIROS_RUN_TOKEN || '' };
}

/** What is missing before a run can use Kairos, or null. */
export function kairosProblem({ url, token }) {
  if (!url) return 'set KAIROS_URL (or tracker.kairos.url in ralph.config.json) to where Kairos is';
  if (!/^https?:\/\//.test(url)) return `KAIROS_URL "${url}" is not an address`;
  if (!token) return "KAIROS_RUN_TOKEN is not set: the item's owner makes a key on its Build tab in Kairos";
  return null;
}

/** A client for one item. `fetchImpl` and `wait` are for tests. */
export function createKairos({ url, token, item, fetchImpl = globalThis.fetch, wait = sleep, retryMs = 1000, timeoutMs = 45000, onLost = () => {} }) {
  const call = async (method, path, body, attempts) => {
    let last = { ok: false, status: 0, retry: true, message: 'Kairos could not be reached' };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let delay = 2 ** attempt * retryMs;
      try {
        const res = await fetchImpl(`${url}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return { ok: true, status: res.status, data };
        last = { ok: false, status: res.status, retry: WORTH_RETRYING.has(res.status), message: data.message || `Kairos answered ${res.status}` };
        if (!last.retry) return last;
        const after = Number(res.headers.get('retry-after'));
        if (after > 0) delay = Math.min(after, 30) * retryMs;
      } catch (e) {
        last = { ok: false, status: 0, retry: true, message: `Kairos could not be reached: ${e?.message || e}` };
      }
      if (attempt < attempts) await wait(delay);
    }
    return last;
  };

  const queue = [];
  /** Sends everything waiting, in order, stopping at the first that is worth trying again later. */
  const flush = async () => {
    let answer = null;
    while (queue.length) {
      const r = await call('POST', '/run/events', queue[0], 3);
      if (!r.ok && r.retry) return { sent: answer, failed: r };
      queue.shift();
      if (r.ok) answer = r.data;
      else onLost(queue, r);
    }
    return { sent: answer, failed: null };
  };

  return {
    controls: (mode) => call('GET', `/run/controls?item=${encodeURIComponent(item)}&mode=${encodeURIComponent(mode)}`, null, 5),
    /** Reports one event, with any still waiting. Never throws. */
    report: async (event) => {
      queue.push(event);
      return flush();
    },
    flush,
    pending: () => queue.length,
  };
}

const lower = (...values) => {
  const set = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return set.length ? Math.min(...set) : null;
};

/** The caps in force: the lower of this repository's and Kairos's. Kairos can only ever lower them. An iteration may
 *  also spend no more than the item has left. */
export function capsWithKairos(budget, caps) {
  if (!caps) return budget;
  return {
    iterationUsd: lower(budget.iterationUsd, caps.iterationUsd, caps.remainingUsd),
    runUsd: lower(budget.runUsd, caps.runUsd),
    dayUsd: budget.dayUsd,
  };
}

/** Why the run stops, from what Kairos said. */
export const stopReasonFor = (code) => (code === 'over-cap' ? 'budget_item' : 'kairos_stop');

/** The plan's open questions for a person, for the one answering to read. */
export function productQuestions(planText) {
  const out = [];
  let inside = false;
  for (const line of String(planText || '').split(/\r?\n/)) {
    if (/^##\s/.test(line)) inside = /^##\s+Open Questions/i.test(line);
    else if (inside && /^\s*-\s*\[ \]/.test(line) && !/\[tooling\]/.test(line)) out.push(line.trim().replace(/^-\s*\[ \]\s*/, '- '));
  }
  return out;
}

/** What a person answered, for the prompt. */
export function answersBlock(answers) {
  if (!answers?.length) return '';
  return answers.map((a) => `- **${a.question}** ${a.choice ?? ''}${a.note ? ` (${a.note})` : ''}`.trim()).join('\n');
}

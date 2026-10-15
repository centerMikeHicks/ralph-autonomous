// Detects that an iteration ended on the account's usage limit and when it lifts.
//
// Two independent signals, because either can be absent:
//   - a `rate_limit_event` with status rejected/blocked carries `resetsAt` (epoch seconds, or
//     milliseconds on some builds);
//   - the final error text says "...hit your session limit - resets 9:10pm".
// A failure for any other reason returns null: a real failure must not become a silent sleep.

const FALLBACK_WAIT_MS = 15 * 60 * 1000;

/** Epoch seconds or milliseconds -> Date. */
export function epochToDate(value) {
  let n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 100000000000) n /= 1000;
  return new Date(Math.round(n * 1000));
}

/**
 * Parse "resets 9:10pm" / "resets 09:10" / "resets 9pm" into the next occurrence at or after
 * `now` (today, or tomorrow when that time has passed). Local time. Null when no time is found.
 */
export function parseResetText(text, now = new Date()) {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(text));
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3] ? m[3].toLowerCase() : '';
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() < now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function inspectEvent(obj) {
  const type = obj && obj.type;
  if (type === 'rate_limit_event') {
    const info = obj.rate_limit_info || obj;
    const status = String(info.status || obj.status || '');
    if (!/^(rejected|blocked)$/.test(status)) return { limited: false };
    const resets = info.resetsAt ?? obj.resetsAt;
    return { limited: true, resetsAt: resets != null ? epochToDate(resets) : null };
  }
  const isErrorResult = type === 'result' && obj.is_error;
  const isRateAssistant = type === 'assistant' && /rate_limit/.test(String(obj.error || ''));
  if (isErrorResult || isRateAssistant) {
    const text = JSON.stringify(obj);
    if (/hit your (session|usage) limit|rate_limit|usage limit/i.test(text)) return { limited: true, text };
  }
  return { limited: false };
}

/**
 * @param {string[]} lines transcript lines (stream-json, one event per line)
 * @param {Date} now
 * @returns {Date|null} when the limit lifts; null when the iteration was not usage-limited.
 *   A limited iteration with no stated time resolves to now + 15 minutes.
 */
export function usageLimitReset(lines, now = new Date()) {
  let limited = false;
  let reset = null;
  for (const raw of lines) {
    if (!raw || !/limit/i.test(raw)) continue;
    let obj = null;
    try {
      obj = JSON.parse(raw);
    } catch {
      // A line truncated mid-event: fall back to its text.
      if (/hit your (session|usage) limit/i.test(raw)) {
        limited = true;
        reset = reset || parseResetText(raw, now);
      }
      continue;
    }
    const found = inspectEvent(obj);
    if (!found.limited) continue;
    limited = true;
    if (found.resetsAt) reset = found.resetsAt;
    else if (!reset && found.text) reset = parseResetText(found.text, now);
  }
  if (!limited) return null;
  return reset || new Date(now.getTime() + FALLBACK_WAIT_MS);
}

/**
 * Seconds to sleep for a reset time: until the reset plus a buffer, never below minWaitS (a
 * reset already in the past still deserves a pause) and never above maxWaitS (beyond six
 * hours the parse is more likely wrong than the wait is right).
 */
export function waitSeconds(reset, now = new Date(), { bufferS = 30, minWaitS = 60, maxWaitS = 21600 } = {}) {
  const raw = Math.ceil((reset.getTime() - now.getTime()) / 1000) + bufferS;
  return Math.min(maxWaitS, Math.max(minWaitS, raw));
}

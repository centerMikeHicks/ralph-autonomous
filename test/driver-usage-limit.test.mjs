import test from 'node:test';
import assert from 'node:assert/strict';
import { usageLimitReset, parseResetText, waitSeconds, epochToDate } from '../ralph/lib/usage-limit.mjs';

// A fixed local "now": 2026-03-10 20:00 local time.
const NOW = new Date(2026, 2, 10, 20, 0, 0, 0);
const ev = (o) => JSON.stringify(o);

test('epoch seconds in resetsAt', () => {
  const secs = Math.floor(NOW.getTime() / 1000) + 3600;
  const lines = [ev({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: secs } })];
  assert.equal(usageLimitReset(lines, NOW).getTime(), secs * 1000);
});

test('epoch milliseconds in resetsAt', () => {
  const ms = NOW.getTime() + 7200_000;
  const lines = [ev({ type: 'rate_limit_event', rate_limit_info: { status: 'blocked', resetsAt: ms } })];
  assert.equal(usageLimitReset(lines, NOW).getTime(), ms);
  assert.equal(epochToDate(ms).getTime(), ms);
});

test('"resets 9:10pm" later today and rolled to tomorrow when passed', () => {
  const today = parseResetText("You've hit your session limit · resets 9:10pm", NOW);
  assert.deepEqual([today.getDate(), today.getHours(), today.getMinutes()], [10, 21, 10]);
  const tomorrow = parseResetText('resets 7:30am', NOW);
  assert.deepEqual([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()], [11, 7, 30]);
});

test('12am, 12pm, 24-hour and bare-hour forms', () => {
  assert.equal(parseResetText('resets 12am', NOW).getHours(), 0);
  assert.equal(parseResetText('resets 12pm', NOW).getDate(), 11); // 12:00 already passed at 20:00
  assert.equal(parseResetText('resets 22:15', NOW).getHours(), 22);
  assert.equal(parseResetText('resets 9pm', NOW).getHours(), 21);
  assert.equal(parseResetText('resets 99:99', NOW), null);
  assert.equal(parseResetText('nothing here', NOW), null);
});

test('text-only signal in an error result event', () => {
  const lines = [ev({ type: 'result', is_error: true, result: "You've hit your session limit · resets 9:10pm" })];
  const r = usageLimitReset(lines, NOW);
  assert.equal(r.getHours(), 21);
  assert.equal(r.getMinutes(), 10);
});

test('limited with no reset time falls back to now + 15 minutes', () => {
  const lines = [ev({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })];
  assert.equal(usageLimitReset(lines, NOW).getTime(), NOW.getTime() + 15 * 60 * 1000);
  const textOnly = [ev({ type: 'result', is_error: true, result: 'You hit your usage limit' })];
  assert.equal(usageLimitReset(textOnly, NOW).getTime(), NOW.getTime() + 15 * 60 * 1000);
});

test('a truncated non-JSON line still counts through its text', () => {
  const r = usageLimitReset(['{"type":"result","is_error":true,"result":"hit your session limit - resets 11:45pm', 'x'], NOW);
  assert.equal(r.getHours(), 23);
});

test('not limited: allowed events, ordinary failures and chatter mentioning limits', () => {
  assert.equal(usageLimitReset([ev({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1 } })], NOW), null);
  assert.equal(usageLimitReset([ev({ type: 'result', is_error: true, result: 'compile error' })], NOW), null);
  assert.equal(usageLimitReset([ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'the rate_limit_event handler hit your usage limit docs' }] } })], NOW), null);
  assert.equal(usageLimitReset([], NOW), null);
});

test('waitSeconds adds the buffer and clamps to [60 s, 6 h]', () => {
  assert.equal(waitSeconds(new Date(NOW.getTime() + 600_000), NOW), 630);
  assert.equal(waitSeconds(new Date(NOW.getTime() - 5000), NOW), 60);
  assert.equal(waitSeconds(new Date(NOW.getTime() + 30 * 3600_000), NOW), 21600);
  assert.equal(waitSeconds(new Date(NOW.getTime() + 1000), NOW, { bufferS: 0, minWaitS: 0 }), 1);
});

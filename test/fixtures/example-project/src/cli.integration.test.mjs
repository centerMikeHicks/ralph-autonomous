import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './cli.mjs';

test('cliPrintsGreeting: Given an argument, When the CLI runs, Then the greeting is written', () => {
  let out = '';
  const code = run(['Ada'], (s) => { out += s; });
  assert.equal(code, 0);
  assert.equal(out, 'Hello, Ada!\n');
});

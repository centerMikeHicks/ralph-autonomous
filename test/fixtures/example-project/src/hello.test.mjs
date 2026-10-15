import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGreeting } from './hello.mjs';

test('greetsByName: Given a name, When formatting, Then the name is greeted', () => {
  assert.equal(formatGreeting('Ada'), 'Hello, Ada!');
});

test('greetsTheWorldWithoutName', () => {
  assert.equal(formatGreeting(''), 'Hello, world!');
});

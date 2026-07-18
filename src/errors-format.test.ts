import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatFatal } from './errors.js';

test('formatFatal: message + debug hint, no stack, by default', () => {
  const out = formatFatal(new Error('db path invalid'), false);
  assert.match(out, /^relay: db path invalid\n/);
  assert.match(out, /RELAY_DEBUG=1/);
  assert.doesNotMatch(out, /at /);
});

test('formatFatal: includes stack when debug is on', () => {
  const out = formatFatal(new Error('boom'), true);
  assert.match(out, /^relay: boom\n/);
  assert.match(out, /at /);
  assert.doesNotMatch(out, /RELAY_DEBUG=1/);
});

test('formatFatal: wraps non-Error throwables', () => {
  const out = formatFatal('plain string failure', false);
  assert.match(out, /^relay: plain string failure\n/);
});

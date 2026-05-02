import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { amendSignOffSchema } from './amend_sign_off.js';

test('valid payload succeeds', () => {
  const result = amendSignOffSchema.safeParse({
    run_id: 'r1',
    new_notes: 'fixed',
    amended_by: 'alice',
  });
  assert.strictEqual(result.success, true);
});

test('run_id empty string fails', () => {
  const result = amendSignOffSchema.safeParse({
    run_id: '',
    new_notes: 'fixed',
    amended_by: 'alice',
  });
  assert.strictEqual(result.success, false);
});

test('new_notes empty string fails', () => {
  const result = amendSignOffSchema.safeParse({
    run_id: 'r1',
    new_notes: '',
    amended_by: 'alice',
  });
  assert.strictEqual(result.success, false);
});

test('amended_by empty string fails', () => {
  const result = amendSignOffSchema.safeParse({
    run_id: 'r1',
    new_notes: 'fixed',
    amended_by: '',
  });
  assert.strictEqual(result.success, false);
});

test('run_id missing fails', () => {
  const result = amendSignOffSchema.safeParse({
    new_notes: 'fixed',
    amended_by: 'alice',
  });
  assert.strictEqual(result.success, false);
});

test('new_notes missing fails', () => {
  const result = amendSignOffSchema.safeParse({
    run_id: 'r1',
    amended_by: 'alice',
  });
  assert.strictEqual(result.success, false);
});

test('amended_by missing fails', () => {
  const result = amendSignOffSchema.safeParse({
    run_id: 'r1',
    new_notes: 'fixed',
  });
  assert.strictEqual(result.success, false);
});

test('extra field is stripped (parse succeeds)', () => {
  const result = amendSignOffSchema.safeParse({
    run_id: 'r1',
    new_notes: 'fixed',
    amended_by: 'alice',
    extra_field: 'should be removed',
  });
  assert.strictEqual(result.success, true);
});

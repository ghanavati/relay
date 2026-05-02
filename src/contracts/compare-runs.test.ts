import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompareRunsArgsSchema } from './compare-runs.js';

test('two valid UUIDs succeeds', () => {
  const result = CompareRunsArgsSchema.safeParse({
    run_ids: ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
  });
  assert.strictEqual(result.success, true);
});

test('three valid UUIDs succeeds', () => {
  const result = CompareRunsArgsSchema.safeParse({
    run_ids: [
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003',
    ],
  });
  assert.strictEqual(result.success, true);
});

test('only one UUID fails (min 2)', () => {
  const result = CompareRunsArgsSchema.safeParse({
    run_ids: ['00000000-0000-0000-0000-000000000001'],
  });
  assert.strictEqual(result.success, false);
});

test('empty array fails (min 2)', () => {
  const result = CompareRunsArgsSchema.safeParse({
    run_ids: [],
  });
  assert.strictEqual(result.success, false);
});

test('non-UUID string in array fails', () => {
  const result = CompareRunsArgsSchema.safeParse({
    run_ids: ['not-a-uuid', '00000000-0000-0000-0000-000000000002'],
  });
  assert.strictEqual(result.success, false);
});

test('run_ids missing fails', () => {
  const result = CompareRunsArgsSchema.safeParse({});
  assert.strictEqual(result.success, false);
});

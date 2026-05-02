import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowseRunsArgsSchema } from './browse_runs.js';

test('empty object succeeds; default limit=50', () => {
  const result = BrowseRunsArgsSchema.safeParse({});
  assert.strictEqual(result.success, true);
  if (result.success) {
    assert.strictEqual(result.data.limit, 50);
  }
});

test("all valid statuses ('queued','running','success','error') succeed", () => {
  const statuses = ['queued', 'running', 'success', 'error'];
  for (const status of statuses) {
    const result = BrowseRunsArgsSchema.safeParse({ status });
    assert.strictEqual(result.success, true);
  }
});

test('invalid status fails', () => {
  const result = BrowseRunsArgsSchema.safeParse({ status: 'invalid' as never });
  assert.strictEqual(result.success, false);
});

test('limit=1 succeeds (min boundary)', () => {
  const result = BrowseRunsArgsSchema.safeParse({ limit: 1 });
  assert.strictEqual(result.success, true);
});

test('limit=200 succeeds (max boundary)', () => {
  const result = BrowseRunsArgsSchema.safeParse({ limit: 200 });
  assert.strictEqual(result.success, true);
});

test('limit=0 fails', () => {
  const result = BrowseRunsArgsSchema.safeParse({ limit: 0 });
  assert.strictEqual(result.success, false);
});

test('limit=201 fails', () => {
  const result = BrowseRunsArgsSchema.safeParse({ limit: 201 });
  assert.strictEqual(result.success, false);
});

test("valid verification_status 'approved' succeeds", () => {
  const result = BrowseRunsArgsSchema.safeParse({ verification_status: 'approved' });
  assert.strictEqual(result.success, true);
});

test("valid verification_status 'rejected' succeeds", () => {
  const result = BrowseRunsArgsSchema.safeParse({ verification_status: 'rejected' });
  assert.strictEqual(result.success, true);
});

test('invalid verification_status fails', () => {
  const result = BrowseRunsArgsSchema.safeParse({ verification_status: 'invalid' as never });
  assert.strictEqual(result.success, false);
});

test('since=negative fails (must be positive)', () => {
  const result = BrowseRunsArgsSchema.safeParse({ since: -1 });
  assert.strictEqual(result.success, false);
});

test('include_archived:true succeeds', () => {
  const result = BrowseRunsArgsSchema.safeParse({ include_archived: true });
  assert.strictEqual(result.success, true);
});

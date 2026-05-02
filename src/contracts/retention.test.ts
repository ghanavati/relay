import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { runRetentionSchema, listRetentionEventsSchema } from './retention.js';

// ── runRetentionSchema tests ────────────────────────────────────────

test('runRetentionSchema parses empty object with default dry_run', () => {
  const result = runRetentionSchema.parse({});
  assert.equal(result.dry_run, false);
});

test('runRetentionSchema accepts dry_run: true', () => {
  const result = runRetentionSchema.parse({ dry_run: true });
  assert.equal(result.dry_run, true);
});

test('runRetentionSchema accepts dry_run: false', () => {
  const result = runRetentionSchema.parse({ dry_run: false });
  assert.equal(result.dry_run, false);
});

test('runRetentionSchema rejects non-boolean dry_run', () => {
  assert.throws(
    () => runRetentionSchema.parse({ dry_run: 'yes' }),
    (err) => err instanceof z.ZodError,
  );
});

// ── listRetentionEventsSchema tests ─────────────────────────────────

test('listRetentionEventsSchema parses empty object with default limit', () => {
  const result = listRetentionEventsSchema.parse({});
  assert.equal(result.limit, 50);
});

test('listRetentionEventsSchema accepts valid limit within range', () => {
  const result = listRetentionEventsSchema.parse({ limit: 10 });
  assert.equal(result.limit, 10);
});

test('listRetentionEventsSchema accepts boundary values (min=1)', () => {
  const result = listRetentionEventsSchema.parse({ limit: 1 });
  assert.equal(result.limit, 1);
});

test('listRetentionEventsSchema accepts boundary value (max=200)', () => {
  const result = listRetentionEventsSchema.parse({ limit: 200 });
  assert.equal(result.limit, 200);
});

test('listRetentionEventsSchema rejects limit below minimum', () => {
  assert.throws(
    () => listRetentionEventsSchema.parse({ limit: 0 }),
    (err) => err instanceof z.ZodError,
  );
});

test('listRetentionEventsSchema rejects limit above maximum', () => {
  assert.throws(
    () => listRetentionEventsSchema.parse({ limit: 201 }),
    (err) => err instanceof z.ZodError,
  );
});

test('listRetentionEventsSchema rejects non-integer limit', () => {
  assert.throws(
    () => listRetentionEventsSchema.parse({ limit: 3.5 }),
    (err) => err instanceof z.ZodError,
  );
});

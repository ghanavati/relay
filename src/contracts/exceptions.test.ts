import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { logExceptionSchema, listExceptionsSchema, resolveExceptionSchema, ExceptionSeveritySchema } from './exceptions.js';

// ── ExceptionSeveritySchema ───────────────────────────────────────────────────

test('ExceptionSeveritySchema accepts valid severity values', () => {
  assert.equal(ExceptionSeveritySchema.parse('critical'), 'critical');
  assert.equal(ExceptionSeveritySchema.parse('high'), 'high');
  assert.equal(ExceptionSeveritySchema.parse('medium'), 'medium');
  assert.equal(ExceptionSeveritySchema.parse('low'), 'low');
});

test('ExceptionSeveritySchema rejects invalid severity values', () => {
  const invalidValues = ['critical ', 'HIGH', '', 'medium-low', null, undefined, 123];
  for (const val of invalidValues) {
    assert.throws(() => ExceptionSeveritySchema.parse(val));
  }
});

// ── logExceptionSchema ────────────────────────────────────────────────────────

test('logExceptionSchema accepts a complete valid payload', () => {
  const result = logExceptionSchema.parse({
    model_id: 'model-123',
    description: 'Used outside approved boundaries for testing',
    approver_id: 'approver-456',
    compensating_control: 'Manual review gate',
    severity: 'high',
    resolution_deadline: 1700000000,
  });
  assert.equal(result.model_id, 'model-123');
  assert.equal(result.severity, 'high');
  assert.equal(result.resolution_deadline, 1700000000);
});

test('logExceptionSchema omits resolution_deadline when not provided', () => {
  const result = logExceptionSchema.parse({
    model_id: 'model-abc',
    description: 'Some out-of-boundary action',
    approver_id: 'approver-xyz',
    compensating_control: 'Audit logging enabled',
    severity: 'medium',
  });
  assert.equal(result.resolution_deadline, undefined);
});

test('logExceptionSchema rejects missing required fields', () => {
  const partial = { model_id: 'm1', description: 'desc' };
  assert.throws(() => logExceptionSchema.parse(partial));
});

test('logExceptionSchema rejects empty strings for required fields', () => {
  assert.throws(() => logExceptionSchema.parse({
    model_id: '',
    description: 'desc',
    approver_id: 'a1',
    compensating_control: 'ctrl',
    severity: 'low' as z.infer<typeof ExceptionSeveritySchema>,
  }));
});

test('logExceptionSchema rejects non-integer resolution_deadline', () => {
  assert.throws(() => logExceptionSchema.parse({
    model_id: 'm1',
    description: 'desc',
    approver_id: 'a1',
    compensating_control: 'ctrl',
    severity: 'low' as z.infer<typeof ExceptionSeveritySchema>,
    resolution_deadline: 3.14,
  }));
});

test('logExceptionSchema rejects negative resolution_deadline', () => {
  assert.throws(() => logExceptionSchema.parse({
    model_id: 'm1',
    description: 'desc',
    approver_id: 'a1',
    compensating_control: 'ctrl',
    severity: 'low' as z.infer<typeof ExceptionSeveritySchema>,
    resolution_deadline: -100,
  }));
});

// ── listExceptionsSchema ──────────────────────────────────────────────────────

test('listExceptionsSchema accepts empty object with defaults', () => {
  const result = listExceptionsSchema.parse({});
  assert.equal(result.include_resolved, false);
  assert.equal(result.limit, 100);
  assert.equal(result.model_id, undefined);
});

test('listExceptionsSchema respects provided options', () => {
  const result = listExceptionsSchema.parse({
    model_id: 'model-789',
    include_resolved: true,
    limit: 50,
  });
  assert.equal(result.model_id, 'model-789');
  assert.equal(result.include_resolved, true);
  assert.equal(result.limit, 50);
});

test('listExceptionsSchema rejects limit below minimum', () => {
  assert.throws(() => listExceptionsSchema.parse({ limit: 0 }));
});

test('listExceptionsSchema rejects limit above maximum', () => {
  assert.throws(() => listExceptionsSchema.parse({ limit: 501 }));
});

// ── resolveExceptionSchema ────────────────────────────────────────────────────

test('resolveExceptionSchema accepts a complete valid payload', () => {
  const result = resolveExceptionSchema.parse({
    exception_id: 'exc-001',
    resolved_by: 'resolver-999',
    resolution_notes: 'Fixed by updating boundary config',
  });
  assert.equal(result.exception_id, 'exc-001');
  assert.equal(result.resolved_by, 'resolver-999');
});

test('resolveExceptionSchema rejects missing required fields', () => {
  const partial = { exception_id: 'e1' };
  assert.throws(() => resolveExceptionSchema.parse(partial));
});

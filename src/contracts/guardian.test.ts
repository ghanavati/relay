import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { GuardianTypeSchema, SeveritySchema, AutoActionSchema, QualityStatusSchema } from './guardian.js';

// ── GuardianTypeSchema tests ──────────────────────────────────────────────────

test('GuardianTypeSchema accepts all valid enum values', () => {
  const validValues = ['security', 'performance', 'integrity', 'shadow_audit', 'supervisor_sensitivity', 'reasoning_density'] as const;
  for (const value of validValues) {
    assert.equal(GuardianTypeSchema.parse(value), value);
  }
});

test('GuardianTypeSchema rejects invalid values', () => {
  assert.throws(() => GuardianTypeSchema.parse('invalid'), z.ZodError);
  assert.throws(() => GuardianTypeSchema.parse('SECURITY'), z.ZodError);
  assert.throws(() => GuardianTypeSchema.parse(123), z.ZodError);
});

// ── SeveritySchema tests ──────────────────────────────────────────────────────

test('SeveritySchema accepts all valid enum values', () => {
  const validValues = ['info', 'warning', 'critical'] as const;
  for (const value of validValues) {
    assert.equal(SeveritySchema.parse(value), value);
  }
});

test('SeveritySchema rejects invalid values', () => {
  assert.throws(() => SeveritySchema.parse('error'), z.ZodError);
  assert.throws(() => SeveritySchema.parse('fatal'), z.ZodError);
  assert.throws(() => SeveritySchema.parse(true), z.ZodError);
});

// ── AutoActionSchema tests ────────────────────────────────────────────────────

test('AutoActionSchema accepts all valid enum values', () => {
  const validValues = ['none', 'alert', 'abort'] as const;
  for (const value of validValues) {
    assert.equal(AutoActionSchema.parse(value), value);
  }
});

test('AutoActionSchema rejects invalid values', () => {
  assert.throws(() => AutoActionSchema.parse('notify'), z.ZodError);
  assert.throws(() => AutoActionSchema.parse('pause'), z.ZodError);
  assert.throws(() => AutoActionSchema.parse(null), z.ZodError);
});

// ── QualityStatusSchema tests ─────────────────────────────────────────────────

test('QualityStatusSchema accepts all valid enum values', () => {
  const validValues = ['done', 'done_with_concerns', 'needs_context', 'blocked'] as const;
  for (const value of validValues) {
    assert.equal(QualityStatusSchema.parse(value), value);
  }
});

test('QualityStatusSchema rejects invalid values', () => {
  assert.throws(() => QualityStatusSchema.parse('pending'), z.ZodError);
  assert.throws(() => QualityStatusSchema.parse('in_progress'), z.ZodError);
  assert.throws(() => QualityStatusSchema.parse(0), z.ZodError);
});

// ── Cross-schema integration tests ────────────────────────────────────────────

test('GuardianTypeSchema and SeveritySchema work together in a union', () => {
  const combined = z.object({ type: GuardianTypeSchema, severity: SeveritySchema });
  assert.deepEqual(combined.parse({ type: 'security', severity: 'critical' }), {
    type: 'security',
    severity: 'critical',
  });
});

test('All four schemas can be composed in a single object schema', () => {
  const policy = z.object({
    guardian_type: GuardianTypeSchema,
    severity: SeveritySchema,
    auto_action: AutoActionSchema,
    quality_status: QualityStatusSchema,
  });
  assert.deepEqual(policy.parse({
    guardian_type: 'integrity',
    severity: 'warning',
    auto_action: 'alert',
    quality_status: 'done_with_concerns',
  }), {
    guardian_type: 'integrity',
    severity: 'warning',
    auto_action: 'alert',
    quality_status: 'done_with_concerns',
  });
});

test('GuardianTypeSchema preserves string literal types after parse', () => {
  const result = GuardianTypeSchema.parse('shadow_audit');
  assert.equal(typeof result, 'string');
  assert.equal(result, 'shadow_audit');
});

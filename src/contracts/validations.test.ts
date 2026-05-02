import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { ValidationStatusSchema, FindingSeveritySchema } from './validations.js';

// ── ValidationStatusSchema tests ──────────────────────────────────────────────

test('ValidationStatusSchema accepts "planned"', () => {
  const result = ValidationStatusSchema.parse('planned');
  assert.equal(result, 'planned');
});

test('ValidationStatusSchema accepts "in-progress"', () => {
  const result = ValidationStatusSchema.parse('in-progress');
  assert.equal(result, 'in-progress');
});

test('ValidationStatusSchema accepts "complete"', () => {
  const result = ValidationStatusSchema.parse('complete');
  assert.equal(result, 'complete');
});

test('ValidationStatusSchema accepts "cancelled"', () => {
  const result = ValidationStatusSchema.parse('cancelled');
  assert.equal(result, 'cancelled');
});

test('ValidationStatusSchema rejects invalid status', () => {
  assert.throws(() => ValidationStatusSchema.parse('invalid'), z.ZodError);
});

// ── FindingSeveritySchema tests ───────────────────────────────────────────────

test('FindingSeveritySchema accepts "critical"', () => {
  const result = FindingSeveritySchema.parse('critical');
  assert.equal(result, 'critical');
});

test('FindingSeveritySchema accepts "high"', () => {
  const result = FindingSeveritySchema.parse('high');
  assert.equal(result, 'high');
});

test('FindingSeveritySchema accepts "medium"', () => {
  const result = FindingSeveritySchema.parse('medium');
  assert.equal(result, 'medium');
});

test('FindingSeveritySchema accepts "low"', () => {
  const result = FindingSeveritySchema.parse('low');
  assert.equal(result, 'low');
});

test('FindingSeveritySchema rejects invalid severity', () => {
  assert.throws(() => FindingSeveritySchema.parse('trivial'), z.ZodError);
});

// ── Schema shape tests ────────────────────────────────────────────────────────

test('ValidationStatusSchema has exactly four valid values', () => {
  const validValues = ['planned', 'in-progress', 'complete', 'cancelled'];
  for (const value of validValues) {
    assert.equal(ValidationStatusSchema.parse(value), value);
  }
});

test('FindingSeveritySchema has exactly four valid values', () => {
  const validValues = ['critical', 'high', 'medium', 'low'];
  for (const value of validValues) {
    assert.equal(FindingSeveritySchema.parse(value), value);
  }
});

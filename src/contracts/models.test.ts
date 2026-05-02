import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RiskTierSchema, ModelStatusSchema, ModelOriginSchema, ModelTypeSchema,
  RegisterModelArgsSchema, ListModelsArgsSchema, UpdateModelStatusArgsSchema
} from './models.js';

// ── RiskTierSchema ─────────────────────────────────────────────────────────────

test('RiskTierSchema — all 4 valid values succeed', () => {
  assert.strictEqual(RiskTierSchema.parse('high'), 'high');
  assert.strictEqual(RiskTierSchema.parse('medium'), 'medium');
  assert.strictEqual(RiskTierSchema.parse('low'), 'low');
  assert.strictEqual(RiskTierSchema.parse('informational'), 'informational');
});

test('RiskTierSchema — invalid value fails', () => {
  const result = RiskTierSchema.safeParse('critical');
  assert.strictEqual(result.success, false);
});

// ── ModelStatusSchema ──────────────────────────────────────────────────────────

test('ModelStatusSchema — all 4 valid values succeed', () => {
  assert.strictEqual(ModelStatusSchema.parse('in-development'), 'in-development');
  assert.strictEqual(ModelStatusSchema.parse('deployed'), 'deployed');
  assert.strictEqual(ModelStatusSchema.parse('retired'), 'retired');
  assert.strictEqual(ModelStatusSchema.parse('decommissioned'), 'decommissioned');
});

test('ModelStatusSchema — invalid value fails', () => {
  const result = ModelStatusSchema.safeParse('active');
  assert.strictEqual(result.success, false);
});

// ── ModelOriginSchema ──────────────────────────────────────────────────────────

test('ModelOriginSchema — all 4 valid values succeed', () => {
  assert.strictEqual(ModelOriginSchema.parse('in-house'), 'in-house');
  assert.strictEqual(ModelOriginSchema.parse('vendor'), 'vendor');
  assert.strictEqual(ModelOriginSchema.parse('open-source'), 'open-source');
  assert.strictEqual(ModelOriginSchema.parse('third-party'), 'third-party');
});

// ── ModelTypeSchema ────────────────────────────────────────────────────────────

test('ModelTypeSchema — all 5 valid values succeed', () => {
  assert.strictEqual(ModelTypeSchema.parse('llm'), 'llm');
  assert.strictEqual(ModelTypeSchema.parse('onnx'), 'onnx');
  assert.strictEqual(ModelTypeSchema.parse('r-script'), 'r-script');
  assert.strictEqual(ModelTypeSchema.parse('python-script'), 'python-script');
  assert.strictEqual(ModelTypeSchema.parse('vendor-api'), 'vendor-api');
});

// ── RegisterModelArgsSchema ────────────────────────────────────────────────────

test('RegisterModelArgsSchema — minimal input (name only) succeeds; defaults applied', () => {
  const result = RegisterModelArgsSchema.safeParse({ name: 'My Model' });
  assert.strictEqual(result.success, true);
  if (!result.success) return;
  assert.strictEqual(result.data.risk_tier, 'high');
  assert.deepStrictEqual(result.data.approved_uses, []);
  assert.deepStrictEqual(result.data.data_sources, []);
  assert.deepStrictEqual(result.data.dependencies, []);
});

test('RegisterModelArgsSchema — name empty string fails', () => {
  const result = RegisterModelArgsSchema.safeParse({ name: '' });
  assert.strictEqual(result.success, false);
});

test('RegisterModelArgsSchema — name over 200 chars fails', () => {
  const result = RegisterModelArgsSchema.safeParse({ name: 'a'.repeat(201) });
  assert.strictEqual(result.success, false);
});

test('RegisterModelArgsSchema — invalid risk_tier fails', () => {
  const result = RegisterModelArgsSchema.safeParse({ name: 'Test', risk_tier: 'critical' });
  assert.strictEqual(result.success, false);
});

test('RegisterModelArgsSchema — invalid origin fails', () => {
  const result = RegisterModelArgsSchema.safeParse({ name: 'Test', origin: 'internal' });
  assert.strictEqual(result.success, false);
});

test('RegisterModelArgsSchema — invalid obligation_role fails', () => {
  const result = RegisterModelArgsSchema.safeParse({ name: 'Test', obligation_role: 'consumer' });
  assert.strictEqual(result.success, false);
});

test('RegisterModelArgsSchema — invalid model_type fails', () => {
  const result = RegisterModelArgsSchema.safeParse({ name: 'Test', model_type: 'tensorflow' });
  assert.strictEqual(result.success, false);
});

// ── ListModelsArgsSchema ───────────────────────────────────────────────────────

test('ListModelsArgsSchema — empty object succeeds; default limit=100', () => {
  const result = ListModelsArgsSchema.safeParse({});
  assert.strictEqual(result.success, true);
  if (!result.success) return;
  assert.strictEqual(result.data.limit, 100);
});

test('ListModelsArgsSchema — invalid status fails', () => {
  const result = ListModelsArgsSchema.safeParse({ status: 'active' });
  assert.strictEqual(result.success, false);
});

test('ListModelsArgsSchema — limit=0 fails (min 1)', () => {
  const result = ListModelsArgsSchema.safeParse({ limit: 0 });
  assert.strictEqual(result.success, false);
});

test('ListModelsArgsSchema — limit=501 fails (max 500)', () => {
  const result = ListModelsArgsSchema.safeParse({ limit: 501 });
  assert.strictEqual(result.success, false);
});

// ── UpdateModelStatusArgsSchema ────────────────────────────────────────────────

test('UpdateModelStatusArgsSchema — valid input (model_id + status) succeeds', () => {
  const result = UpdateModelStatusArgsSchema.safeParse({
    model_id: 'abc123',
    status: 'deployed',
  });
  assert.strictEqual(result.success, true);
});

test('UpdateModelStatusArgsSchema — model_id empty fails', () => {
  const result = UpdateModelStatusArgsSchema.safeParse({ model_id: '', status: 'deployed' });
  assert.strictEqual(result.success, false);
});

test('UpdateModelStatusArgsSchema — invalid status fails', () => {
  const result = UpdateModelStatusArgsSchema.safeParse({ model_id: 'abc123', status: 'active' });
  assert.strictEqual(result.success, false);
});

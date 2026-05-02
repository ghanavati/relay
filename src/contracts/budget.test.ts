import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { BudgetScopeSchema, BudgetPeriodSchema, BudgetAlertLevelSchema, setBudgetLimitSchema, listBudgetLimitsSchema, listBudgetAlertsSchema } from './budget.js';

test('BudgetScopeSchema accepts valid enum values', () => {
  assert.equal(BudgetScopeSchema.parse('model'), 'model');
  assert.equal(BudgetScopeSchema.parse('owner'), 'owner');
  assert.equal(BudgetScopeSchema.parse('global'), 'global');
});

test('BudgetScopeSchema rejects invalid values', () => {
  assert.throws(() => BudgetScopeSchema.parse('invalid'), z.ZodError);
  assert.throws(() => BudgetScopeSchema.parse(123), z.ZodError);
  assert.throws(() => BudgetScopeSchema.parse(null as unknown as string), z.ZodError);
});

test('BudgetPeriodSchema accepts valid enum values', () => {
  assert.equal(BudgetPeriodSchema.parse('daily'), 'daily');
  assert.equal(BudgetPeriodSchema.parse('monthly'), 'monthly');
  assert.equal(BudgetPeriodSchema.parse('alltime'), 'alltime');
});

test('BudgetPeriodSchema rejects invalid values', () => {
  assert.throws(() => BudgetPeriodSchema.parse('weekly'), z.ZodError);
  assert.throws(() => BudgetPeriodSchema.parse('yearly'), z.ZodError);
});

test('BudgetAlertLevelSchema accepts valid enum values', () => {
  assert.equal(BudgetAlertLevelSchema.parse('warning'), 'warning');
  assert.equal(BudgetAlertLevelSchema.parse('exceeded'), 'exceeded');
});

test('BudgetAlertLevelSchema rejects invalid values', () => {
  assert.throws(() => BudgetAlertLevelSchema.parse('critical'), z.ZodError);
  assert.throws(() => BudgetAlertLevelSchema.parse('info'), z.ZodError);
});

test('setBudgetLimitSchema validates a complete valid payload', () => {
  const result = setBudgetLimitSchema.parse({
    scope: 'model',
    scope_value: 'gpt-4o',
    limit_usd: 50.0,
    period: 'monthly',
  });
  assert.equal(result.scope, 'model');
  assert.equal(result.scope_value, 'gpt-4o');
  assert.equal(result.limit_usd, 50.0);
  assert.equal(result.period, 'monthly');
});

test('setBudgetLimitSchema rejects negative limit_usd', () => {
  assert.throws(
    () => setBudgetLimitSchema.parse({ scope: 'model', scope_value: 'gpt-4o', limit_usd: -10, period: 'daily' }),
    z.ZodError,
  );
});

test('setBudgetLimitSchema rejects zero limit_usd', () => {
  assert.throws(
    () => setBudgetLimitSchema.parse({ scope: 'model', scope_value: 'gpt-4o', limit_usd: 0, period: 'daily' }),
    z.ZodError,
  );
});

test('setBudgetLimitSchema rejects empty scope_value', () => {
  assert.throws(
    () => setBudgetLimitSchema.parse({ scope: 'model', scope_value: '', limit_usd: 10, period: 'daily' }),
    z.ZodError,
  );
});

test('listBudgetLimitsSchema accepts empty object (all optional)', () => {
  const result = listBudgetLimitsSchema.parse({});
  assert.equal(result.scope, undefined);
  assert.equal(result.scope_value, undefined);
});

test('listBudgetLimitsSchema filters by scope and scope_value', () => {
  const result = listBudgetLimitsSchema.parse({ scope: 'owner', scope_value: 'alice' });
  assert.equal(result.scope, 'owner');
  assert.equal(result.scope_value, 'alice');
});

test('listBudgetAlertsSchema accepts empty object with default limit', () => {
  const result = listBudgetAlertsSchema.parse({});
  assert.equal(result.limit, 100); // default value
});

test('listBudgetAlertsSchema validates limit range boundaries', () => {
  assert.throws(() => listBudgetAlertsSchema.parse({ limit: 0 }), z.ZodError);
  assert.throws(() => listBudgetAlertsSchema.parse({ limit: 501 }), z.ZodError);
});

test('listBudgetAlertsSchema accepts valid boundary limits', () => {
  const minResult = listBudgetAlertsSchema.parse({ limit: 1 });
  assert.equal(minResult.limit, 1);
  const maxResult = listBudgetAlertsSchema.parse({ limit: 500 });
  assert.equal(maxResult.limit, 500);
});

test('listBudgetAlertsSchema rejects non-integer limit', () => {
  assert.throws(() => listBudgetAlertsSchema.parse({ limit: 3.14 }), z.ZodError);
});

test('listBudgetAlertsSchema accepts all optional filters together', () => {
  const result = listBudgetAlertsSchema.parse({
    scope: 'model',
    scope_value: 'claude-sonnet',
    level: 'exceeded',
    limit: 50,
  });
  assert.equal(result.scope, 'model');
  assert.equal(result.scope_value, 'claude-sonnet');
  assert.equal(result.level, 'exceeded');
  assert.equal(result.limit, 50);
});

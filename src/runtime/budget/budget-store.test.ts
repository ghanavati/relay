import { describe, test, before } from 'node:test';
import * as assert from 'node:assert/strict';

process.env['RELAY_DB_PATH'] = ':memory:';

describe('BudgetStore', () => {
  let BudgetStore: typeof import('./budget-store.js').BudgetStore;

  before(async () => {
    const mod = await import('./budget-store.js');
    BudgetStore = mod.BudgetStore;
  });

  test('setBudgetLimit returns a limit_id string', () => {
    const store = new BudgetStore();
    const id = store.setBudgetLimit({ scope: 'global', scope_value: 'all', limit_usd: 100, period: 'monthly' });
    assert.ok(typeof id === 'string');
    assert.ok(id.startsWith('bgt-'));
  });

  test('setBudgetLimit updates existing limit for same scope/period', () => {
    const store = new BudgetStore();
    const id1 = store.setBudgetLimit({ scope: 'model', scope_value: 'test-model', limit_usd: 10, period: 'daily' });
    const id2 = store.setBudgetLimit({ scope: 'model', scope_value: 'test-model', limit_usd: 20, period: 'daily' });
    assert.equal(id1, id2, 'upsert must return same limit_id');
    const limits = store.listBudgetLimits({ scope: 'model', scope_value: 'test-model' });
    assert.equal(limits.length, 1, 'should only have one limit row');
  });

  test('checkBudgets returns allowed=true when no limits set', () => {
    // Use a unique scope so no limits exist
    const store = new BudgetStore();
    const result = store.checkBudgets('unconstrained-model-' + Date.now());
    // No limits in DB scoped to this model — must be allowed
    assert.equal(result.allowed, true, 'no limits set → must be allowed');
  });

  test('recordAlert and listBudgetAlerts roundtrip', () => {
    const store = new BudgetStore();
    const scope_value = 'alert-scope-' + Date.now();
    const alertId = store.recordAlert({ scope: 'owner', scope_value, limit_usd: 50, current_usd: 45, pct_used: 0.9, level: 'warning', period: 'monthly' });
    assert.ok(alertId.startsWith('bga-'));
    const alerts = store.listBudgetAlerts({ scope: 'owner', scope_value, limit: 10 });
    assert.equal(alerts.length, 1);
  });
});

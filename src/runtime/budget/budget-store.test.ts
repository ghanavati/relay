import { describe, test, before, beforeEach } from 'node:test';
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

/**
 * BudgetStore.getUsage — v0.2 sibling to getCurrentCost. Sums cost_events by
 * optional provider / workdir / period filters. Returns a stable shape that
 * the CLI marshals into the --json envelope.
 *
 * IMPORTANT: getCurrentCost is intentionally left untouched (it powers
 * checkBudgets and any regression there cascades through every run). getUsage
 * is the new query surface; getCurrentCost may be consolidated in a future
 * refactor.
 */
describe('BudgetStore.getUsage — scoping by provider/workdir/period', () => {
  let BudgetStore: typeof import('./budget-store.js').BudgetStore;
  let getDb: typeof import('../store/db.js').getDb;

  before(async () => {
    const mod = await import('./budget-store.js');
    BudgetStore = mod.BudgetStore;
    const dbMod = await import('../store/db.js');
    getDb = dbMod.getDb;
  });

  /**
   * Seed five cost_events covering three providers and two workdirs.
   * Sums:
   *   total          = 1.33   (5 events)
   *   lmstudio       = 0.03   (2 events: /a 0.01 + /b 0.02)
   *   openrouter     = 0.30   (2 events: /a 0.10 + /b 0.20)
   *   anthropic      = 1.00   (1 event:  /a 1.00)
   *   workdir=/a     = 1.11   (3 events: lm 0.01 + or 0.10 + an 1.00)
   *   workdir=/b     = 0.22   (2 events: lm 0.02 + or 0.20)
   *   openrouter+/a  = 0.10   (1 event)
   */
  function seedCostEvents(): void {
    const db = getDb();
    db.prepare('DELETE FROM cost_events').run();
    const stmt = db.prepare(
      `INSERT INTO cost_events
         (run_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, workdir, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    const rows: [string, string, string, number, string, number][] = [
      ['run-1', 'lmstudio',   'qwen3',     0.01, '/a', now],
      ['run-2', 'lmstudio',   'qwen3',     0.02, '/b', now],
      ['run-3', 'openrouter', 'claude',    0.10, '/a', now],
      ['run-4', 'openrouter', 'claude',    0.20, '/b', now],
      ['run-5', 'anthropic',  'sonnet-4.6', 1.00, '/a', now],
    ];
    for (const [runId, provider, model, cost, workdir, ts] of rows) {
      stmt.run(runId, provider, model, 0, 0, 0, cost, workdir, ts);
    }
  }

  beforeEach(() => {
    seedCostEvents();
  });

  test('no filters → sums every row', () => {
    const store = new BudgetStore();
    const usage = store.getUsage({});
    assert.equal(usage.event_count, 5);
    assert.ok(Math.abs(usage.total_usd - 1.33) < 1e-9, `expected ~1.33, got ${usage.total_usd}`);
    assert.deepStrictEqual(usage.scope_filters, {
      provider: null,
      workdir: null,
      period: null,
    });
  });

  test('provider filter narrows to a single provider', () => {
    const store = new BudgetStore();
    const usage = store.getUsage({ provider: 'lmstudio' });
    assert.equal(usage.event_count, 2);
    assert.ok(Math.abs(usage.total_usd - 0.03) < 1e-9, `expected ~0.03, got ${usage.total_usd}`);
    assert.equal(usage.scope_filters.provider, 'lmstudio');
    assert.equal(usage.scope_filters.workdir, null);
  });

  test('workdir filter narrows to a single workdir', () => {
    const store = new BudgetStore();
    const usage = store.getUsage({ workdir: '/a' });
    assert.equal(usage.event_count, 3);
    assert.ok(Math.abs(usage.total_usd - 1.11) < 1e-9, `expected ~1.11, got ${usage.total_usd}`);
    assert.equal(usage.scope_filters.workdir, '/a');
    assert.equal(usage.scope_filters.provider, null);
  });

  test('provider + workdir combine as AND (intersection)', () => {
    const store = new BudgetStore();
    const usage = store.getUsage({ provider: 'openrouter', workdir: '/a' });
    assert.equal(usage.event_count, 1);
    assert.ok(Math.abs(usage.total_usd - 0.10) < 1e-9, `expected ~0.10, got ${usage.total_usd}`);
    assert.equal(usage.scope_filters.provider, 'openrouter');
    assert.equal(usage.scope_filters.workdir, '/a');
  });

  test('nonexistent provider → total=0, event_count=0', () => {
    const store = new BudgetStore();
    const usage = store.getUsage({ provider: 'nonexistent-provider-xyz' });
    assert.equal(usage.event_count, 0);
    assert.equal(usage.total_usd, 0);
  });

  test('sincePeriod=daily excludes rows older than 24h', () => {
    // Push two of the five rows 48h into the past.
    const db = getDb();
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    db.prepare(`UPDATE cost_events SET created_at = ? WHERE run_id IN ('run-1', 'run-5')`).run(cutoff);
    const store = new BudgetStore();
    const usage = store.getUsage({ sincePeriod: 'daily' });
    // Remaining recent rows: run-2 (0.02), run-3 (0.10), run-4 (0.20) → 0.32, 3 events
    assert.equal(usage.event_count, 3);
    assert.ok(Math.abs(usage.total_usd - 0.32) < 1e-9, `expected ~0.32, got ${usage.total_usd}`);
    assert.equal(usage.scope_filters.period, 'daily');
  });

  test('alltime period is equivalent to no time filter', () => {
    const store = new BudgetStore();
    const usage = store.getUsage({ sincePeriod: 'alltime' });
    assert.equal(usage.event_count, 5);
    assert.ok(Math.abs(usage.total_usd - 1.33) < 1e-9);
    assert.equal(usage.scope_filters.period, 'alltime');
  });

  test('parameter binding is used (SQL injection guard)', () => {
    // If the implementation string-concatenated `provider`, a value containing
    // an apostrophe would either throw or change the SQL semantics. With
    // parameter binding, it just returns zero events.
    const store = new BudgetStore();
    const usage = store.getUsage({ provider: `lmstudio' OR '1'='1` });
    assert.equal(usage.event_count, 0, 'malicious provider filter must not match any rows');
    assert.equal(usage.total_usd, 0);
  });

  test('zod-typed result shape is stable', () => {
    const store = new BudgetStore();
    const usage = store.getUsage({});
    // The exported zod schema should validate the result.
    void (async () => {
      const { GetUsageResultSchema } = await import('../../contracts/budget.js');
      const parsed = GetUsageResultSchema.parse(usage);
      assert.ok(typeof parsed.total_usd === 'number');
      assert.ok(typeof parsed.event_count === 'number');
    })();
  });
});

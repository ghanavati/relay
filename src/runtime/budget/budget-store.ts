import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../store/db.js';
import type {
  SetBudgetLimitArgs,
  ListBudgetLimitsArgs,
  ListBudgetAlertsArgs,
  BudgetLimitRow,
  BudgetAlertRow,
  BudgetAlertLevel,
} from '../../contracts/budget.js';

const DAY_MS = 86_400_000;
const MONTH_MS = 2_592_000_000;
const WARNING_THRESHOLD = 0.8;

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  limit_id?: string;
  current_usd?: number;
  limit_usd?: number;
  pct_used?: number;
}

function periodSinceMs(period: string): number | null {
  if (period === 'daily') return Date.now() - DAY_MS;
  if (period === 'monthly') return Date.now() - MONTH_MS;
  return null;
}

function getCurrentCost(
  db: Database.Database,
  scope: string,
  scopeValue: string,
  sinceMs: number | null
): number {
  let sql: string;
  const params: unknown[] = [];
  if (scope === 'model') {
    sql = `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_events WHERE model = ?`;
    params.push(scopeValue);
    if (sinceMs !== null) {
      sql += ` AND created_at >= ?`;
      params.push(sinceMs);
    }
  } else if (scope === 'owner') {
    sql = `SELECT COALESCE(SUM(ce.cost_usd), 0) AS total
             FROM cost_events ce JOIN models m ON ce.model = m.model_id
             WHERE m.owner = ?`;
    params.push(scopeValue);
    if (sinceMs !== null) {
      sql += ` AND ce.created_at >= ?`;
      params.push(sinceMs);
    }
  } else {
    sql = `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_events`;
    if (sinceMs !== null) {
      sql += ` WHERE created_at >= ?`;
      params.push(sinceMs);
    }
  }
  const row = db.prepare(sql).get(...params) as { total: number };
  return row.total;
}

export class BudgetStore {
  setBudgetLimit(args: SetBudgetLimitArgs): string {
    const db = getDb();
    const existing = db
      .prepare(`SELECT limit_id FROM budget_limits WHERE scope = ? AND scope_value = ? AND period = ?`)
      .get(args.scope, args.scope_value, args.period) as { limit_id: string } | undefined;
    const now = Date.now();
    if (existing) {
      db.prepare(`UPDATE budget_limits SET limit_usd = ?, updated_at = ? WHERE limit_id = ?`)
        .run(args.limit_usd, now, existing.limit_id);
      return existing.limit_id;
    }
    const limitId = `bgt-${randomUUID()}`;
    db.prepare(
      `INSERT INTO budget_limits (limit_id, scope, scope_value, limit_usd, period, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(limitId, args.scope, args.scope_value, args.limit_usd, args.period, now, now);
    return limitId;
  }

  listBudgetLimits(args: ListBudgetLimitsArgs): BudgetLimitRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.scope) { where.push('scope = ?'); params.push(args.scope); }
    if (args.scope_value) { where.push('scope_value = ?'); params.push(args.scope_value); }
    const sql = `SELECT limit_id, scope, scope_value, limit_usd, period, created_at, updated_at
                   FROM budget_limits
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY scope, scope_value, period`;
    return getDb().prepare(sql).all(...params) as BudgetLimitRow[];
  }

  recordAlert(args: {
    scope: string; scope_value: string; limit_usd: number; current_usd: number;
    pct_used: number; level: BudgetAlertLevel; period: string;
  }): string {
    const alertId = `bga-${randomUUID()}`;
    getDb()
      .prepare(
        `INSERT INTO budget_alerts
           (alert_id, scope, scope_value, limit_usd, current_usd, pct_used, level, period, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        alertId, args.scope, args.scope_value, args.limit_usd,
        args.current_usd, args.pct_used, args.level, args.period, Date.now()
      );
    return alertId;
  }

  listBudgetAlerts(args: ListBudgetAlertsArgs): BudgetAlertRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.scope) { where.push('scope = ?'); params.push(args.scope); }
    if (args.scope_value) { where.push('scope_value = ?'); params.push(args.scope_value); }
    if (args.level) { where.push('level = ?'); params.push(args.level); }
    params.push(args.limit ?? 100);
    const sql = `SELECT alert_id, scope, scope_value, limit_usd, current_usd, pct_used, level, period, created_at
                   FROM budget_alerts
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY created_at DESC
                   LIMIT ?`;
    return getDb().prepare(sql).all(...params) as BudgetAlertRow[];
  }

  checkBudgets(model: string | null | undefined): BudgetCheckResult {
    const db = getDb();
    const limits = db
      .prepare(`SELECT limit_id, scope, scope_value, limit_usd, period FROM budget_limits`)
      .all() as Array<{ limit_id: string; scope: string; scope_value: string; limit_usd: number; period: string }>;
    if (limits.length === 0) return { allowed: true };

    for (const limit of limits) {
      if (limit.scope === 'model' && limit.scope_value !== model) continue;
      const sinceMs = periodSinceMs(limit.period);
      const current = getCurrentCost(db, limit.scope, limit.scope_value, sinceMs);
      const pctUsed = limit.limit_usd > 0 ? current / limit.limit_usd : 0;
      const exceeded = current >= limit.limit_usd;

      if (exceeded || pctUsed >= WARNING_THRESHOLD) {
        this.recordAlert({
          scope: limit.scope,
          scope_value: limit.scope_value,
          limit_usd: limit.limit_usd,
          current_usd: current,
          pct_used: pctUsed,
          level: exceeded ? 'exceeded' : 'warning',
          period: limit.period,
        });
      }

      if (exceeded) {
        return {
          allowed: false,
          reason: `Budget exceeded for ${limit.scope}=${limit.scope_value} (${limit.period}): $${current.toFixed(4)} >= $${limit.limit_usd.toFixed(4)}`,
          limit_id: limit.limit_id,
          current_usd: current,
          limit_usd: limit.limit_usd,
          pct_used: pctUsed,
        };
      }
    }

    return { allowed: true };
  }
}

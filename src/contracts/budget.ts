import { z } from 'zod';

export const BudgetScopeSchema = z.enum(['model', 'owner', 'global']);
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

export const BudgetPeriodSchema = z.enum(['daily', 'monthly', 'alltime']);
export type BudgetPeriod = z.infer<typeof BudgetPeriodSchema>;

export const BudgetAlertLevelSchema = z.enum(['warning', 'exceeded']);
export type BudgetAlertLevel = z.infer<typeof BudgetAlertLevelSchema>;

export const setBudgetLimitSchema = z.object({
  scope: BudgetScopeSchema,
  /** model_id / owner name / '*' for global */
  scope_value: z.string().min(1),
  limit_usd: z.number().positive(),
  period: BudgetPeriodSchema,
});

export const listBudgetLimitsSchema = z.object({
  scope: BudgetScopeSchema.optional(),
  scope_value: z.string().optional(),
});

export const listBudgetAlertsSchema = z.object({
  scope: BudgetScopeSchema.optional(),
  scope_value: z.string().optional(),
  level: BudgetAlertLevelSchema.optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

export type SetBudgetLimitArgs = z.infer<typeof setBudgetLimitSchema>;
export type ListBudgetLimitsArgs = z.infer<typeof listBudgetLimitsSchema>;
export type ListBudgetAlertsArgs = z.infer<typeof listBudgetAlertsSchema>;

/**
 * Options accepted by {@link BudgetStore.getUsage}. Every field is optional —
 * the empty object sums every row in `cost_events`.
 *
 * `sincePeriod` reuses the same daily/monthly/alltime vocabulary as
 * `budget_limits.period`. `alltime` (or omitted) means "no time filter".
 */
export const GetUsageOptsSchema = z.object({
  provider: z.string().min(1).optional(),
  workdir: z.string().min(1).optional(),
  sincePeriod: BudgetPeriodSchema.optional(),
});
export type GetUsageOpts = z.infer<typeof GetUsageOptsSchema>;

/**
 * Stable shape returned by {@link BudgetStore.getUsage}. `scope_filters`
 * echoes the inputs (null for unspecified) so the JSON envelope can be pinned
 * by downstream consumers without re-parsing the request.
 */
export const GetUsageResultSchema = z.object({
  total_usd: z.number(),
  event_count: z.number().int().nonnegative(),
  scope_filters: z.object({
    provider: z.string().nullable(),
    workdir: z.string().nullable(),
    period: BudgetPeriodSchema.nullable(),
  }),
});
export type GetUsageResult = z.infer<typeof GetUsageResultSchema>;

export interface BudgetLimitRow {
  limit_id: string;
  scope: BudgetScope;
  scope_value: string;
  limit_usd: number;
  period: BudgetPeriod;
  created_at: number;
  updated_at: number;
}

export interface BudgetAlertRow {
  alert_id: string;
  scope: BudgetScope;
  scope_value: string;
  limit_usd: number;
  current_usd: number;
  pct_used: number;
  level: BudgetAlertLevel;
  period: string;
  created_at: number;
}

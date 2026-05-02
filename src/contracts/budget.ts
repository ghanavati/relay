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

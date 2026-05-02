import { z } from 'zod';

export const runRetentionSchema = z.object({
  dry_run: z.boolean().optional().default(false),
});

export const listRetentionEventsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional().default(50),
});

export type RunRetentionArgs = z.infer<typeof runRetentionSchema>;
export type ListRetentionEventsArgs = z.infer<typeof listRetentionEventsSchema>;

export interface RetentionEventRow {
  retention_id: string;
  ran_at: number;
  run_events_archived: number;
  guardian_events_archived: number;
  runs_archived: number;
  retention_days: number;
  provider_retention_days: number;
  triggered_by: string;
  dry_run: number; // SQLite boolean: 1|0
}

export interface RetentionResult {
  retention_id: string | null; // null on dry_run
  run_events_archived: number;
  guardian_events_archived: number;
  runs_archived: number;
  retention_days: number;
  provider_retention_days: number;
  dry_run: boolean;
}

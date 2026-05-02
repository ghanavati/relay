import { z } from 'zod';

// ── list_run_events ──────────────────────────────────────────────────────

export const listRunEventsSchema = {
  run_id: z.string().uuid().optional().describe('Filter events by run_id'),
  event_type: z
    .enum(['run_started', 'run_finished', 'worker_dispatched', 'worker_completed'])
    .optional()
    .describe('Filter by event type'),
  limit: z.number().int().min(1).max(500).optional().default(100),
};

export const ListRunEventsArgsSchema = z.object(listRunEventsSchema);
export type ListRunEventsArgs = z.infer<typeof ListRunEventsArgsSchema>;

export interface RunEventProjection {
  readonly run_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly created_at: number;
}

// ── list_verifications ───────────────────────────────────────────────────

export const listVerificationsSchema = {
  run_id: z.string().uuid().optional().describe('Filter verifications by run_id'),
  status: z
    .enum(['approved', 'rejected'])
    .optional()
    .describe('Filter by verification status'),
  limit: z.number().int().min(1).max(500).optional().default(100),
};

export const ListVerificationsArgsSchema = z.object(listVerificationsSchema);
export type ListVerificationsArgs = z.infer<typeof ListVerificationsArgsSchema>;

export interface VerificationProjection {
  readonly verification_id: string;
  readonly run_id: string;
  readonly reviewer: string;
  readonly status: string;
  readonly reason: string;
  readonly created_at: number;
}

// ── get_run_diffs ────────────────────────────────────────────────────────

export const getRunDiffsSchema = {
  run_id: z.string().uuid('run_id must be a valid UUID'),
};

export const GetRunDiffsArgsSchema = z.object(getRunDiffsSchema);
export type GetRunDiffsArgs = z.infer<typeof GetRunDiffsArgsSchema>;

export interface DiffProjection {
  readonly file_path: string;
  readonly diff_text: string;
  readonly created_at: number;
}

export interface GetRunDiffsResult {
  readonly run_id: string;
  readonly diffs: DiffProjection[];
}

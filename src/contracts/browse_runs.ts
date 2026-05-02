import { z } from 'zod';

export const browseRunsSchema = {
  status: z.enum(['queued', 'running', 'success', 'error']).optional().describe('Filter by run status'),
  provider: z.string().optional().describe('Filter by provider name'),
  since: z.number().int().positive().optional().describe('Epoch ms — return runs after this timestamp'),
  limit: z.number().int().min(1).max(200).optional().default(50).describe('Max results (default 50)'),
  verification_status: z.enum(['approved', 'rejected']).optional().describe('Filter by verification outcome'),
  include_archived: z.boolean().optional().describe('Include archived runs (default false)'),
};

export const BrowseRunsArgsSchema = z.object(browseRunsSchema);
export type BrowseRunsArgs = z.infer<typeof BrowseRunsArgsSchema>;

export interface BrowseRunProjection {
  readonly run_id: string;
  readonly status: string;
  readonly provider: string;
  readonly model: string | null;
  readonly started_at: number | null;
  readonly finished_at: number | null;
  readonly duration_ms: number | null;
  readonly verification_status: string | null;
  readonly files_changed_count: number;
  readonly error_code: string | null;
}

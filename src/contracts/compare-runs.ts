import { z } from "zod";

export const compareRunsSchema = {
  run_ids: z
    .array(z.string().uuid("each run_id must be a valid UUID"))
    .min(2, "compare_runs requires at least two run_ids")
    .describe(
      "Two or more run IDs from delegate_parallel to compare for filesystem mutation divergence"
    ),
};

export const CompareRunsArgsSchema = z.object(compareRunsSchema);
export type CompareRunsArgs = z.infer<typeof CompareRunsArgsSchema>;

export interface PerRunProfile {
  readonly run_id: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: string | null;
  readonly files_changed: string[];
  readonly unique_files: string[];
}

export interface CompareRunsResult {
  readonly run_ids: string[];
  readonly files_union: string[];
  readonly files_intersection: string[];
  readonly files_diverged: string[];
  readonly per_run: PerRunProfile[];
  /** Jaccard distance: 0 = all models touched identical files, 1 = no overlap at all */
  readonly divergence_score: number;
  /** 1 - divergence_score */
  readonly agreement_score: number;
}

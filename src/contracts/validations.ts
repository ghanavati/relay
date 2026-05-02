import { z } from 'zod';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const ValidationStatusSchema = z.enum([
  'planned',
  'in-progress',
  'complete',
  'cancelled',
]).describe('Lifecycle status of a validation engagement');
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>;

export const FindingSeveritySchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
]).describe('Severity. critical findings block sign_off until resolved.');
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

// ── Raw DB rows ───────────────────────────────────────────────────────────────

export interface ValidationRow {
  readonly validation_id: string;
  readonly model_id: string;
  readonly reviewer_id: string;
  readonly developer_id: string;
  readonly validation_plan: string | null;
  readonly test_scope: string | null;
  readonly benchmark_models: string; // JSON array
  readonly status: string;
  readonly scheduled_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ValidationFindingRow {
  readonly finding_id: string;
  readonly validation_id: string;
  readonly severity: string;
  readonly description: string;
  readonly remediation_plan: string | null;
  readonly remediation_due: number | null;
  readonly resolved_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

// ── Domain objects ────────────────────────────────────────────────────────────

export interface Validation {
  readonly validation_id: string;
  readonly model_id: string;
  readonly reviewer_id: string;
  readonly developer_id: string;
  readonly validation_plan: string | null;
  readonly test_scope: string | null;
  readonly benchmark_models: readonly string[];
  readonly status: ValidationStatus;
  readonly scheduled_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ValidationFinding {
  readonly finding_id: string;
  readonly validation_id: string;
  readonly severity: FindingSeverity;
  readonly description: string;
  readonly remediation_plan: string | null;
  readonly remediation_due: number | null;
  readonly resolved_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

// ── create_validation_plan ────────────────────────────────────────────────────

export const createValidationPlanSchema = {
  model_id: z.string().min(1).describe('Registry model ID to validate'),
  reviewer_id: z.string().min(1)
    .describe('ID of the independent reviewer. Must differ from developer_id.'),
  developer_id: z.string().min(1)
    .describe('ID of the model developer or operator. Must differ from reviewer_id.'),
  validation_plan: z.string().max(5000).optional()
    .describe('Narrative description of the validation approach'),
  test_scope: z.string().max(2000).optional()
    .describe('Scope of testing (e.g. back-test, out-of-time, benchmarking)'),
  benchmark_models: z.array(z.string()).optional().default([])
    .describe('Model IDs or names used as benchmarks'),
  scheduled_at: z.number().int().positive().optional()
    .describe('Epoch ms of scheduled validation start'),
};
export const CreateValidationPlanArgsSchema = z.object(createValidationPlanSchema);
export type CreateValidationPlanArgs = z.infer<typeof CreateValidationPlanArgsSchema>;

// ── get_validation ────────────────────────────────────────────────────────────

export const getValidationSchema = {
  validation_id: z.string().min(1).describe('Validation ID to retrieve'),
};
export const GetValidationArgsSchema = z.object(getValidationSchema);
export type GetValidationArgs = z.infer<typeof GetValidationArgsSchema>;

// ── list_validation_findings ──────────────────────────────────────────────────

export const listValidationFindingsSchema = {
  validation_id: z.string().optional()
    .describe('Filter by specific validation ID'),
  model_id: z.string().optional()
    .describe('Filter by model ID (returns findings across all validations for this model)'),
  severity: FindingSeveritySchema.optional()
    .describe('Filter by severity level'),
  unresolved_only: z.boolean().optional().default(false)
    .describe('If true, return only findings without resolved_at'),
  limit: z.number().int().min(1).max(500).optional().default(100),
};
export const ListValidationFindingsArgsSchema = z.object(listValidationFindingsSchema);
export type ListValidationFindingsArgs = z.infer<typeof ListValidationFindingsArgsSchema>;

// ── create_validation_finding ─────────────────────────────────────────────────

export const createValidationFindingSchema = {
  validation_id: z.string().min(1).describe('Validation this finding belongs to'),
  severity: FindingSeveritySchema.describe('Finding severity'),
  description: z.string().min(1).max(5000).describe('What was found'),
  remediation_plan: z.string().max(2000).optional()
    .describe('How the finding will be addressed'),
  remediation_due: z.number().int().positive().optional()
    .describe('Epoch ms remediation deadline'),
};
export const CreateValidationFindingArgsSchema = z.object(createValidationFindingSchema);
export type CreateValidationFindingArgs = z.infer<typeof CreateValidationFindingArgsSchema>;

// ── resolve_validation_finding ────────────────────────────────────────────────

export const resolveValidationFindingSchema = {
  finding_id: z.string().min(1).describe('Finding ID to mark resolved'),
};
export const ResolveValidationFindingArgsSchema = z.object(resolveValidationFindingSchema);
export type ResolveValidationFindingArgs = z.infer<typeof ResolveValidationFindingArgsSchema>;

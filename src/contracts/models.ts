import { z } from 'zod';

// ── Enum schemas ───────────────────────────────────────────────────────────────

export const RiskTierSchema = z.enum(['high', 'medium', 'low', 'informational'])
  .describe('Risk tier per SR 11-7 / OSFI E-23 Appendix 1');
export type RiskTier = z.infer<typeof RiskTierSchema>;

export const ModelStatusSchema = z.enum([
  'in-development',
  'deployed',
  'retired',
  'decommissioned',
]).describe('Lifecycle status. Decommissioned records are retained immutably.');
export type ModelStatus = z.infer<typeof ModelStatusSchema>;

export const ModelOriginSchema = z.enum([
  'in-house',
  'vendor',
  'open-source',
  'third-party',
]);
export type ModelOrigin = z.infer<typeof ModelOriginSchema>;

// ── Model type — hybrid adapter classification (R-22) ─────────────────────────

export const ModelTypeSchema = z
  .enum(['llm', 'onnx', 'r-script', 'python-script', 'vendor-api'])
  .describe('Underlying model technology type. Required for hybrid (non-LLM) models.');
export type ModelType = z.infer<typeof ModelTypeSchema>;

// ── Raw DB row (matches SQLite column names exactly) ──────────────────────────

export interface ModelRow {
  readonly model_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly risk_tier: string;
  readonly owner: string | null;
  readonly developer: string | null;
  readonly origin: string | null;
  readonly version: string | null;
  readonly approved_uses: string;   // JSON array
  readonly operating_limits: string | null; // JSON object
  readonly data_sources: string;    // JSON array
  readonly dependencies: string;    // JSON array
  readonly status: string;
  readonly deployment_date: number | null;
  readonly next_review_date: number | null;
  readonly monitoring_status: string | null;
  readonly obligation_role: string | null;
  readonly provider_documentation_received: number; // SQLite INTEGER (0 = false, 1 = true)
  readonly model_type: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

// ── Domain object (parsed from row) ───────────────────────────────────────────

export interface Model {
  readonly model_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly risk_tier: RiskTier;
  readonly owner: string | null;
  readonly developer: string | null;
  readonly origin: string | null;
  readonly version: string | null;
  readonly approved_uses: readonly string[];
  readonly operating_limits: Readonly<Record<string, unknown>> | null;
  readonly data_sources: readonly string[];
  readonly dependencies: readonly string[];
  readonly status: ModelStatus;
  readonly deployment_date: number | null;
  readonly next_review_date: number | null;
  readonly monitoring_status: string | null;
  readonly obligation_role: string | null;
  readonly provider_documentation_received: boolean;
  readonly model_type: ModelType | null;
  readonly created_at: number;
  readonly updated_at: number;
  /** Computed: true when next_review_date < now and model is not decommissioned */
  readonly validation_overdue: boolean;
}

// ── register_model ─────────────────────────────────────────────────────────────

export const registerModelSchema = {
  name: z.string().min(1).max(200).describe('Human-readable model name'),
  description: z.string().max(2000).optional().describe('Purpose and scope of the model'),
  risk_tier: RiskTierSchema.optional().default('high'),
  owner: z.string().max(200).optional().describe('Accountable business owner name or role'),
  developer: z.string().max(200).optional().describe('Technical developer or team responsible'),
  origin: ModelOriginSchema.optional().describe('How the model was obtained'),
  version: z.string().max(100).optional().describe('Model version string'),
  approved_uses: z.array(z.string()).optional().default([]).describe('Explicitly approved use cases'),
  operating_limits: z.record(z.unknown()).optional()
    .describe('Operating constraints (e.g. max_input_tokens, environment, thresholds)'),
  data_sources: z.array(z.string()).optional().default([]).describe('Training or input data sources'),
  dependencies: z.array(z.string()).optional().default([]).describe('Upstream model or system dependencies'),
  monitoring_status: z.string().max(200).optional().describe('Current monitoring state'),
  // R-16 — EU AI Act Articles 28-30: provider/deployer obligation split
  obligation_role: z.enum(['provider', 'deployer', 'both']).optional()
    .describe('Role in the AI value chain per EU AI Act Art. 28-30'),
  provider_documentation_received: z.boolean().optional()
    .describe('Whether deployer has received required technical documentation from provider (Art. 28(1)(c))'),
  // R-22 — Hybrid Model Adapters: technology type classification
  model_type: ModelTypeSchema.optional()
    .describe('Underlying model technology. Use "llm" for language models, or "onnx", "r-script", "python-script", "vendor-api" for hybrid non-LLM models (R-22).'),
  deployment_date: z.number().int().positive().optional()
    .describe('Epoch ms of deployment (omit for in-development models)'),
  next_review_date: z.number().int().positive().optional()
    .describe('Epoch ms of scheduled next validation review'),
};
export const RegisterModelArgsSchema = z.object(registerModelSchema);
export type RegisterModelArgs = z.infer<typeof RegisterModelArgsSchema>;

// ── get_model ──────────────────────────────────────────────────────────────────

export const getModelSchema = {
  model_id: z.string().min(1).describe('Model ID to retrieve'),
};
export const GetModelArgsSchema = z.object(getModelSchema);
export type GetModelArgs = z.infer<typeof GetModelArgsSchema>;

// ── list_models ────────────────────────────────────────────────────────────────

export const listModelsSchema = {
  status: ModelStatusSchema.optional().describe('Filter by lifecycle status'),
  risk_tier: RiskTierSchema.optional().describe('Filter by risk tier'),
  owner: z.string().optional().describe('Filter by owner'),
  validation_overdue: z.boolean().optional()
    .describe('If true, only return models past their next_review_date'),
  limit: z.number().int().min(1).max(500).optional().default(100),
};
export const ListModelsArgsSchema = z.object(listModelsSchema);
export type ListModelsArgs = z.infer<typeof ListModelsArgsSchema>;

// ── update_model_status ────────────────────────────────────────────────────────

export const updateModelStatusSchema = {
  model_id: z.string().min(1).describe('Model ID to update'),
  status: ModelStatusSchema.describe('New lifecycle status'),
  notes: z.string().max(2000).optional().describe('Reason for the status change (logged to run_events)'),
  next_review_date: z.number().int().positive().optional()
    .describe('Updated next review date (epoch ms)'),
  deployment_date: z.number().int().positive().optional()
    .describe('Set or correct the deployment date (epoch ms)'),
  monitoring_status: z.string().max(200).optional().describe('Updated monitoring state description'),
};
export const UpdateModelStatusArgsSchema = z.object(updateModelStatusSchema);
export type UpdateModelStatusArgs = z.infer<typeof UpdateModelStatusArgsSchema>;

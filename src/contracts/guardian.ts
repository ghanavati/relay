import { z } from 'zod';

// ── Type enums ────────────────────────────────────────────────────────────────

export const GuardianTypeSchema = z.enum(['security', 'performance', 'integrity', 'shadow_audit', 'supervisor_sensitivity', 'reasoning_density']);
export type GuardianType = z.infer<typeof GuardianTypeSchema>;

export const SeveritySchema = z.enum(['info', 'warning', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const AutoActionSchema = z.enum(['none', 'alert', 'abort']);
export type AutoAction = z.infer<typeof AutoActionSchema>;

export const QualityStatusSchema = z.enum(['done', 'done_with_concerns', 'needs_context', 'blocked']);
export type QualityStatus = z.infer<typeof QualityStatusSchema>;

// ── Row interfaces (for DB reads) ─────────────────────────────────────────────

export interface GuardianEventRow {
  id: string;
  guardian_type: GuardianType;
  severity: Severity;
  run_id: string | null;
  policy_id: string | null;
  evidence: string; // JSON AEGIS 7-layer: {observation,evidence,interpretation,assumptions,risk,impact,judgment}
  action_taken: string | null;
  operator_response: string | null;
  fired_at: number;
  resolved_at: number | null;
  /** 'llm' when the event was produced by an LLM call; 'heuristic' for string-match fallback. MRM-08 / R-07. */
  source: string;
  /** Model ID used when source='llm'; null otherwise. */
  model_used: string | null;
}

export interface GuardianPolicyRow {
  id: string;
  guardian_type: GuardianType;
  name: string;
  rule_type: string;
  rule_config: string; // JSON
  severity: Severity;
  auto_action: AutoAction;
  scope: string;
  enabled: number;
}

// ── AEGIS evidence schema ─────────────────────────────────────────────────────

export interface AegisEvidence {
  observation: string;
  evidence: string;
  interpretation: string;
  assumptions: string;
  risk: string;
  impact: string;
  judgment: string;
  /** SHIP-97 — true when drift trajectory is step_change or slope (systematic degradation pattern) */
  systematic?: boolean;
}

// ── list_guardian_events ──────────────────────────────────────────────────────

export const listGuardianEventsSchema = {
  run_id: z.string().optional().describe('Filter by run_id'),
  guardian_type: GuardianTypeSchema.optional().describe('Filter by evaluator type'),
  severity: SeveritySchema.optional().describe('Filter by severity'),
  resolved: z.boolean().optional().describe('true = only resolved events; false = only unresolved'),
  /** R-31: filter by event source — 'heuristic' | 'llm' | 'shadow_audit' | 'backtest' */
  source: z.string().optional().describe('Filter by source (heuristic, llm, shadow_audit, backtest)'),
  limit: z.number().int().min(1).max(200).optional().default(50).describe('Max events to return'),
};
export const ListGuardianEventsArgsSchema = z.object(listGuardianEventsSchema);
export type ListGuardianEventsArgs = z.infer<typeof ListGuardianEventsArgsSchema>;

// ── acknowledge_guardian_event ────────────────────────────────────────────────

export const acknowledgeGuardianEventSchema = {
  event_id: z.string().min(1).describe('Guardian event ID to acknowledge'),
  operator_response: z.enum(['dismissed', 'confirmed', 'overridden']).describe('Operator verdict'),
  notes: z.string().max(1000).optional().describe('Optional operator notes'),
};
export const AcknowledgeGuardianEventArgsSchema = z.object(acknowledgeGuardianEventSchema);
export type AcknowledgeGuardianEventArgs = z.infer<typeof AcknowledgeGuardianEventArgsSchema>;

// ── list_guardian_policies ────────────────────────────────────────────────────

export const listGuardianPoliciesSchema = {
  guardian_type: GuardianTypeSchema.optional().describe('Filter by evaluator type'),
  scope: z.string().optional().describe('Filter by scope (default: global)'),
  enabled_only: z.boolean().optional().default(true).describe('Only return enabled policies'),
};
export const ListGuardianPoliciesArgsSchema = z.object(listGuardianPoliciesSchema);
export type ListGuardianPoliciesArgs = z.infer<typeof ListGuardianPoliciesArgsSchema>;

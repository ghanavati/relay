/**
 * Capability routing types and constants.
 *
 * Pure types + const arrays + tiny helpers — no I/O.
 */

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/** Operational flags that a worker can demonstrate through observed runs. */
export type Capability =
  | 'tool_use'
  | 'file_read'
  | 'file_write'
  | 'commit'
  | 'vision'
  | 'structured_output'
  | 'grounding';

/** All valid Capability values — useful for runtime validation. */
export const CAPABILITIES: readonly Capability[] = [
  'tool_use',
  'file_read',
  'file_write',
  'commit',
  'vision',
  'structured_output',
  'grounding',
] as const;

// ---------------------------------------------------------------------------
// TrustState
// ---------------------------------------------------------------------------

/** Trust state of a worker for a given capability in a given task context. */
export type TrustState = 'unknown' | 'observed' | 'reliable' | 'unreliable' | 'broken';

/** All valid TrustState values. */
export const TRUST_STATES: readonly TrustState[] = [
  'unknown',
  'observed',
  'reliable',
  'unreliable',
  'broken',
] as const;

/**
 * TrustState values ordered from least to most trustworthy.
 *
 * Used by compareTrustStates — higher index means more trustworthy.
 * 'broken' is the least trustworthy; 'reliable' is the most trustworthy.
 */
const TRUST_STATE_ORDER: readonly TrustState[] = [
  'broken',
  'unreliable',
  'unknown',
  'observed',
  'reliable',
] as const;

/**
 * Compare two trust states by trustworthiness.
 *
 * Returns negative if a < b (a is less trustworthy),
 * zero if equal, positive if a > b (a is more trustworthy).
 */
export function compareTrustStates(a: TrustState, b: TrustState): number {
  return TRUST_STATE_ORDER.indexOf(a) - TRUST_STATE_ORDER.indexOf(b);
}

// ---------------------------------------------------------------------------
// TaskContext
// ---------------------------------------------------------------------------

/** Execution context that scopes capability evidence. */
export type TaskContext = 'repo_task' | 'analysis_task' | 'verification_task';

// ---------------------------------------------------------------------------
// RiskLevel
// ---------------------------------------------------------------------------

/** Risk level of a delegated task — determines dispatch strictness. */
export type RiskLevel = 'low' | 'standard' | 'critical';

/** All valid RiskLevel values ordered from lowest to highest risk. */
export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'standard', 'critical'] as const;

/**
 * Return the higher of two risk levels.
 */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const idxA = RISK_LEVELS.indexOf(a);
  const idxB = RISK_LEVELS.indexOf(b);
  return idxA >= idxB ? a : b;
}

// ---------------------------------------------------------------------------
// TaskContract
// ---------------------------------------------------------------------------

/** The set of capability requirements and risk constraints for a delegated task. */
export interface TaskContract {
  /** Capabilities the selected worker must be able to demonstrate. */
  readonly requirements: ReadonlySet<Capability>;
  /** Caller-supplied risk level — may raise but never lower the inferred risk. */
  readonly risk_override?: RiskLevel;
  /** Whether fallback to direct dispatch is allowed (only for standard risk). */
  readonly allow_fallback?: boolean;
}

// ---------------------------------------------------------------------------
// Database row shapes
// ---------------------------------------------------------------------------

/** Shape of a row in the worker_profiles table. */
export interface WorkerProfileRow {
  worker_id: string;
  provider: string;
  model: string;
  /** Epoch ms when cooldown expires; null means the worker is available now. */
  cooldown_until: number | null;
  created_at: number;
  updated_at: number;
}

/** Shape of a row in the capability_evidence table. */
export interface CapabilityEvidenceRow {
  id: number;
  worker_id: string;
  capability: string;
  task_context: string;
  trust_state: string;
  success_count: number;
  failure_count: number;
  consecutive_failures: number;
  last_failure_at: number | null;
  run_id: string | null;
  last_verified: number | null;
  notes: string | null;
}

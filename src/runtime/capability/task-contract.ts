/**
 * Pure functions for TaskContract inference and risk computation.
 *
 * No I/O — these are stateless transforms over delegate arguments.
 */

import type { Capability, RiskLevel, TaskContract } from './types.js';
import { maxRisk } from './types.js';

// ---------------------------------------------------------------------------
// TaskContract inference
// ---------------------------------------------------------------------------

/** Arguments used to infer a TaskContract from a delegate call. */
export interface InferTaskContractArgs {
  workdir?: string;
  capabilities?: string[];
  images?: string[];
  risk?: RiskLevel;
  allow_fallback?: boolean;
  isAgentic: boolean;
}

/**
 * Infer a TaskContract from delegate call arguments.
 *
 * Applies the six inference rules from the design spec:
 *
 * | Delegate args                          | Inferred requirements     |
 * |----------------------------------------|---------------------------|
 * | Any agentic task                       | tool_use                  |
 * | workdir present                        | file_read                 |
 * | capabilities includes file_write       | file_write                |
 * | capabilities includes commit           | file_write, commit        |
 * | capabilities includes grounding_required | grounding               |
 * | images array non-empty                 | vision                    |
 *
 * Pure function — no I/O.
 */
export function inferTaskContract(args: InferTaskContractArgs): TaskContract {
  const reqs = new Set<Capability>();

  if (args.isAgentic) {
    reqs.add('tool_use');
  }

  if (args.workdir !== undefined && args.workdir !== '') {
    reqs.add('file_read');
  }

  const caps = args.capabilities ?? [];

  if (caps.includes('file_write')) {
    reqs.add('file_write');
  }

  if (caps.includes('commit')) {
    reqs.add('file_write');
    reqs.add('commit');
  }

  if (caps.includes('grounding_required')) {
    reqs.add('grounding');
  }

  if ((args.images?.length ?? 0) > 0) {
    reqs.add('vision');
  }

  return {
    requirements: reqs,
    risk_override: args.risk,
    allow_fallback: args.allow_fallback,
  };
}

// ---------------------------------------------------------------------------
// Risk inference
// ---------------------------------------------------------------------------

/**
 * Infer risk level from a set of task requirements.
 *
 * Applies the risk inference table from the design spec:
 *
 * | Requirements              | Risk     |
 * |---------------------------|----------|
 * | grounding required        | critical |
 * | commit required           | standard |
 * | file_write required       | standard |
 * | everything else           | low      |
 *
 * Note: commit is standard (not critical) because commits are reversible
 * via `git revert`. critical is reserved for grounding_required tasks where
 * hallucination risk is irreversible.
 */
export function inferRisk(requirements: ReadonlySet<Capability>): RiskLevel {
  if (requirements.has('grounding')) return 'critical';
  if (requirements.has('commit')) return 'standard';
  if (requirements.has('file_write')) return 'standard';
  return 'low';
}

// ---------------------------------------------------------------------------
// Effective risk computation
// ---------------------------------------------------------------------------

/**
 * Compute the effective risk level for a task.
 *
 * effective_risk = max(inferred, caller_override ?? 'low')
 *
 * The caller can raise the risk level but never lower it.
 */
export function computeEffectiveRisk(inferred: RiskLevel, callerOverride?: RiskLevel): RiskLevel {
  return maxRisk(inferred, callerOverride ?? 'low');
}

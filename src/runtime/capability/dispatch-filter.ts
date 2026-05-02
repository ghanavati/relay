/**
 * Dispatch filter — candidate filtering and ranking for capability-based dispatch.
 *
 * Applies a 4-step pipeline:
 *   1. Exclude cooled workers (double-check — listAvailableWorkers already filters, but we guard here)
 *   2. Exclude workers with `broken` trust for any required capability
 *   3. Apply risk gate (low / standard / critical rules)
 *   4. Rank by minimum confidence across all required capabilities (descending)
 *
 * Pure filtering logic — no I/O beyond reading from CapabilityStore.
 */

import type { TaskContract, WorkerProfileRow, RiskLevel, TaskContext, Capability } from './types.js';
import { compareTrustStates } from './types.js';
import type { CapabilityStore } from './capability-store.js';

// ---------------------------------------------------------------------------
// Write capabilities — capabilities that require observed+ trust for standard risk
// ---------------------------------------------------------------------------

const WRITE_CAPABILITIES = new Set<Capability>(['file_write', 'commit']);

// ---------------------------------------------------------------------------
// workerPassesRiskGate
// ---------------------------------------------------------------------------

/**
 * Determine whether a single worker meets the risk gate for the given task.
 *
 * Risk gate rules:
 *   low:      unknown or better for ALL required capabilities (always passes for unknown)
 *   standard: write capabilities (file_write, commit) require `observed` or better
 *             unless allow_fallback is true, in which case unknown is also allowed
 *             non-write capabilities: unknown is acceptable
 *   critical: ALL required capabilities must have `reliable` trust; no fallback ever
 */
export function workerPassesRiskGate(
  workerId: string,
  contract: TaskContract,
  store: CapabilityStore,
  effectiveRisk: RiskLevel,
  taskContext: TaskContext,
): boolean {
  for (const cap of contract.requirements) {
    const trust = store.getTrustState(workerId, cap, taskContext);

    if (effectiveRisk === 'low') {
      // low risk: unknown or better — broken is the only failure
      if (trust === 'broken') {
        return false;
      }
    } else if (effectiveRisk === 'standard') {
      if (WRITE_CAPABILITIES.has(cap)) {
        // write caps: need at least observed, unless allow_fallback permits unknown
        if (trust === 'broken' || trust === 'unreliable') {
          return false;
        }
        // unknown is only acceptable if allow_fallback is set
        if (trust === 'unknown' && !contract.allow_fallback) {
          return false;
        }
      } else {
        // non-write caps at standard risk: unknown is acceptable, broken/unreliable fail
        if (trust === 'broken' || trust === 'unreliable') {
          return false;
        }
      }
    } else {
      // critical: must be reliable — no fallback
      // compareTrustStates(trust, 'reliable') < 0 means trust is less trustworthy than reliable
      if (compareTrustStates(trust, 'reliable') < 0) {
        return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// filterAndRankCandidates
// ---------------------------------------------------------------------------

export interface FilterAndRankParams {
  candidates: WorkerProfileRow[];
  contract: TaskContract;
  store: CapabilityStore;
  effectiveRisk: RiskLevel;
  taskContext: TaskContext;
  now: number;
}

export interface FilterAndRankResult {
  ranked: WorkerProfileRow[];
  rejectionReasons: Map<string, string>;
}

/**
 * Filter and rank worker candidates for a dispatch decision.
 *
 * Steps (applied in order):
 *   1. Remove cooled workers (cooldown_until > now)
 *   2. Remove workers with `broken` trust for any required capability
 *   3. Apply risk gate via workerPassesRiskGate
 *   4. Rank by minimum confidence across all required capabilities (descending)
 *
 * Returns the ranked list and a Map of workerId -> rejection reason for all
 * excluded candidates. The rejection map enables informative error messages
 * when no candidates pass.
 */
export function filterAndRankCandidates(params: FilterAndRankParams): FilterAndRankResult {
  const { candidates, contract, store, effectiveRisk, taskContext, now } = params;
  const rejectionReasons = new Map<string, string>();
  const passed: WorkerProfileRow[] = [];

  for (const candidate of candidates) {
    const workerId = candidate.worker_id;

    // Step 1: cooldown check (double-guard — listAvailableWorkers already filters)
    if (candidate.cooldown_until !== null && candidate.cooldown_until > now) {
      rejectionReasons.set(
        workerId,
        `cooldown active until ${new Date(candidate.cooldown_until).toISOString()}`,
      );
      continue;
    }

    // Step 2: broken trust check for any required capability
    let brokenCap: Capability | null = null;
    for (const cap of contract.requirements) {
      const trust = store.getTrustState(workerId, cap, taskContext);
      if (trust === 'broken') {
        brokenCap = cap;
        break;
      }
    }
    if (brokenCap !== null) {
      rejectionReasons.set(workerId, `broken for ${brokenCap}`);
      continue;
    }

    // Step 3: risk gate
    if (!workerPassesRiskGate(workerId, contract, store, effectiveRisk, taskContext)) {
      rejectionReasons.set(
        workerId,
        `insufficient trust for ${effectiveRisk}-risk task`,
      );
      continue;
    }

    passed.push(candidate);
  }

  // Step 4: rank by minimum confidence across all required capabilities (descending)
  const ranked = passed.slice().sort((a, b) => {
    const minConfA = minConfidence(a.worker_id, contract.requirements, store, taskContext);
    const minConfB = minConfidence(b.worker_id, contract.requirements, store, taskContext);
    return minConfB - minConfA; // descending — highest confidence first
  });

  return { ranked, rejectionReasons };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the minimum confidence across all required capabilities for a worker.
 *
 * Returns 0 if there is no evidence for any required capability (absence = unknown).
 */
function minConfidence(
  workerId: string,
  requirements: ReadonlySet<Capability>,
  store: CapabilityStore,
  taskContext: TaskContext,
): number {
  if (requirements.size === 0) {
    return 1.0; // no requirements = perfect confidence
  }

  let min = Infinity;
  for (const cap of requirements) {
    const evidence = store.getEvidence(workerId, cap, taskContext);
    const conf = evidence?.confidence ?? 0;
    if (conf < min) {
      min = conf;
    }
  }
  return min === Infinity ? 0 : min;
}

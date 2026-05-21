/**
 * PLAN-5 T2 — Pure conflict-detection helpers.
 *
 * PURITY CONTRACT:
 *   - Imports ONLY `./types` and `./conflict-thresholds`.
 *   - No `async`, no Promises, no `await`.
 *   - No `better-sqlite3`, no `node:fs`, no `node:http`, no DB, no fetch.
 *   - No side effects: input arrays / sets are never mutated.
 *
 * REQ traceability:
 *   - tagJaccard / contentJaccard / isConflictCandidate → CONFLICT-02
 *   - cosine gate                                       → CONFLICT-04
 *   - resolveConflicts policies + K cap                 → CONFLICT-03
 *
 * Verified by `conflict-detection.test.ts` (10+ cases) and by a grep guard
 * in `conflict-workdir-isolation.test.ts` (T7) that scans this file's import
 * list and forbids any DB/HTTP/fs reference creeping in.
 */

import type { ScoredMemory, TrustLevel } from './types.js';
import {
  TAG_JAC_MIN,
  CONTENT_JAC_MAX,
  MIN_SHARED_TAGS,
  COSINE_GATE_MAX,
  RECALL_K_CAP,
} from './conflict-thresholds.js';

/**
 * Set-Jaccard similarity over two tag sets.
 * Empty ∩ empty → 0 (avoid NaN; matches `jaccard` in memory-store.ts:188).
 */
export function tagJaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Set-Jaccard similarity over two content-token sets. Caller pre-tokenizes
 * (mirrors existing `tokenize` at memory-store.ts:183) so this stays pure.
 */
export function contentJaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  return tagJaccard(a, b);
}

export interface ConflictCandidateInputs {
  /** Tag-set Jaccard. */
  readonly tagJac: number;
  /** Content-token-set Jaccard. */
  readonly contentJac: number;
  /** Number of tags shared between the two memories (intersection size). */
  readonly sharedTagCount: number;
  /**
   * Cosine similarity in [0, 1] when both peers have an embedding_blob;
   * undefined when either side is missing an embedding. Undefined degrades
   * to Jaccard-only verdict — DELTA-MEM-CONFLICT.md §4 W4 / PITFALL 2.5.
   */
  readonly cosine?: number;
  /**
   * Raw content of the two memories. Optional; when both provided, the
   * negation gate runs: a high content-Jaccard suppression is OVERRIDDEN
   * when exactly one side carries a negation marker (e.g. "use X" vs
   * "do not use X"). Without these strings the legacy Jaccard-only gate
   * stands. Closes HIGH codex finding: direct negations were being
   * suppressed as paraphrase-class duplicates.
   */
  readonly contentA?: string;
  readonly contentB?: string;
}

/**
 * Word-boundary negation markers. Case-insensitive. Catches direct verbal
 * negations ("not", "never", "don't") plus prohibitive verbs ("avoid",
 * "forbid") and copular negations ("isn't", "wasn't"). Deliberately scoped
 * to whole words to avoid matching tokens like "snapshot" or "another".
 */
const NEGATION_RE =
  /\b(?:not|no|never|don't|do not|avoid|stop|disable|reject|deny|forbid|prohibit|cannot|can't|won't|will not|shouldn't|should not|mustn't|must not|isn't|is not|aren't|are not|wasn't|was not|weren't|were not)\b/i;

/** True iff `content` contains at least one word-boundary negation marker. */
export function hasNegation(content: string): boolean {
  return NEGATION_RE.test(content);
}

/**
 * True iff exactly one of the two contents carries a negation marker.
 * Symmetric absence (both negated, neither negated) → false; asymmetric
 * presence → true. Used to override the content-Jaccard "paraphrase"
 * suppression for direct contradictions like "use X" vs "do not use X".
 */
export function hasAsymmetricNegation(a: string, b: string): boolean {
  return hasNegation(a) !== hasNegation(b);
}

/**
 * True iff a candidate pair meets the conflict gates:
 *   - tag_jaccard       > TAG_JAC_MIN     (substantial tag overlap)
 *   - content_jaccard   < CONTENT_JAC_MAX (content NOT a paraphrase)
 *   - shared_tag_count >= MIN_SHARED_TAGS (≥ 2 — guard against single-tag coincidence)
 *   - cosine            < COSINE_GATE_MAX (when both embeddings present; suppress paraphrase)
 *
 * Negation override: when `contentA` and `contentB` are both supplied and
 * exactly one side carries a negation marker, the content_jaccard ceiling
 * is bypassed. This catches "use X" vs "do not use X" pairs that share
 * almost all tokens yet are direct contradictions, not duplicates.
 *
 * When `cosine` is undefined the cosine gate is bypassed — Jaccard-only
 * verdict stands. This matches the Phase 4 degradation contract: missing
 * data never blocks a verdict.
 */
export function isConflictCandidate(inputs: ConflictCandidateInputs): boolean {
  if (inputs.sharedTagCount < MIN_SHARED_TAGS) return false;
  if (inputs.tagJac <= TAG_JAC_MIN) return false;
  if (inputs.contentJac >= CONTENT_JAC_MAX) {
    // Override gate: asymmetric negation flips a "duplicate" verdict back to
    // "candidate conflict". Without raw content the legacy verdict stands.
    if (
      inputs.contentA === undefined ||
      inputs.contentB === undefined ||
      !hasAsymmetricNegation(inputs.contentA, inputs.contentB)
    ) {
      return false;
    }
  }
  if (inputs.cosine !== undefined && inputs.cosine >= COSINE_GATE_MAX) return false;
  return true;
}

export type ConflictPolicy = 'annotate' | 'drop-lower-trust' | 'drop-all-conflicts';

export interface ResolveConflictsResult {
  /** Memories that survive the policy. Order matches input order. */
  readonly kept: readonly ScoredMemory[];
}

/**
 * Numeric rank for trust tier — used in precedence resolution.
 * Higher wins. trust → score → recency (CONFLICT-03, DELTA-MEM-CONFLICT.md §6).
 */
const TRUST_RANK: Record<TrustLevel, number> = {
  unverified: 0,
  provisional: 1,
  trusted: 2,
};

/**
 * Compare two ScoredMemory rows by precedence: trust > score > recency.
 * Returns positive if `a` wins (higher precedence), negative if `b` wins.
 */
function compareByPrecedence(a: ScoredMemory, b: ScoredMemory): number {
  const dt = TRUST_RANK[a.trust_level] - TRUST_RANK[b.trust_level];
  if (dt !== 0) return dt;
  const ds = a.score - b.score;
  if (ds !== 0) return ds;
  return a.accessed_at - b.accessed_at;
}

/**
 * PLAN-5 T2/T4 — Resolve conflicts among scored memories.
 *
 * Two-pass pure function:
 *   1. Pairwise scan over top RECALL_K_CAP rows (by sort order in input).
 *      Build an undirected graph of edges (i,j) where each row's
 *      `conflicts_with` includes the other's id.
 *   2. Apply policy:
 *        - 'annotate'           : both kept; winner gets `⚠ CONFLICTS WITH X`,
 *                                  loser gets `⚠ CONTRADICTED BY Y`.
 *        - 'drop-lower-trust'   : winner kept (no annotation), loser dropped
 *                                  UNLESS loser is pinned → kept with annotation.
 *        - 'drop-all-conflicts' : both dropped unless pinned (then annotated).
 *
 * Rows beyond RECALL_K_CAP in the input pass through un-annotated and un-dropped
 * (ROADMAP SC#5 / CONFLICT-03 — O(K²) bounded).
 *
 * Annotations carry the raw `memory_id` of the peer; the render layer
 * (`context/layers.ts` T6) translates UUID → `#N` 1-based index.
 *
 * Input array is NEVER mutated — fresh ScoredMemory objects are returned for
 * rows that receive annotations; non-annotated rows are returned by reference.
 */
export function resolveConflicts(
  memories: readonly ScoredMemory[],
  policy: ConflictPolicy
): ResolveConflictsResult {
  if (memories.length === 0) return { kept: [] };

  // Cap participation: only the top RECALL_K_CAP rows can produce / receive
  // conflict edges. Beyond that the row passes through unchanged.
  const cap = Math.min(memories.length, RECALL_K_CAP);
  const inCap: readonly ScoredMemory[] = memories.slice(0, cap);
  const beyondCap: readonly ScoredMemory[] = memories.slice(cap);

  // Build id → index map ONCE so candidate lookups in the pairwise pass are O(1).
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < inCap.length; i++) idToIdx.set(inCap[i]!.memory_id, i);

  // Pairwise pass — collect mutual edges only (require BOTH sides' conflicts_with
  // to reference each other; one-sided references are silently ignored to keep
  // dangling pointers safe — PITFALL 3.2 / DELTA-MEM-CONFLICT.md §4 W4).
  // Edges keyed by min,max index so each pair appears once.
  type Edge = { winner: number; loser: number };
  const edges: Edge[] = [];
  for (let i = 0; i < inCap.length; i++) {
    const ai = inCap[i]!;
    if (ai.conflicts_with.length === 0) continue;
    for (const peerId of ai.conflicts_with) {
      const j = idToIdx.get(peerId);
      if (j === undefined || j <= i) continue; // skip beyond-cap and self/dup edges
      const aj = inCap[j]!;
      if (!aj.conflicts_with.includes(ai.memory_id)) continue; // mutual-only
      // Resolve precedence — positive: i wins.
      const cmp = compareByPrecedence(ai, aj);
      if (cmp >= 0) edges.push({ winner: i, loser: j });
      else edges.push({ winner: j, loser: i });
    }
  }

  if (edges.length === 0) {
    // Fast path — no conflicts surfaced; return inputs unchanged.
    return { kept: memories };
  }

  // Per-index accumulator: annotations to attach + drop flag.
  // Use parallel arrays sized to `cap` so allocations are predictable.
  const annotByIdx: (string[] | null)[] = new Array(cap).fill(null);
  const dropByIdx: boolean[] = new Array(cap).fill(false);
  const dropAllByIdx: boolean[] = new Array(cap).fill(false);

  for (const e of edges) {
    const winner = inCap[e.winner]!;
    const loser = inCap[e.loser]!;

    switch (policy) {
      case 'annotate': {
        (annotByIdx[e.winner] ??= []).push(`⚠ CONFLICTS WITH ${loser.memory_id}`);
        (annotByIdx[e.loser] ??= []).push(`⚠ CONTRADICTED BY ${winner.memory_id}`);
        break;
      }
      case 'drop-lower-trust': {
        if (loser.pinned) {
          // Pinned never dropped — keep with annotation.
          (annotByIdx[e.loser] ??= []).push(`⚠ CONTRADICTED BY ${winner.memory_id}`);
        } else {
          dropByIdx[e.loser] = true;
        }
        // Winner kept silently (no annotation under drop policy).
        break;
      }
      case 'drop-all-conflicts': {
        if (winner.pinned) {
          (annotByIdx[e.winner] ??= []).push(`⚠ CONFLICTS WITH ${loser.memory_id}`);
        } else {
          dropAllByIdx[e.winner] = true;
        }
        if (loser.pinned) {
          (annotByIdx[e.loser] ??= []).push(`⚠ CONTRADICTED BY ${winner.memory_id}`);
        } else {
          dropAllByIdx[e.loser] = true;
        }
        break;
      }
    }
  }

  const kept: ScoredMemory[] = [];
  for (let i = 0; i < cap; i++) {
    if (dropByIdx[i] || dropAllByIdx[i]) continue;
    const annots = annotByIdx[i];
    if (annots && annots.length > 0) {
      // Return a copy with annotations set. Original object never mutated.
      kept.push({ ...inCap[i]!, annotations: annots });
    } else {
      kept.push(inCap[i]!);
    }
  }
  // Append the beyond-cap remainder unchanged.
  for (const m of beyondCap) kept.push(m);

  return { kept };
}

/**
 * Memory Engine — relevance scoring, token budgeting, temporal decay.
 *
 * Pure functions. No database access. No side effects.
 * All state comes in as parameters, results come out as return values.
 */

import type { Memory, MemoryType, ScoredMemory, RecallQuery, RecallResult } from './types.js';
import { TYPE_WEIGHTS, DECAY_HALF_LIFE_DAYS } from './types.js';
import { resolveConflicts } from './conflict-detection.js';

const MS_PER_DAY = 86_400_000;

/**
 * Estimate token count from text content.
 * Uses the standard ~4 chars per token heuristic.
 * Good enough to prevent bloat — not meant for billing precision.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Compute temporal decay based on time since last access.
 *
 * Uses exponential decay: score = exp(-t / halfLife)
 * - At t = 0:        score = 1.0
 * - At t = halfLife: score ≈ 0.37
 * - At t = 2×halfLife: score ≈ 0.14
 */
function computeRecency(accessedAt: number, now: number, memoryType: MemoryType): number {
  const daysSinceAccess = Math.max(0, (now - accessedAt) / MS_PER_DAY);
  const halfLife = DECAY_HALF_LIFE_DAYS[memoryType] ?? 7;
  return Math.exp(-daysSinceAccess / halfLife);
}

/**
 * Compute tag overlap between query tags and memory tags.
 * Returns 0-1. Uses Jaccard-like similarity: intersection / union.
 * Returns 0 if either set is empty (no tag filtering).
 */
function computeTagScore(memoryTags: readonly string[], queryTags: readonly string[]): number {
  if (queryTags.length === 0 || memoryTags.length === 0) return 0;

  const memSet = new Set(memoryTags);
  let intersection = 0;
  for (const tag of queryTags) {
    if (memSet.has(tag)) intersection++;
  }

  const union = new Set([...memoryTags, ...queryTags]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Compute keyword match score between query text and memory content.
 * Returns 0-1. Splits query into words, checks presence in content (case-insensitive).
 * Simple but effective — no NLP, no embeddings, no dependencies.
 */
function computeContentScore(content: string, query: string | undefined): number {
  if (!query || query.trim().length === 0) return 0;

  const contentLower = content.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return 0;

  let matches = 0;
  for (const word of words) {
    if (contentLower.includes(word)) matches++;
  }

  return matches / words.length;
}

/**
 * Per-component contributions to a memory's total relevance score.
 *
 * Each value is the WEIGHTED contribution actually added to the total
 * (i.e. raw_signal × weight), so summing all 7 fields equals `total`.
 * This makes the breakdown directly auditable by `relay memory why`.
 */
export interface ScoreComponents {
  readonly tag: number;
  readonly content: number;
  readonly recency: number;
  readonly type: number;
  readonly pin: number;
  readonly trust: number;
  readonly success: number;
}

export interface ScoreBreakdown {
  readonly total: number;
  readonly components: ScoreComponents;
}

/**
 * PLAN-4 T3 — Optional scoring overrides threaded from the impure boundary.
 *
 * `semanticSimilarity` (raw cosine in [-1, 1], clamped here to [0, 1])
 * REPLACES the word-overlap content signal when defined. When undefined,
 * the engine falls back to {@link computeContentScore} (word-overlap).
 *
 * Defined in-file (no extra import) — preserves engine purity: this module
 * imports ONLY from `./types` and uses only `./types`-exported constants.
 */
export interface ScoreOptions {
  readonly semanticSimilarity?: number;
}

/**
 * Score a single memory against a query AND return per-component contributions.
 *
 * Same scoring formula as `scoreMemory` — this is the canonical implementation.
 * `scoreMemory` is a thin wrapper that returns `.total`. Existing tests that
 * assert on `scoreMemory`'s numeric output remain unchanged because the formula
 * is identical and `total = sum(components)`.
 *
 * Modes:
 *   - With query (text or tags):
 *       tag × 0.35 + content × 0.15 + recency × 0.25 + type × 0.15 + pin × 0.10
 *       + trustBonus (raw) + successBonus (raw)
 *   - Without query (pure recency + type):
 *       recency × 0.45 + type × 0.35 + pin × 0.20
 *       + trustBonus (raw) + successBonus (raw)
 *
 * trust and success bonuses are added at full strength in both modes (their
 * "weight" is implicit in the raw value cap).
 *
 * PLAN-4 T3 — When `opts.semanticSimilarity` is a number (NOT undefined),
 * it REPLACES the word-overlap content signal. Defensive clamp to [0, 1]
 * guards against bad callers (embedding-client returns normalized vectors
 * and cosine ∈ [-1, 1]; we treat negatives as 0 since "anti-similar" is
 * not a useful recall signal). No-query branch ignores opts entirely —
 * similarity has no meaning without a query (preserves pre-change behavior).
 */
export function scoreMemoryDetailed(
  memory: Memory,
  query: RecallQuery,
  now: number,
  opts?: ScoreOptions
): ScoreBreakdown {
  const tagScore = computeTagScore(memory.tags, query.tags ?? []);
  // PLAN-4 T3 — semantic similarity, when provided, REPLACES word-overlap.
  // Clamp to [0, 1] defensively (embedding-client returns normalized vectors,
  // but cosine ∈ [-1, 1] in the general case; negative similarity is not a
  // useful recall signal). `undefined` falls through to word-overlap.
  const contentScore = opts?.semanticSimilarity !== undefined
    ? Math.max(0, Math.min(1, opts.semanticSimilarity))
    : computeContentScore(memory.content, query.query);
  const recencyScore = computeRecency(memory.accessed_at, now, memory.memory_type as MemoryType);
  const typeWeight = TYPE_WEIGHTS[memory.memory_type as MemoryType] ?? 0.5;
  const pinBonus = memory.pinned ? 0.5 : 0;
  // SHIP-67 — trust-tier bonus replaces raw recallBonus. trust_level is derived from
  // memory_source + success_recall_count + pinned (see computeTrustLevel in memory-store.ts).
  const trustBonus = memory.trust_level === 'trusted'     ? 0.15
                   : memory.trust_level === 'provisional' ? 0.05
                                                          : 0;
  // Continuous outcome signal: each successful recall adds 0.04, capped at 0.20.
  // Complements the discrete trust tier — a memory recalled 5 times outranks one recalled once,
  // even if both are 'trusted'. Drives memories that proved useful to the top of results.
  const successBonus = Math.min((memory.success_recall_count ?? 0) * 0.04, 0.20);

  // If no query text AND no tags provided, weight recency and type more heavily
  const hasQuery = (query.query && query.query.trim().length > 0) || (query.tags && query.tags.length > 0);

  if (!hasQuery) {
    const components: ScoreComponents = {
      tag: 0,
      content: 0,
      recency: recencyScore * 0.45,
      type: typeWeight * 0.35,
      pin: pinBonus * 0.20,
      trust: trustBonus,
      success: successBonus,
    };
    const total = components.tag + components.content + components.recency
                + components.type + components.pin + components.trust + components.success;
    return { total, components };
  }

  const components: ScoreComponents = {
    tag: tagScore * 0.35,
    content: contentScore * 0.15,
    recency: recencyScore * 0.25,
    type: typeWeight * 0.15,
    pin: pinBonus * 0.10,
    trust: trustBonus,
    success: successBonus,
  };
  const total = components.tag + components.content + components.recency
              + components.type + components.pin + components.trust + components.success;
  return { total, components };
}

/**
 * Score a single memory against a query.
 *
 * Combined score formula:
 *   score = tag_match × 0.35
 *         + content_match × 0.15
 *         + recency × 0.25
 *         + type_weight × 0.15
 *         + pin_bonus × 0.10
 *
 * Returns 0.0 to ~1.5 (pinned facts with perfect tag+content match).
 *
 * Internally delegates to `scoreMemoryDetailed` and returns `.total`.
 * Signature is preserved for backward compatibility with existing callers
 * and tests that assert on the numeric output. PLAN-4 T3 adds the optional
 * `opts` parameter — when omitted, behavior is byte-identical to the
 * pre-change result (regression-guarded by tests).
 */
export function scoreMemory(
  memory: Memory,
  query: RecallQuery,
  now: number,
  opts?: ScoreOptions
): number {
  return scoreMemoryDetailed(memory, query, now, opts).total;
}

/**
 * Select the highest-scoring memories that fit within a token budget.
 *
 * This is the core algorithm that prevents context bloat:
 * 1. Score all candidates
 * 2. Sort by score DESC
 * 3. Greedily pack into budget
 * 4. Return what fits + how much was omitted
 *
 * Never exceeds the budget. If a single memory exceeds the remaining budget,
 * it's skipped (not truncated) — we trade completeness for coherence.
 *
 * PLAN-4 T4 — optional `similarities` ReadonlyMap<memory_id, cosine> threads
 * pre-computed semantic similarities from the impure boundary
 * (computeSemanticSimilarities in semantic-similarities.ts). When a memory's
 * id is in the map, its similarity REPLACES the word-overlap content signal
 * via ScoreOptions; otherwise word-overlap is used. Empty map behaves
 * identically to no map (guards against callers passing `new Map()` "to be
 * safe"). `ReadonlyMap` (not `Map`) — engine never mutates input.
 */
export function budgetedRecall(
  memories: readonly Memory[],
  query: RecallQuery,
  now: number,
  similarities?: ReadonlyMap<string, number>
): RecallResult {
  const scored: ScoredMemory[] = memories.map(m => {
    const sim = similarities?.get(m.memory_id);
    return {
      ...m,
      score: scoreMemory(m, query, now, sim !== undefined ? { semanticSimilarity: sim } : undefined),
    };
  });

  // Sort by score DESC, then by accessed_at DESC for tiebreaking
  scored.sort((a, b) => b.score - a.score || b.accessed_at - a.accessed_at);

  const MIN_RELEVANCE_SCORE = 0.15;

  // Filter out low-relevance memories when a real query is present
  const hasSearchCriteria = (query.query && query.query.trim().length > 0) || (query.tags && query.tags.length > 0);
  const candidates = hasSearchCriteria ? scored.filter(m => m.pinned || m.score >= MIN_RELEVANCE_SCORE) : scored;

  // PLAN-5 T4 (CONFLICT-03) — pairwise pass between filter and pack loop.
  // Default policy 'annotate' (ANNOTATE_BOTH). Input is capped to
  // RECALL_K_CAP=32 inside resolveConflicts → O(K²) bounded sub-millisecond.
  // Pinned memories survive every drop policy (CONFLICT-03 invariant).
  // When no row carries conflicts_with the function returns inputs unchanged,
  // preserving pre-Phase-5 behavior bit-exactly.
  const policy = query.conflictPolicy ?? 'annotate';
  const { kept: resolved } = resolveConflicts(candidates, policy);

  const selected: ScoredMemory[] = [];
  let totalTokens = 0;
  // Count threshold-excluded memories so omitted_count reflects ALL exclusions
  // (includes conflict-dropped rows under drop policies).
  let omittedCount = scored.length - candidates.length + (candidates.length - resolved.length);

  for (const memory of resolved) {
    if (totalTokens + memory.token_count <= query.token_budget) {
      selected.push(memory);
      totalTokens += memory.token_count;
    } else {
      omittedCount++;
    }
  }

  // MED codex finding — pack-truncation dangling-annotation fix.
  // After packing, filter each kept memory's conflicts_with to peer IDs
  // actually present in `selected`. Otherwise the render layer (context/
  // layers.ts) would emit `⚠ CONFLICTS WITH #N` references to phantom peers
  // that got omitted under token-budget pressure.
  const selectedIds = new Set(selected.map((m) => m.memory_id));
  const packed: ScoredMemory[] = selected.map((m) => {
    if (m.conflicts_with.length === 0) return m;
    const peersPresent = m.conflicts_with.filter((id) => selectedIds.has(id));
    if (peersPresent.length === m.conflicts_with.length) return m;
    return { ...m, conflicts_with: peersPresent };
  });

  return {
    memories: packed,
    total_tokens: totalTokens,
    budget_remaining: query.token_budget - totalTokens,
    omitted_count: omittedCount,
  };
}

/**
 * PLAN-5 T2 — Conflict-detection threshold constants.
 *
 * Pure constants only. NO imports. Single source of truth for the numbers
 * that gate conflict detection at write time and recall time. Lifting them
 * here keeps the pure scoring helpers (`conflict-detection.ts`) free of any
 * magic numbers and lets a future operator override them via env without
 * editing detection logic.
 *
 * REQ traceability (REQUIREMENTS.md):
 *   - TAG_JAC_MIN, CONTENT_JAC_MAX, MIN_SHARED_TAGS → CONFLICT-02
 *   - COSINE_GATE_MAX                                → CONFLICT-04
 *   - RECALL_K_CAP                                   → CONFLICT-03 (ROADMAP SC#5)
 *   - WRITE_CANDIDATE_CAP                            → PITFALLS 3.1 write-time cost cap
 */

/**
 * Minimum tag-overlap Jaccard for two memories to be conflict candidates.
 * Below this we treat them as unrelated topics — no conflict possible.
 * REQ CONFLICT-02: "tag_jaccard > 0.5".
 */
export const TAG_JAC_MIN = 0.5;

/**
 * Maximum content-overlap Jaccard for two memories to be flagged as a
 * conflict. Above this they're paraphrases or near-duplicates (handled by
 * consolidate(), not conflict detection).
 * REQ CONFLICT-02: "content_jaccard < 0.3".
 */
export const CONTENT_JAC_MAX = 0.3;

/**
 * Minimum number of tags two memories must share before tag_jaccard is even
 * considered. Floor prevents two single-tag memories (jaccard = 0.5 via
 * 1∩1 / 1∪1 = 1.0, but tag set size = 1) from flagging on coincidental
 * topical overlap. REQ CONFLICT-02: "≥2 shared tags".
 */
export const MIN_SHARED_TAGS = 2;

/**
 * Maximum cosine similarity for a Jaccard-flagged pair to survive cosine
 * gating. Above this the pair is semantically equivalent (paraphrase) and
 * should NOT be flagged as a conflict. Below this the pair is semantically
 * distinct (genuine contradiction).
 * REQ CONFLICT-04: paraphrase suppression / "cosine < 0.7".
 */
export const COSINE_GATE_MAX = 0.7;

/**
 * Maximum number of same-workdir candidates considered at WRITE time when
 * computing conflicts for a newly inserted memory. Bounds detection cost to
 * O(WRITE_CANDIDATE_CAP) per write. PITFALLS 3.1.
 */
export const WRITE_CANDIDATE_CAP = 50;

/**
 * Maximum number of top-scoring memories considered for pairwise conflict
 * resolution at RECALL time. K=32 → O(K²)=1024 in-memory ID comparisons
 * per recall, sub-millisecond on typical hardware. Memories beyond rank 32
 * pass through to the budget packer un-annotated.
 * REQ CONFLICT-03, ROADMAP Phase 5 SC#5.
 */
export const RECALL_K_CAP = 32;

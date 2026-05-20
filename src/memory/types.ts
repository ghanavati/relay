/**
 * Memory system types — self-contained, no relay runtime imports.
 *
 * DESIGN: Types are flat and simple. No generics, no inheritance, no abstraction.
 * "No brittle type work" — just data shapes.
 */

export type MemoryType = 'fact' | 'decision' | 'lesson' | 'context' | 'state' | 'handoff' | 'session';

/** SHIP-64: which path wrote this memory — used for trust and audit. */
export type MemorySource = 'human' | 'auto-run-recorder' | 'worker-mcp' | 'unknown';

/**
 * SHIP-67: three-tier memory trust.
 * - unverified: auto-written, no successful recalls yet. Injected with [UNVERIFIED] prefix.
 * - provisional: human-written OR recalled by >=1 successful run. Normal injection.
 * - trusted: human-pinned OR recalled by >=3 successful runs. Gets +0.15 score boost.
 */
export type TrustLevel = 'unverified' | 'provisional' | 'trusted';

/**
 * Default TTL for auto-written (non-pinned) memory entries.
 * 30 days in milliseconds. Passed as expires_at by run-recorder
 * for lesson and handoff entries it writes automatically.
 *
 * This bounds unbounded growth (BUG-35) without evicting pinned or
 * manually-written entries.
 */
export const MEMORY_AUTO_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface MemoryRow {
  readonly memory_id: string;
  readonly memory_type: string;
  readonly content: string;
  readonly tags_json: string;      // JSON array of strings
  readonly workdir: string | null; // null = global
  readonly token_count: number;
  readonly pinned: number;         // SQLite boolean: 0 or 1
  readonly source_run_id: string | null;
  readonly git_ref: string | null;
  readonly superseded_by: string | null;
  readonly created_at: number;     // epoch ms
  readonly accessed_at: number;    // epoch ms — updated on every recall
  readonly expires_at: number | null;
  readonly entity_key: string | null; // named wiki page key — upsert uses this to supersede
  readonly sources_json: string;      // JSON array of source strings (run IDs, URLs, git refs)
  readonly recall_count: number;      // times this memory has been retrieved — drives confidence-based expiry
  readonly content_hash: string | null; // SHIP-58: first-16-hex of sha256(content+workdir+type), for 60s dedup
  readonly memory_source: MemorySource; // SHIP-64: which path wrote this memory
  readonly success_recall_count: number; // SHIP-61: incremented only when a successful run recalled this memory
  readonly files_json: string; // SHIP-52: JSON array of file paths this memory relates to
  readonly trust_level: string; // SHIP-67: 'unverified' | 'provisional' | 'trusted'
  readonly embedding_blob: Buffer | null; // PLAN-4 §5: 3072-byte float32 vector (768 dims) or NULL when not yet backfilled
  readonly embedding_model: string | null; // PLAN-4 T1: model id that produced embedding_blob — used for cross-model rejection (PITFALL 2.3). NULL = not yet embedded.
}

export interface Memory {
  readonly memory_id: string;
  readonly memory_type: MemoryType;
  readonly content: string;
  readonly tags: readonly string[];
  readonly workdir: string | null;
  readonly token_count: number;
  readonly pinned: boolean;
  readonly source_run_id: string | null;
  readonly git_ref: string | null;
  readonly created_at: number;
  readonly accessed_at: number;
  readonly expires_at: number | null;
  readonly entity_key: string | null;
  readonly sources: readonly string[];
  readonly recall_count: number;
  readonly memory_source: MemorySource;
  readonly success_recall_count: number;
  readonly files: readonly string[]; // SHIP-52: files this memory relates to
  readonly trust_level: TrustLevel; // SHIP-67: derived from source + success_recall_count + pinned
}

export interface ScoredMemory extends Memory {
  readonly score: number;
}

export interface RecallResult {
  readonly memories: readonly ScoredMemory[];
  readonly total_tokens: number;
  readonly budget_remaining: number;
  readonly omitted_count: number;
}

export interface RecallQuery {
  readonly query?: string;
  readonly tags?: readonly string[];
  readonly types?: readonly MemoryType[];
  readonly token_budget: number;
  readonly workdir?: string;       // '*' = all, undefined = current
  readonly include_expired?: boolean;
  readonly created_after?: number;   // epoch ms — lower bound on created_at
  readonly created_before?: number;  // epoch ms — upper bound on created_at
  readonly files?: readonly string[]; // SHIP-52: restrict to memories associated with these file paths
  readonly min_trust?: TrustLevel;    // T2: minimum trust tier — 'unverified' (default, no filter), 'provisional' (excludes unverified), 'trusted' (only trusted)
}

/** Weights per memory type for relevance scoring — higher = more relevant by default. */
export const TYPE_WEIGHTS: Readonly<Record<MemoryType, number>> = {
  fact: 1.0,
  lesson: 0.9,
  decision: 0.8,
  handoff: 0.7,
  context: 0.5,
  state: 0.3,
  session: 0.6,
};

/** Half-life in days for temporal decay per memory type. */
export const DECAY_HALF_LIFE_DAYS: Readonly<Record<MemoryType, number>> = {
  fact: 365,       // facts barely decay
  lesson: 90,      // lessons last a quarter
  decision: 60,    // decisions last two months
  handoff: 3,      // handoffs are session-scoped, decay fast
  context: 7,      // context decays in a week
  state: 1,        // state decays in a day
  session: 14,     // session summaries last two weeks
};

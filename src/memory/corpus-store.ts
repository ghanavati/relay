/**
 * CorpusStore — SHIP-53 — RAG-capable knowledge base via FTS5 MATCH on filtered memories.
 *
 * A corpus is a named, queryable bundle of memories filtered by tags/types/workdir/date.
 * `build()` assembles matching memories into a single content blob; `query()` runs
 * BM25 ranked search over that blob via SQLite FTS5. No vectors, no new dependencies
 * — everything stays in the same SQLite file.
 *
 * Design notes:
 * - The `corpora` table holds the bundled content; `corpora_fts` is its FTS5 shadow.
 * - Triggers (defined in `db.ts` DDL) keep FTS5 in sync on INSERT/UPDATE/DELETE.
 * - `build()` uses UPSERT so re-running with the same name replaces content atomically.
 * - `query()` sanitizes user input to prevent FTS5-operator injection
 *   (see `sanitizeFts5Query` for the phrase-quote strategy).
 */

import { getDb } from '../runtime/store/db.js';
import { MemoryStore } from './memory-store.js';
import type { RecallQuery, Memory } from './types.js';
import type Database from 'better-sqlite3';

/** A single ranked hit returned by `CorpusStore.query()`. */
export interface CorpusQueryResult {
  readonly snippet: string;    // FTS5 snippet with match highlights
  readonly rank: number;        // FTS5 rank (lower = more relevant; we negate for score)
  readonly score: number;       // -rank, so higher = more relevant
}

/** Metadata for a named corpus returned by `CorpusStore.list()`. */
export interface CorpusMeta {
  readonly name: string;
  readonly description: string | null;
  readonly built_at: number;
  readonly built_from_count: number;
}

/**
 * Sanitize a user-supplied FTS5 query string.
 *
 * FTS5 MATCH supports an operator DSL (`AND`, `OR`, `NOT`, `NEAR`, `"..."`, `*`, `^`, `(`).
 * Raw user input can hit that DSL and produce injection-like behavior (NEAR/100 over the
 * whole corpus, unexpected phrase matches). We split on whitespace, strip quotes, and
 * wrap each token in phrase-quotes — FTS5 treats `"tok1" "tok2"` as implicit AND of
 * phrase matches, which is safe and matches user intent ("find documents with all of
 * these words").
 */
export function sanitizeFts5Query(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const tokens = trimmed
    .split(/\s+/u)
    .map(t => t.replace(/"/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map(t => `"${t}"`).join(' ');
}

/**
 * Format a single Memory as one paragraph in the corpus content blob.
 * The format is stable so FTS5 tokenization produces predictable results,
 * and the output stays readable for the `snippet()` highlighter.
 */
function formatMemoryForCorpus(m: Memory): string {
  const tags = m.tags.length > 0 ? ` tags: ${m.tags.join(', ')}` : '';
  const workdir = m.workdir ? ` workdir: ${m.workdir}` : '';
  return `[${m.memory_type}]${tags}${workdir}\n${m.content}`;
}

export class CorpusStore {
  private readonly db: Database.Database;

  constructor() {
    this.db = getDb();
  }

  /**
   * Assemble a named corpus from filtered memories. Upsert semantics: re-running with
   * the same name replaces the existing corpus atomically. Returns the number of
   * memories included.
   */
  build(name: string, description: string | null, filter: RecallQuery): number {
    if (!name || !name.trim()) throw new Error('corpus name must be non-empty');

    const memStore = new MemoryStore();
    const rawMemories = memStore.getCandidates(filter);
    // getCandidates applies SQL-level filters (type, workdir, date, expiry, files)
    // but NOT tag filtering (tags_json is a JSON array — filtered in JS after load).
    // For a corpus to be a meaningfully filtered bundle, apply tag intersection here.
    const memories = (filter.tags && filter.tags.length > 0)
      ? rawMemories.filter(m => filter.tags!.some(t => m.tags.includes(t)))
      : rawMemories;
    const content = memories.map(formatMemoryForCorpus).join('\n\n');

    // DoS guard (security-reviewer finding 2026-04-16): a caller with an unbounded
    // token_budget can OOM the process or produce a multi-GB SQLite row. Cap the
    // serialized corpus at 10MB. Callers needing larger corpora should tier by tag
    // or workdir into multiple smaller corpora.
    const MAX_CORPUS_BYTES = 10 * 1024 * 1024;
    const byteLen = Buffer.byteLength(content, 'utf8');
    if (byteLen > MAX_CORPUS_BYTES) {
      throw new Error(
        `corpus "${name}" content is ${byteLen} bytes, exceeds ${MAX_CORPUS_BYTES} byte limit — narrow the filter`
      );
    }

    const now = Date.now();
    const filterJson = JSON.stringify(filter);

    // UPSERT via ON CONFLICT on the primary key `name`. The FTS5 insert trigger fires
    // on the INSERT; the update trigger fires on the content update path. Either way
    // the shadow table stays in sync.
    this.db.prepare(
      `INSERT INTO corpora (name, description, filter_json, content, built_at, built_from_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         description      = excluded.description,
         filter_json      = excluded.filter_json,
         content          = excluded.content,
         built_at         = excluded.built_at,
         built_from_count = excluded.built_from_count`
    ).run(name, description, filterJson, content, now, memories.length);

    return memories.length;
  }

  /**
   * FTS5 MATCH-ranked search over a named corpus. Returns snippets of matching
   * memories, highest-rank first.
   *
   * User queries are sanitized through `sanitizeFts5Query` — FTS5 operator DSL is
   * not exposed to callers. Use `limit` to cap result count (default 10).
   */
  query(name: string, queryText: string, limit = 10): CorpusQueryResult[] {
    if (!queryText.trim()) return [];
    const safeQuery = sanitizeFts5Query(queryText);
    if (!safeQuery) return [];

    const rows = this.db.prepare(
      `SELECT snippet(corpora_fts, 0, '[', ']', '…', 24) AS snippet,
              rank
       FROM corpora_fts
       WHERE corpora_fts MATCH ? AND name = ?
       ORDER BY rank
       LIMIT ?`
    ).all(safeQuery, name, limit) as Array<{ snippet: string; rank: number }>;

    return rows.map(row => ({
      snippet: row.snippet,
      rank: row.rank,
      score: -row.rank,
    }));
  }

  /** List all known corpora, most recently built first. */
  list(): CorpusMeta[] {
    return this.db.prepare(
      `SELECT name, description, built_at, built_from_count
       FROM corpora
       ORDER BY built_at DESC`
    ).all() as CorpusMeta[];
  }

  /** Delete a corpus by name. Returns true if a row was removed. */
  remove(name: string): boolean {
    const result = this.db.prepare('DELETE FROM corpora WHERE name = ?').run(name);
    return result.changes > 0;
  }

  /** Fetch a single corpus's metadata by name; returns null if not found. */
  get(name: string): CorpusMeta | null {
    const row = this.db.prepare(
      `SELECT name, description, built_at, built_from_count
       FROM corpora
       WHERE name = ?`
    ).get(name) as CorpusMeta | undefined;
    return row ?? null;
  }
}

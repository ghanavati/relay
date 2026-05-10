/**
 * MemoryStore — SQLite CRUD for the memories table.
 *
 * All operations are SYNCHRONOUS (better-sqlite3).
 * No relay runtime imports — self-contained for future extraction.
 */

import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '../runtime/store/db.js';
import type { MemoryRow, MemoryType, Memory, RecallQuery, MemorySource, TrustLevel } from './types.js';
import { estimateTokens } from './memory-engine.js';
import type Database from 'better-sqlite3';
import { redactSecrets } from '../security/redaction.js';
import { makeError, toRelayException } from '../errors.js';

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;
const MAX_CONTENT_LENGTH = 100_000; // characters (~25K tokens)
const MAX_MEMORY_TOKENS = Number(process.env['RELAY_MAX_MEMORY_TOKENS'] ?? 100_000);
const AUTOPIN_THRESHOLD = Number(process.env['RELAY_MEMORY_AUTOPIN_THRESHOLD'] ?? 3);

/**
 * SHIP-67 — Pure function deriving a memory's current trust tier from its state.
 * Kept pure + exported so tests can assert directly without DB setup.
 *
 * Rules (in precedence order):
 * 1. Human-pinned  → trusted   (explicit human endorsement)
 * 2. success_recall_count >= 3 → trusted   (proven useful across 3+ successful runs)
 * 3. memory_source === 'human' OR success_recall_count >= 1 → provisional
 * 4. Otherwise → unverified
 */
export function computeTrustLevel(
  source: MemorySource,
  successRecallCount: number,
  pinned: boolean
): TrustLevel {
  if (source === 'human' && pinned) return 'trusted';
  if (successRecallCount >= AUTOPIN_THRESHOLD) return 'trusted';
  if (source === 'human' || successRecallCount >= 1) return 'provisional';
  return 'unverified';
}

/** Strip <private> blocks, redact secrets, and cap length before writing to DB. */
function sanitizeContent(raw: string): string {
  const stripped = redactSecrets(raw.replace(PRIVATE_TAG_RE, '').trim());
  return stripped.length > MAX_CONTENT_LENGTH ? stripped.slice(0, MAX_CONTENT_LENGTH) : stripped;
}

/** SHIP-70: block cross-workdir access when RELAY_MEMORY_ALLOWED_WORKDIRS is set. */
function assertWorkdirAllowed(workdir: string | null | undefined): void {
  const allowed = process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
  if (!allowed) return;
  if (!workdir || workdir === '*') {
    throw toRelayException(makeError('MEMORY_WORKDIR_FORBIDDEN', 'Cross-workdir memory access is not permitted in this context', false));
  }
  const allowedList = allowed.split(':').map(p => p.trim()).filter(Boolean);
  if (!allowedList.some(p => workdir === p || workdir.startsWith(p + '/'))) {
    throw toRelayException(makeError('MEMORY_WORKDIR_FORBIDDEN', `Workdir not in RELAY_MEMORY_ALLOWED_WORKDIRS: ${workdir}`, false));
  }
}

const STOPWORDS = new Set(['the','a','an','is','was','for','to','of','in','on','and','or','it','this','that','with','from','not','but','are','have','has','been','will','can','its','by','at','be','as','if','so','we','do']);
function extractKeywords(text: string): string[] {
  return [...new Set(
    text.toLowerCase().split(/[\W_]+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w))
  )].slice(0, 8);
}

/**
 * T7: Escape SQL LIKE wildcards (`%`, `_`) and the escape char (`\`) so that a
 * raw user value matches itself literally. Pair with `LIKE ? ESCAPE '\\'` in
 * the query, otherwise a tag like `pi_` would silently match `pii`, `pix`, etc.
 */
function escapeLikeWildcards(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    memory_id: row.memory_id,
    memory_type: row.memory_type as MemoryType,
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
    workdir: row.workdir,
    token_count: row.token_count,
    pinned: row.pinned === 1,
    source_run_id: row.source_run_id,
    git_ref: row.git_ref,
    created_at: row.created_at,
    accessed_at: row.accessed_at,
    expires_at: row.expires_at,
    entity_key: row.entity_key,
    sources: JSON.parse(row.sources_json ?? '[]') as string[],
    recall_count: row.recall_count ?? 0,
    memory_source: (row.memory_source ?? 'unknown') as MemorySource,
    success_recall_count: row.success_recall_count ?? 0,
    files: JSON.parse(row.files_json ?? '[]') as string[],
    trust_level: computeTrustLevel(
      (row.memory_source ?? 'unknown') as MemorySource,
      row.success_recall_count ?? 0,
      row.pinned === 1
    ),
  };
}

/** Lint result describing a candidate for merge or expiration. */
export interface LintEntry {
  readonly entity_key: string | null;
  readonly memory_ids: readonly string[];
  readonly reason: 'duplicate_entity_key' | 'stale_auto_entry' | 'stale_pinned_entry' | 'contradictory_lessons';
  readonly suggestion: string;
}

export class MemoryStore {
  private readonly db: Database.Database;
  private readonly maxAutoAgeMs: number;

  constructor() {
    this.db = getDb();
    const ttlDays = parseInt(process.env["RELAY_MEMORY_TTL_DAYS"] ?? "30", 10);
    this.maxAutoAgeMs = Number.isFinite(ttlDays) && ttlDays > 0
      ? ttlDays * 24 * 60 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000;
  }

  /** SHIP-66: cap writes per run_id in a 5-minute window to prevent flooding. */
  private assertWriteRateLimit(source_run_id: string | undefined): void {
    if (!source_run_id) return;
    const max = parseInt(process.env['RELAY_MEMORY_MAX_WRITES_PER_RUN'] ?? '10', 10);
    const window = Date.now() - 5 * 60 * 1000;
    const count = (this.db.prepare(
      `SELECT COUNT(*) as n FROM memories WHERE source_run_id = ? AND created_at > ?`
    ).get(source_run_id, window) as { n: number }).n;
    if (count >= max) {
      throw toRelayException(makeError(
        'MEMORY_WRITE_RATE_EXCEEDED',
        `Run ${source_run_id} has written ${count} memories in 5 minutes (max ${max})`,
        false
      ));
    }
  }

  /**
   * Store a new memory. Returns the generated memory_id.
   *
   * Token count is estimated automatically from content length.
   * accessed_at is initialized to created_at.
   */
  remember(params: {
    content: string;
    memory_type: MemoryType;
    tags?: readonly string[];
    workdir?: string | null;
    pinned?: boolean;
    source_run_id?: string;
    git_ref?: string;
    expires_at?: number | null;
    entity_key?: string | null;
    sources?: readonly string[];
    memory_source?: MemorySource;
    files?: readonly string[];
  }): string {
    this.assertWriteRateLimit(params.source_run_id);
    assertWorkdirAllowed(params.workdir);
    const memoryId = randomUUID();
    const now = Date.now();
    const content = sanitizeContent(params.content);
    const tokenCount = estimateTokens(content);
    const mergedTags = [...new Set([...(params.tags ?? []), ...extractKeywords(content)])];

    // SHIP-58: 60-second content-hash dedup — prevents duplicate writes from retries
    const contentHash = createHash('sha256')
      .update(content.slice(0, 500) + (params.workdir ?? '') + params.memory_type)
      .digest('hex').slice(0, 16);
    const dupe = this.db.prepare(
      `SELECT memory_id FROM memories WHERE content_hash = ? AND created_at > ? AND superseded_by IS NULL`
    ).get(contentHash, now - 60_000) as { memory_id: string } | undefined;
    if (dupe) return dupe.memory_id;

    // T1 — stamp the computed trust_level at insert time so the SQL filter in
    // getCandidates() (memory-store.ts:515) sees a consistent column value
    // immediately, not only after upgradeTrust() runs. Without this, a freshly
    // inserted `memory_source='human'` row keeps the DB-default 'unverified'
    // value and gets filtered out by --min-trust=provisional even though
    // computeTrustLevel('human', 0, false) === 'provisional'.
    const initialTrustLevel = computeTrustLevel(
      (params.memory_source ?? 'unknown') as MemorySource,
      0,
      params.pinned === true,
    );
    this.db
      .prepare(
        `INSERT INTO memories (
          memory_id, memory_type, content, tags_json, workdir,
          token_count, pinned, source_run_id, git_ref,
          superseded_by, created_at, accessed_at, expires_at,
          entity_key, sources_json, content_hash, memory_source, files_json,
          trust_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        memoryId,
        params.memory_type,
        content,
        JSON.stringify(mergedTags),
        params.workdir ?? null,
        tokenCount,
        params.pinned ? 1 : 0,
        params.source_run_id ?? null,
        params.git_ref ?? null,
        now,
        now,
        params.expires_at ?? null,
        params.entity_key ?? null,
        JSON.stringify(params.sources ?? []),
        contentHash,
        params.memory_source ?? 'unknown',
        JSON.stringify(params.files ?? []),
        initialTrustLevel,
      );

    this.gcByTokenBudget();
    return memoryId;
  }

  /**
   * Upsert a named wiki-page memory entry.
   *
   * Finds any existing non-superseded entry with the same entity_key + workdir,
   * marks it superseded, then writes a fresh entry with the new content.
   * This keeps one canonical entry per entity rather than accumulating
   * append-only logs (BUG-35 fix via Karpathy wiki pattern).
   *
   * Returns the new memory_id.
   */
  upsert(params: {
    entity_key: string;
    content: string;
    memory_type: MemoryType;
    tags?: readonly string[];
    workdir?: string | null;
    pinned?: boolean;
    source_run_id?: string;
    git_ref?: string;
    expires_at?: number | null;
    sources?: readonly string[];
    memory_source?: MemorySource;
    files?: readonly string[];
  }): string {
    this.assertWriteRateLimit(params.source_run_id);
    assertWorkdirAllowed(params.workdir);
    const now = Date.now();
    const workdir = params.workdir ?? null;

    const upsertTx = this.db.transaction((): string => {
      // Supersede any existing active entry with the same entity_key + workdir
      const existingRows = this.db
        .prepare(
          `SELECT memory_id FROM memories
           WHERE entity_key = ? AND (workdir IS ? OR workdir = ?)
             AND superseded_by IS NULL`
        )
        .all(params.entity_key, workdir, workdir) as Array<{ memory_id: string }>;

      const newId = randomUUID();
      for (const row of existingRows) {
        this.db
          .prepare('UPDATE memories SET superseded_by = ? WHERE memory_id = ?')
          .run(newId, row.memory_id);
      }

      // Write fresh entry
      const content = sanitizeContent(params.content);
      const tokenCount = estimateTokens(content);
      this.db
        .prepare(
          `INSERT INTO memories (
            memory_id, memory_type, content, tags_json, workdir,
            token_count, pinned, source_run_id, git_ref,
            superseded_by, created_at, accessed_at, expires_at,
            entity_key, sources_json, memory_source, files_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          newId,
          params.memory_type,
          content,
          JSON.stringify([...new Set([...(params.tags ?? []), ...extractKeywords(content)])]),
          workdir,
          tokenCount,
          params.pinned ? 1 : 0,
          params.source_run_id ?? null,
          params.git_ref ?? null,
          now,
          now,
          params.expires_at ?? null,
          params.entity_key,
          JSON.stringify(params.sources ?? []),
          params.memory_source ?? 'unknown',
          JSON.stringify(params.files ?? []),
        );

      return newId;
    });

    const newId = upsertTx();
    // Auto-purge superseded rows older than 30 days on each upsert.
    // Prevents unbounded accumulation of stale entries (BUG-35 / R-05 addendum).
    try {
      this.db
        .prepare('DELETE FROM memories WHERE superseded_by IS NOT NULL AND created_at < ?')
        .run(Date.now() - this.maxAutoAgeMs);
    } catch {
      // Non-critical maintenance — never fail a write due to purge error.
    }
    return newId;
  }

  /**
   * Lint the memory store for health issues.
   *
   * Returns entries that are candidates for expiration or merging:
   * - Duplicate entity keys (shouldn't happen after upsert migration, but detects pre-existing data)
   * - Stale auto-written entries older than 30 days with no recent access
   *
   * Does NOT modify any data — callers decide what to do with results.
   */
  lint(workdir?: string): LintEntry[] {
    const results: LintEntry[] = [];
    const thirtyDaysAgo = Date.now() - this.maxAutoAgeMs;

    // Duplicate entity keys: entity_key is not null, multiple active entries with same key+workdir
    const dupQuery = workdir
      ? `SELECT entity_key, GROUP_CONCAT(memory_id) as ids, COUNT(*) as cnt
         FROM memories
         WHERE entity_key IS NOT NULL AND superseded_by IS NULL
           AND (workdir = ? OR workdir IS NULL)
         GROUP BY entity_key, workdir
         HAVING cnt > 1`
      : `SELECT entity_key, GROUP_CONCAT(memory_id) as ids, COUNT(*) as cnt
         FROM memories
         WHERE entity_key IS NOT NULL AND superseded_by IS NULL
         GROUP BY entity_key, workdir
         HAVING cnt > 1`;

    const dupRows = workdir
      ? (this.db.prepare(dupQuery).all(workdir) as Array<{ entity_key: string; ids: string; cnt: number }>)
      : (this.db.prepare(dupQuery).all() as Array<{ entity_key: string; ids: string; cnt: number }>);

    for (const row of dupRows) {
      results.push({
        entity_key: row.entity_key,
        memory_ids: row.ids.split(','),
        reason: 'duplicate_entity_key',
        suggestion: `Run upsert() to consolidate ${row.cnt} entries for entity_key "${row.entity_key}"`,
      });
    }

    // Stale auto-written entries: tags_json includes "auto", not pinned, accessed > 30 days ago
    const staleQuery = workdir
      ? `SELECT memory_id FROM memories
         WHERE pinned = 0 AND superseded_by IS NULL
           AND tags_json LIKE '%"auto"%'
           AND accessed_at < ?
           AND (workdir = ? OR workdir IS NULL)`
      : `SELECT memory_id FROM memories
         WHERE pinned = 0 AND superseded_by IS NULL
           AND tags_json LIKE '%"auto"%'
           AND accessed_at < ?`;

    const staleRows = workdir
      ? (this.db.prepare(staleQuery).all(thirtyDaysAgo, workdir) as Array<{ memory_id: string }>)
      : (this.db.prepare(staleQuery).all(thirtyDaysAgo) as Array<{ memory_id: string }>);

    if (staleRows.length > 0) {
      results.push({
        entity_key: null,
        memory_ids: staleRows.map(r => r.memory_id),
        reason: 'stale_auto_entry',
        suggestion: `${staleRows.length} auto-written entries not accessed in 30+ days — consider expiring via forget() or running with expires_at`,
      });
    }

    // Stale pinned entries: pinned, no expires_at, not accessed in 30+ days
    const pinnedQuery = workdir
      ? `SELECT memory_id FROM memories
         WHERE pinned = 1 AND superseded_by IS NULL
           AND expires_at IS NULL AND accessed_at < ?
           AND (workdir = ? OR workdir IS NULL)`
      : `SELECT memory_id FROM memories
         WHERE pinned = 1 AND superseded_by IS NULL
           AND expires_at IS NULL AND accessed_at < ?`;

    const pinnedRows = workdir
      ? (this.db.prepare(pinnedQuery).all(thirtyDaysAgo, workdir) as Array<{ memory_id: string }>)
      : (this.db.prepare(pinnedQuery).all(thirtyDaysAgo) as Array<{ memory_id: string }>);

    if (pinnedRows.length > 0) {
      results.push({
        entity_key: null,
        memory_ids: pinnedRows.map(r => r.memory_id),
        reason: 'stale_pinned_entry',
        suggestion: `${pinnedRows.length} pinned entries not accessed in 30+ days — run "relay memory gc" to soft-delete`,
      });
    }

    // Contradictory lessons: same entity_key stem, one success + one failure both active
    const lessonRows = this.db.prepare(
      `SELECT entity_key, tags_json FROM memories
       WHERE memory_type = 'lesson' AND superseded_by IS NULL AND entity_key IS NOT NULL
       ${workdir ? 'AND (workdir = ? OR workdir IS NULL)' : ''}`
    ).all(...(workdir ? [workdir] : [])) as Array<{ entity_key: string; tags_json: string }>;

    const stems = new Map<string, { hasSuccess: boolean; hasFailure: boolean }>();
    for (const row of lessonRows) {
      const stem = row.entity_key.replace(/:success$|:failure$|:error$/, '');
      const tags: string[] = JSON.parse(row.tags_json) as string[];
      const entry = stems.get(stem) ?? { hasSuccess: false, hasFailure: false };
      if (tags.includes('success')) entry.hasSuccess = true;
      if (tags.includes('failure') || tags.includes('error')) entry.hasFailure = true;
      stems.set(stem, entry);
    }
    for (const [stem, entry] of stems) {
      if (entry.hasSuccess && entry.hasFailure) {
        results.push({
          entity_key: stem,
          memory_ids: [],
          reason: 'contradictory_lessons',
          suggestion: `Conflicting success+failure lessons for "${stem}" — run upsert() with a consolidated entry`,
        });
      }
    }

    return results;
  }

  /**
   * Retrieve all candidate memories for a recall query.
   *
   * When query.query is present, uses FTS5 for semantic ranking: results are
   * ordered by relevance rather than recency. Falls back to recency ordering if
   * FTS returns no results (empty index, fresh DB) or FTS is unavailable.
   *
   * Hard filters (type, workdir, expiry) are applied in both paths.
   * Scoring and token budgeting happen in the engine layer.
   */
  getCandidates(query: RecallQuery): Memory[] {
    assertWorkdirAllowed(query.workdir);
    // FTS path: use semantic ranking when a text query is provided
    if (query.query) {
      try {
        const ftsRows = this.db
          .prepare(`SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank`)
          .all(query.query) as Array<{ memory_id: string }>;

        if (ftsRows.length > 0) {
          const rankedIds = ftsRows.map(r => r.memory_id);
          return this.fetchByIds(rankedIds, query);
        }
      } catch {
        // FTS table absent (migrations not yet run on this DB) — fall through
      }
    }

    // Non-FTS path: recency ordering, up to 500 candidates
    const { where, params } = this.buildWhereClause(query);
    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY accessed_at DESC LIMIT 500`)
      .all(...(params as Parameters<Database.Statement['all']>)) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  /**
   * Fetch memories by ID list (from FTS), applying standard filters, preserving FTS rank order.
   */
  private fetchByIds(rankedIds: string[], query: RecallQuery): Memory[] {
    const { where, params } = this.buildWhereClause(query);
    const idPlaceholders = rankedIds.map(() => '?').join(', ');
    const idWhere = where
      ? `${where} AND memory_id IN (${idPlaceholders})`
      : `WHERE memory_id IN (${idPlaceholders})`;

    const rows = this.db
      .prepare(`SELECT * FROM memories ${idWhere}`)
      .all(...(params as Parameters<Database.Statement['all']>), ...rankedIds) as MemoryRow[];

    const idToRank = new Map(rankedIds.map((id, i) => [id, i]));
    rows.sort((a, b) => (idToRank.get(a.memory_id) ?? 999) - (idToRank.get(b.memory_id) ?? 999));
    return rows.map(rowToMemory);
  }

  /**
   * Build the shared WHERE clause and params array for standard filters.
   */
  private buildWhereClause(query: RecallQuery): { where: string; params: unknown[] } {
    const conditions: string[] = ['superseded_by IS NULL'];
    const params: unknown[] = [];

    if (query.types && query.types.length > 0) {
      const placeholders = query.types.map(() => '?').join(', ');
      conditions.push(`memory_type IN (${placeholders})`);
      params.push(...query.types);
    }

    if (query.workdir !== undefined && query.workdir !== '*') {
      conditions.push('(workdir = ? OR workdir IS NULL)');
      params.push(query.workdir);
    }

    if (!query.include_expired) {
      conditions.push('(expires_at IS NULL OR expires_at > ?)');
      params.push(Date.now());
    }

    if (query.created_after !== undefined) {
      conditions.push('created_at >= ?');
      params.push(query.created_after);
    }
    if (query.created_before !== undefined) {
      conditions.push('created_at <= ?');
      params.push(query.created_before);
    }
    // SHIP-52: files filter — each path matched via LIKE on the files_json array.
    // LIKE wildcards (% and _) and backslash in the path are escaped, otherwise
    // a path like "src/%" would match any memory (reviewer finding 2026-04-16).
    if (query.files && query.files.length > 0) {
      for (const path of query.files) {
        const escaped = path.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        conditions.push(`files_json LIKE ? ESCAPE '\\'`);
        params.push(`%"${escaped}"%`);
      }
    }

    // T2: trust-tier filter — SessionStart hooks default to 'provisional' so
    // raw auto-extracted entries are excluded until a successful recall promotes them.
    // 'unverified' is the absence of a filter (returns everything).
    if (query.min_trust === 'trusted') {
      conditions.push(`trust_level = 'trusted'`);
    } else if (query.min_trust === 'provisional') {
      conditions.push(`trust_level IN ('provisional', 'trusted')`);
    }

    return { where: `WHERE ${conditions.join(' AND ')}`, params };
  }

  /**
   * Update accessed_at and recall_count for a set of memories.
   * Called after recall to keep accessed memories fresh.
   *
   * Confidence-based expiry: auto entries (expires_at IS NOT NULL) that get recalled
   * have their expiry extended by 30 days. A memory recalled repeatedly never expires;
   * one never recalled dies on its original schedule.
   */
  /** SHIP-61 — increment success_recall_count for memories recalled by a successful run.
   *  Auto-pins when success_recall_count reaches 3: pinned entries are excluded from
   *  gcByTokenBudget(), making proven memories structurally un-evictable.
   *
   *  T14 (memory poisoning fence): entries tagged `auto-extract` are explicitly
   *  excluded from auto-pinning regardless of recall count. Auto-extracted entries
   *  come from low-trust sources (transcript scraping) and must never graduate to
   *  `trusted` purely via recall — only an explicit human action (pin) or a
   *  human-sourced write can mark them trusted. The `tags_json LIKE '%"auto-extract"%'`
   *  match relies on the tag being JSON-encoded as a quoted string in the array. */
  markRecallSuccess(memoryIds: readonly string[]): void {
    if (memoryIds.length === 0) return;
    const update = this.db.prepare('UPDATE memories SET success_recall_count = success_recall_count + 1 WHERE memory_id = ?');
    const autoPin = this.db.prepare(
      `UPDATE memories SET pinned = 1
       WHERE memory_id = ?
         AND success_recall_count >= ${AUTOPIN_THRESHOLD}
         AND pinned = 0
         AND tags_json NOT LIKE '%"auto-extract"%'`
    );
    for (const id of memoryIds) {
      update.run(id);
      autoPin.run(id);
    }
  }

  /** Demote a previously auto-pinned memory: clear pin flag and reset success_recall_count to 0.
   *  Use when a recalled memory proved incorrect. After demotion it becomes eligible for GC again. */
  demoteMemory(memoryId: string): void {
    this.db.prepare(
      'UPDATE memories SET pinned = 0, success_recall_count = 0, trust_level = ? WHERE memory_id = ?'
    ).run('unverified', memoryId);
  }

  /** SHIP-67 — write the current computed trust_level back to the DB column (used for SQL-level filtering). */
  upgradeTrust(memoryId: string): void {
    const row = this.db.prepare(
      'SELECT memory_source, success_recall_count, pinned FROM memories WHERE memory_id = ?'
    ).get(memoryId) as { memory_source: string; success_recall_count: number; pinned: number } | undefined;
    if (!row) return;
    const level = computeTrustLevel(
      (row.memory_source ?? 'unknown') as MemorySource,
      row.success_recall_count ?? 0,
      row.pinned === 1
    );
    this.db.prepare('UPDATE memories SET trust_level = ? WHERE memory_id = ?').run(level, memoryId);
  }

  /** SHIP-63 — copy a workdir-scoped memory to global scope (workdir: null) with provenance tags. */
  promote(memoryId: string): string | null {
    const memory = this.getMemory(memoryId);
    if (!memory) return null;
    return this.remember({
      content: memory.content,
      memory_type: memory.memory_type,
      tags: [...memory.tags, 'promoted', `from:${memory.workdir ?? 'global'}`],
      workdir: null,
      pinned: memory.pinned,
    });
  }

  /** SHIP-65 — append to memory read audit log. Best-effort, never throws on empty input. */
  logReads(memoryIds: readonly string[], opts: { run_id?: string; source?: string; workdir?: string }): void {
    if (memoryIds.length === 0) return;
    const stmt = this.db.prepare('INSERT INTO memory_reads (memory_id, run_id, read_source, workdir, created_at) VALUES (?, ?, ?, ?, ?)');
    const now = Date.now();
    for (const id of memoryIds) {
      stmt.run(id, opts.run_id ?? null, opts.source ?? 'mcp', opts.workdir ?? null, now);
    }
  }

  touchMemories(memoryIds: readonly string[]): void {
    if (memoryIds.length === 0) return;
    const now = Date.now();
    const extendedExpiry = now + this.maxAutoAgeMs;
    const stmt = this.db.prepare(
      `UPDATE memories
       SET accessed_at = ?,
           recall_count = recall_count + 1,
           expires_at = CASE WHEN expires_at IS NOT NULL THEN ? ELSE expires_at END
       WHERE memory_id = ?`
    );
    for (const id of memoryIds) {
      stmt.run(now, extendedExpiry, id);
    }
  }

  /**
   * Get a single memory by ID.
   */
  getMemory(memoryId: string): Memory | null {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE memory_id = ? AND superseded_by IS NULL')
      .get(memoryId) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  /**
   * Forget (delete) a memory by id.
   *
   * Soft (default): sets `superseded_by = 'forget'` — the row is preserved for audit
   * but excluded from recall/get/count.
   * Hard: physically removes the row. The FTS5 delete trigger
   * (`memories_fts_delete`) cleans the FTS index automatically.
   *
   * Returns `{found, mode}` where `found` is true iff a row was affected.
   * Soft-mode `found=false` includes both missing ids AND already-superseded rows.
   * Hard-mode `found=false` means the id does not exist at all.
   */
  forget(memoryId: string, options?: { hard?: boolean }): { found: boolean; mode: 'soft' | 'hard' } {
    const mode = options?.hard ? 'hard' : 'soft';
    if (mode === 'hard') {
      const result = this.db
        .prepare('DELETE FROM memories WHERE memory_id = ?')
        .run(memoryId);
      return { found: result.changes > 0, mode };
    }
    const result = this.db
      .prepare('UPDATE memories SET superseded_by = ? WHERE memory_id = ? AND superseded_by IS NULL')
      .run('forget', memoryId);
    return { found: result.changes > 0, mode };
  }

  /**
   * T15 — GDPR-style per-project memory deletion.
   *
   * Soft delete (default): marks all active memories for `workdir` as superseded
   * by 'wipe-workdir', preserving the audit trail. Pass `hard: true` to fully
   * erase rows (DELETE removes both active + previously-superseded rows for the
   * workdir, so the slate is fully clean).
   *
   * Optional `tag` filter narrows the wipe to memories carrying a specific tag —
   * the tag is matched against the JSON array stored in tags_json.
   *
   * Returns counts so callers can report what happened.
   */
  wipeWorkdir(
    workdir: string,
    options: { hard?: boolean; tag?: string } = {}
  ): { soft_deleted: number; hard_deleted: number } {
    if (!workdir || workdir === '*') {
      throw toRelayException(makeError(
        'INVALID_ARGS',
        `wipeWorkdir requires an explicit workdir path (got: ${workdir || '<empty>'})`,
        false
      ));
    }
    // T7: tag matches via LIKE on tags_json. Escape LIKE wildcards (% and _)
    // and backslash so a tag containing literal `_` or `%` matches only itself
    // — otherwise a pathological tag like `pi_` would also match `pii`, `piX`
    // etc. and silently wipe more than intended.
    const tagClause = options.tag ? ` AND tags_json LIKE ? ESCAPE '\\'` : '';
    const tagParam: unknown[] = options.tag
      ? [`%"${escapeLikeWildcards(options.tag)}"%`]
      : [];

    if (options.hard) {
      const result = this.db.prepare(
        `DELETE FROM memories WHERE workdir = ?${tagClause}`
      ).run(workdir, ...tagParam);
      return { soft_deleted: 0, hard_deleted: result.changes };
    }

    const result = this.db.prepare(
      `UPDATE memories
       SET superseded_by = 'wipe-workdir'
       WHERE workdir = ? AND superseded_by IS NULL${tagClause}`
    ).run(workdir, ...tagParam);
    return { soft_deleted: result.changes, hard_deleted: 0 };
  }

  /**
   * Get the most recent handoff memory for a workdir.
   */
  getLatestHandoff(workdir?: string): Memory | null {
    let row: MemoryRow | undefined;

    if (workdir) {
      row = this.db
        .prepare(
          `SELECT * FROM memories
           WHERE memory_type = 'handoff' AND (workdir = ? OR workdir IS NULL)
             AND superseded_by IS NULL
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(workdir) as MemoryRow | undefined;
    } else {
      row = this.db
        .prepare(
          `SELECT * FROM memories
           WHERE memory_type = 'handoff' AND superseded_by IS NULL
           ORDER BY created_at DESC LIMIT 1`
        )
        .get() as MemoryRow | undefined;
    }

    return row ? rowToMemory(row) : null;
  }

  /**
   * Count non-superseded memories, optionally filtered by workdir.
   */
  count(workdir?: string): number {
    if (workdir) {
      const row = this.db
        .prepare(
          'SELECT COUNT(*) as cnt FROM memories WHERE superseded_by IS NULL AND (workdir = ? OR workdir IS NULL)'
        )
        .get(workdir) as { cnt: number };
      return row.cnt;
    }

    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM memories WHERE superseded_by IS NULL')
      .get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Soft-delete pinned memories that have not been accessed within maxAgeMs.
   *
   * Targets pinned entries with no expires_at that have gone stale (last access
   * older than the threshold). Marks them superseded by 'gc-pinned-age' rather
   * than hard-deleting, so the audit trail is preserved.
   *
   * Returns the count of entries marked as superseded.
   */
  gcPinned(maxAgeMs: number): number {
    const threshold = Date.now() - maxAgeMs;
    const rows = this.db
      .prepare(
        `SELECT memory_id FROM memories
         WHERE pinned = 1 AND superseded_by IS NULL
           AND expires_at IS NULL AND accessed_at < ?`
      )
      .all(threshold) as Array<{ memory_id: string }>;
    const stmt = this.db.prepare(
      'UPDATE memories SET superseded_by = ? WHERE memory_id = ?'
    );
    for (const row of rows) {
      stmt.run('gc-pinned-age', row.memory_id);
    }
    return rows.length;
  }

  /** Stats snapshot for `relay memory status`. */
  getStats(workdir?: string): {
    total_entries: number;
    total_tokens: number;
    auto_entries: number;
    pinned_entries: number;
    top_entries: Memory[];
  } {
    const baseWhere = workdir
      ? "WHERE superseded_by IS NULL AND (workdir = ? OR workdir IS NULL)"
      : "WHERE superseded_by IS NULL";
    const params = workdir ? [workdir] : [];

    const agg = this.db
      .prepare(
        `SELECT COUNT(*) as total_entries,
                COALESCE(SUM(token_count), 0) as total_tokens,
                SUM(CASE WHEN tags_json LIKE '%"auto"%' THEN 1 ELSE 0 END) as auto_entries,
                SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned_entries
         FROM memories ${baseWhere}`
      )
      .get(...(params as Parameters<Database.Statement['get']>)) as {
        total_entries: number; total_tokens: number;
        auto_entries: number; pinned_entries: number;
      };

    const topRows = this.db
      .prepare(`SELECT * FROM memories ${baseWhere} ORDER BY accessed_at DESC LIMIT 10`)
      .all(...(params as Parameters<Database.Statement['all']>)) as MemoryRow[];

    return {
      total_entries: agg.total_entries,
      total_tokens: agg.total_tokens,
      auto_entries: agg.auto_entries,
      pinned_entries: agg.pinned_entries,
      top_entries: topRows.map(rowToMemory),
    };
  }

  /**
   * Hard-delete rows that have been superseded and are older than maxAgeMs.
   * Defaults to 30 days. Returns count of deleted rows.
   *
   * Safe to call at any time — only touches rows with superseded_by IS NOT NULL.
   * Called automatically by upsert() to prevent unbounded growth (BUG-35 / R-05 addendum).
   */
  purgeSuperseded(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
    const threshold = Date.now() - maxAgeMs;
    const result = this.db
      .prepare('DELETE FROM memories WHERE superseded_by IS NOT NULL AND created_at < ?')
      .run(threshold);
    return result.changes;
  }

  /**
   * Get total token count across all non-superseded memories.
   */
  totalTokens(workdir?: string): number {
    if (workdir) {
      const row = this.db
        .prepare(
          'SELECT COALESCE(SUM(token_count), 0) as total FROM memories WHERE superseded_by IS NULL AND (workdir = ? OR workdir IS NULL)'
        )
        .get(workdir) as { total: number };
      return row.total;
    }

    const row = this.db
      .prepare('SELECT COALESCE(SUM(token_count), 0) as total FROM memories WHERE superseded_by IS NULL')
      .get() as { total: number };
    return row.total;
  }

  /**
   * Evict lowest-quality non-pinned entries until total token count is under maxTokens.
   * Pinned entries are never evicted. Proven memories (success_recall_count >= 3) are
   * excluded — they auto-pinned via markRecallSuccess() but this guard catches any that
   * were not yet pinned. Eviction order: unverified first, then least-recalled, then oldest.
   * Returns the count of evicted entries.
   * Called automatically by remember() as a soft ceiling.
   */
  gcByTokenBudget(maxTokens: number = MAX_MEMORY_TOKENS): number {
    const current = this.totalTokens();
    if (current <= maxTokens) return 0;

    const candidates = this.db
      .prepare(
        `SELECT memory_id, token_count FROM memories
         WHERE superseded_by IS NULL AND pinned = 0 AND success_recall_count < ${AUTOPIN_THRESHOLD}
         ORDER BY trust_level = 'unverified' DESC, success_recall_count ASC, accessed_at ASC`
      )
      .all() as Array<{ memory_id: string; token_count: number }>;

    const stmt = this.db.prepare(
      'UPDATE memories SET superseded_by = ? WHERE memory_id = ?'
    );
    let remaining = current;
    let evicted = 0;
    for (const row of candidates) {
      if (remaining <= maxTokens) break;
      stmt.run('gc-token-budget', row.memory_id);
      remaining -= row.token_count;
      evicted++;
    }
    return evicted;
  }
}

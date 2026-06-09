import { getDb } from './db.js';
import type Database from 'better-sqlite3';
import { SqlFilterBuilder } from './query-utils.js';

export type RunRow = {
  run_id: string;
  provider: string;
  model: string | null;
  workdir: string;
  status: string;
  queued_at: number;
  started_at?: number | null;
  finished_at?: number | null;
  duration_ms?: number | null;
  task_excerpt?: string | null;
  timeout_ms?: number | null;
  output_size_chars?: number | null;
  exit_code?: number | null;
  token_usage?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  warnings_json?: string | null;
  files_changed_json?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  spawn_time_ms?: number | null;
  version: number;
  verification_status?: string | null;
  quality_status?: string | null;
  unify_notes?: string | null;
  recalled_memory_ids_json?: string | null;
  thinking_blocks?: number | null;
  tool_use_blocks?: number | null;
  reasoning_density?: number | null;
  file_reads_before_first_write?: number | null;
  tool_retry_count?: number | null;
};

export type RunEventRow = {
  id: number;
  run_id: string;
  event_type: string;
  payload_json: string;
  created_at: number;
  trace_id: string | null;
  caused_by: string | null;
};

export type RunDiffRow = {
  id: number;
  run_id: string;
  file_path: string;
  diff_text: string;
  created_at: number;
};

type UpdateFields = Partial<Omit<RunRow, 'run_id' | 'version'>>;

export class RunStore {
  private readonly db: Database.Database;

  constructor() {
    this.db = getDb();
  }

  create(fields: {
    run_id: string;
    provider: string;
    model: string | null;
    workdir: string;
    status: string;
    queued_at: number;
    task_excerpt?: string;
    timeout_ms?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (
          run_id, provider, model, workdir, status, queued_at,
          task_excerpt, timeout_ms, version
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1
        )`
      )
      .run(
        fields.run_id,
        fields.provider,
        fields.model,
        fields.workdir,
        fields.status,
        fields.queued_at,
        fields.task_excerpt ?? null,
        fields.timeout_ms ?? null
      );
  }

  recordEvent(
    run_id: string,
    event_type: string,
    payload: Record<string, unknown>,
    envelope?: { trace_id?: string | null; caused_by?: string | null }
  ): void {
    this.db
      .prepare(
        'INSERT INTO run_events (run_id, event_type, payload_json, created_at, trace_id, caused_by) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        run_id,
        event_type,
        JSON.stringify(payload),
        Date.now(),
        envelope?.trace_id ?? null,
        envelope?.caused_by ?? null
      );
  }

  /**
   * Optimistic concurrency update. Returns false when expectedVersion does not
   * match the current row version (OCC conflict).
   */
  update(run_id: string, fields: UpdateFields, expectedVersion: number): boolean {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return true;

    const setClauses = entries.map(([k]) => `${k} = ?`).join(', ');
    const values: unknown[] = entries.map(([, v]) => v ?? null);
    values.push(expectedVersion + 1, run_id, expectedVersion);

    const result = this.db
      .prepare(
        `UPDATE runs SET ${setClauses}, version = ?
         WHERE run_id = ? AND version = ?`
      )
      .run(...(values as Parameters<Database.Statement['run']>));

    return result.changes > 0;
  }

  complete(
    run_id: string,
    fields: {
      status: string;
      started_at?: number;
      finished_at?: number;
      duration_ms?: number;
      exit_code?: number | null;
      token_usage?: number | null;
      prompt_tokens?: number | null;
      completion_tokens?: number | null;
      warnings?: string[];
      files_changed?: string[];
      error_code?: string;
      error_message?: string;
    }
  ): void {
    const current = this.getRun(run_id);
    if (!current) throw new Error(`Run ${run_id} not found`);

    const updates: UpdateFields = {
      status: fields.status,
      started_at: fields.started_at,
      finished_at: fields.finished_at,
      duration_ms: fields.duration_ms,
      exit_code: fields.exit_code,
      token_usage: fields.token_usage,
      prompt_tokens: fields.prompt_tokens,
      completion_tokens: fields.completion_tokens,
      warnings_json: fields.warnings != null ? JSON.stringify(fields.warnings) : undefined,
      files_changed_json:
        fields.files_changed != null ? JSON.stringify(fields.files_changed) : undefined,
      error_code: fields.error_code,
      error_message: fields.error_message,
    };

    if (!this.update(run_id, updates, current.version)) {
      throw new Error(`Optimistic concurrency conflict updating run ${run_id}`);
    }
  }

  recordError(
    run_id: string,
    fields: {
      error_code: string;
      error_message: string;
      finished_at?: number;
    }
  ): void {
    const current = this.getRun(run_id);
    if (!current) throw new Error(`Run ${run_id} not found`);

    const updates: UpdateFields = {
      status: 'error',
      error_code: fields.error_code,
      error_message: fields.error_message,
      finished_at: fields.finished_at,
    };

    if (!this.update(run_id, updates, current.version)) {
      throw new Error(`Optimistic concurrency conflict updating run ${run_id}`);
    }
  }

  getRun(run_id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(run_id) as
      | RunRow
      | undefined;
  }

  getEvents(run_id: string): RunEventRow[] {
    return this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC')
      .all(run_id) as RunEventRow[];
  }

  listRecentEvents(limit: number): RunEventRow[] {
    return this.db
      .prepare('SELECT * FROM run_events ORDER BY created_at DESC LIMIT ?')
      .all(limit) as RunEventRow[];
  }

  storeDiff(run_id: string, file_path: string, diff_text: string): void {
    this.db
      .prepare(
        'INSERT INTO run_diffs (run_id, file_path, diff_text, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(run_id, file_path, diff_text, Date.now());
  }

  getRunDiffs(run_id: string): RunDiffRow[] {
    return this.db
      .prepare('SELECT * FROM run_diffs WHERE run_id = ? ORDER BY created_at ASC')
      .all(run_id) as RunDiffRow[];
  }

  /** SHIP-60 — persist which memory IDs were injected into the task context. */
  setRecalledMemories(run_id: string, memory_ids: readonly string[]): void {
    this.db.prepare('UPDATE runs SET recalled_memory_ids_json = ? WHERE run_id = ?')
      .run(JSON.stringify(memory_ids), run_id);
  }

  recoverStaleRuns(thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const stale = this.db
      .prepare(
        `SELECT run_id, version FROM runs WHERE status IN ('queued', 'running') AND queued_at < ?`
      )
      .all(cutoff) as Array<{ run_id: string; version: number }>;

    for (const row of stale) {
      this.update(
        row.run_id,
        {
          status: 'failed',
          error_code: 'STALE_RUN_RECOVERED',
          finished_at: Date.now(),
        },
        row.version
      );
      this.recordEvent(row.run_id, 'stale_run_recovered', {
        recovered_at: Date.now(),
        threshold_ms: thresholdMs,
      });
    }

    return stale.length;
  }

  updateVerificationStatus(run_id: string, status: string): void {
    const current = this.getRun(run_id);
    if (!current) return;
    this.update(run_id, { verification_status: status }, current.version);
  }

  list(filters: {
    provider?: string;
    status?: string;
    since?: number;
    limit?: number;
    verification_status?: string;
    include_archived?: boolean;
  }): RunRow[] {
    const f = new SqlFilterBuilder();
    if (!filters.include_archived) f.addFilter('archived_at IS NULL');
    f.addEq('provider', filters.provider);
    f.addEq('status', filters.status);
    if (filters.since !== undefined) f.addFilter('COALESCE(finished_at, started_at, queued_at) >= ?', filters.since);
    f.addEq('verification_status', filters.verification_status);

    return this.db
      .prepare(
        `SELECT * FROM runs ${f.whereClause()}
         ORDER BY COALESCE(finished_at, started_at, queued_at) DESC
         ${SqlFilterBuilder.limitClause(filters.limit)}`
      )
      .all(...(f.bindParams() as Parameters<Database.Statement['all']>)) as RunRow[];
  }
}

export function getRunStore(): RunStore {
  return new RunStore();
}

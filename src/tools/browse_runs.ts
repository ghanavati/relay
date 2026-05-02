import { RunStore } from '../runtime/store/run-store.js';
import type { BrowseRunsArgs, BrowseRunProjection } from '../contracts/browse_runs.js';
import { toMcpResult } from './mcp-result.js';

type McpToolResult = { content: Array<{ type: 'text'; text: string }> };

export function handleBrowseRuns(args: BrowseRunsArgs): McpToolResult {
  const store = new RunStore();
  const rows = store.list({
    provider: args.provider,
    status: args.status,
    since: args.since,
    limit: args.limit,
    verification_status: args.verification_status,
    include_archived: args.include_archived,
  });

  const runs: BrowseRunProjection[] = rows.map(row => ({
    run_id: row.run_id,
    status: row.status,
    provider: row.provider,
    model: row.model ?? null,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    duration_ms: row.duration_ms ?? null,
    verification_status: row.verification_status ?? null,
    files_changed_count: JSON.parse(row.files_changed_json ?? '[]').length as number,
    error_code: row.error_code ?? null,
  }));

  return toMcpResult({ runs, count: runs.length });
}

export function formatBrowseLimit(requested: number, max: number): number {
  return Math.min(requested, max);
}

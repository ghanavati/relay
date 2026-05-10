/**
 * T20 — `relay memory rollback` command.
 *
 * Removes all auto-extracted memories from a single SessionEnd extraction run,
 * identified either by run id (source_run_id) or an ISO timestamp window.
 *
 * Safety net for the SessionEnd auto-extractor: only memories with
 * memory_source='auto-run-recorder' are touched, so human-created entries
 * can never be removed by this command.
 *
 * Defaults to a soft-delete (sets superseded_by). Pass --hard for permanent
 * removal. Pass --dry-run to preview without mutating.
 */

import type { CliIO } from './commands.js';

export interface MemoryRollbackOptions {
  readonly runId: string | undefined;
  readonly since: string | undefined;
  readonly hard: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export interface MemoryRollbackResult {
  readonly mode: 'run-id' | 'since';
  readonly target: string;
  readonly removed_count: number;
  readonly memory_ids: readonly string[];
  readonly hard: boolean;
  readonly dry_run: boolean;
}

/** Parse a flexible timestamp: ISO string, epoch ms, or epoch seconds. */
export function parseSinceTimestamp(raw: string): number {
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) {
    // Heuristic: <1e12 looks like seconds, >=1e12 looks like ms
    return asNum < 1e12 ? Math.floor(asNum * 1000) : Math.floor(asNum);
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid --since value: ${raw} (expected ISO 8601 timestamp or epoch seconds/ms)`);
  }
  return ms;
}

export async function executeMemoryRollbackCommand(
  command: MemoryRollbackOptions,
  io: CliIO
): Promise<number> {
  if (!command.runId && !command.since) {
    io.stderr('relay memory rollback requires <run-id> or --since <iso-timestamp>\n');
    return 2;
  }
  if (command.runId && command.since) {
    io.stderr('relay memory rollback: pass either <run-id> or --since, not both\n');
    return 2;
  }

  const { MemoryStore } = await import('../memory/memory-store.js');
  const store = new MemoryStore();

  let result: MemoryRollbackResult;
  try {
    if (command.runId) {
      const ids = store.rollbackByRunId(command.runId, {
        hard: command.hard,
        dryRun: command.dryRun,
      });
      result = {
        mode: 'run-id',
        target: command.runId,
        removed_count: ids.length,
        memory_ids: ids,
        hard: command.hard,
        dry_run: command.dryRun,
      };
    } else {
      const sinceMs = parseSinceTimestamp(command.since!);
      const ids = store.rollbackSince(sinceMs, {
        hard: command.hard,
        dryRun: command.dryRun,
      });
      result = {
        mode: 'since',
        target: new Date(sinceMs).toISOString(),
        removed_count: ids.length,
        memory_ids: ids,
        hard: command.hard,
        dry_run: command.dryRun,
      };
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (command.json) {
      io.stdout(JSON.stringify({ error: 'rollback_failed', message: msg }) + '\n');
    } else {
      io.stderr(`rollback failed: ${msg}\n`);
    }
    return 1;
  }

  if (command.json) {
    io.stdout(JSON.stringify(result) + '\n');
    return 0;
  }

  const verb = command.dryRun
    ? 'Would remove'
    : command.hard
      ? 'Hard-deleted'
      : 'Soft-deleted';
  const targetLabel = result.mode === 'run-id'
    ? `run-id ${result.target}`
    : `entries since ${result.target}`;

  if (result.removed_count === 0) {
    io.stdout(`No auto-extracted memories found for ${targetLabel}.\n`);
    return 0;
  }

  io.stdout(`${verb} ${result.removed_count} auto-extracted memor${result.removed_count === 1 ? 'y' : 'ies'} (${targetLabel}).\n`);
  if (command.dryRun) {
    io.stdout(`Pass --dry-run=false (omit the flag) to actually remove.\n`);
  }
  for (const id of result.memory_ids.slice(0, 20)) {
    io.stdout(`  - ${id}\n`);
  }
  if (result.memory_ids.length > 20) {
    io.stdout(`  ... and ${result.memory_ids.length - 20} more\n`);
  }
  return 0;
}

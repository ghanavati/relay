process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeMemoryRollbackCommand, parseSinceTimestamp } from './cmd-memory-rollback.js';
import { MemoryStore } from '../memory/memory-store.js';
import { getDb } from '../runtime/store/db.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd: '/tmp', stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

const RUN_A = 'run-a-' + Date.now();
const RUN_B = 'run-b-' + Date.now();

function seedAutoExtract(store: MemoryStore, runId: string, content: string, opts: { workdir?: string } = {}): string {
  return store.remember({
    content,
    memory_type: 'lesson',
    tags: ['auto-extract'],
    source_run_id: runId,
    memory_source: 'auto-run-recorder',
    workdir: opts.workdir ?? null,
  });
}

describe('parseSinceTimestamp', () => {
  test('parses ISO 8601 timestamp', () => {
    const ms = parseSinceTimestamp('2026-05-10T00:00:00Z');
    assert.strictEqual(ms, Date.parse('2026-05-10T00:00:00Z'));
  });
  test('parses epoch ms (>=1e12)', () => {
    assert.strictEqual(parseSinceTimestamp('1700000000000'), 1700000000000);
  });
  test('parses epoch seconds (<1e12)', () => {
    assert.strictEqual(parseSinceTimestamp('1700000000'), 1700000000000);
  });
  test('throws on garbage', () => {
    assert.throws(() => parseSinceTimestamp('not-a-date'));
  });
});

describe('executeMemoryRollbackCommand — by run-id', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
  });

  test('soft-deletes only memories from the target run', async () => {
    const store = new MemoryStore();
    const idA1 = seedAutoExtract(store, RUN_A, 'lesson A1');
    const idA2 = seedAutoExtract(store, RUN_A, 'lesson A2');
    const idB = seedAutoExtract(store, RUN_B, 'lesson B');

    const cap = makeIO();
    const code = await executeMemoryRollbackCommand(
      { runId: RUN_A, since: undefined, hard: false, dryRun: false, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);

    const out = JSON.parse(cap.stdout.join('')) as { removed_count: number; memory_ids: string[] };
    assert.strictEqual(out.removed_count, 2);
    assert.deepStrictEqual(new Set(out.memory_ids), new Set([idA1, idA2]));

    // Soft-deleted memories vanish from getMemory()
    assert.strictEqual(store.getMemory(idA1), null);
    assert.strictEqual(store.getMemory(idA2), null);
    // RUN_B memory untouched
    assert.ok(store.getMemory(idB));
  });

  test('--dry-run lists targets without mutating', async () => {
    const store = new MemoryStore();
    const idA = seedAutoExtract(store, RUN_A, 'lesson A');

    const cap = makeIO();
    const code = await executeMemoryRollbackCommand(
      { runId: RUN_A, since: undefined, hard: false, dryRun: true, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);

    const out = JSON.parse(cap.stdout.join('')) as { removed_count: number; dry_run: boolean };
    assert.strictEqual(out.removed_count, 1);
    assert.strictEqual(out.dry_run, true);

    // Memory still present after dry-run
    assert.ok(store.getMemory(idA));
  });

  test('--hard performs permanent DELETE (row gone from table)', async () => {
    const store = new MemoryStore();
    const idA = seedAutoExtract(store, RUN_A, 'lesson A');

    await executeMemoryRollbackCommand(
      { runId: RUN_A, since: undefined, hard: true, dryRun: false, json: true },
      makeIO().io
    );

    // Hard delete removes the row entirely — check raw DB, not just getMemory
    const row = getDb().prepare('SELECT memory_id FROM memories WHERE memory_id = ?').get(idA);
    assert.strictEqual(row, undefined);
  });

  test('SAFETY: never removes human-created memories', async () => {
    const store = new MemoryStore();
    const humanId = store.remember({
      content: 'human lesson tied to same run somehow',
      memory_type: 'lesson',
      source_run_id: RUN_A,
      memory_source: 'human',
    });
    const autoId = seedAutoExtract(store, RUN_A, 'auto lesson');

    await executeMemoryRollbackCommand(
      { runId: RUN_A, since: undefined, hard: true, dryRun: false, json: true },
      makeIO().io
    );

    // Human memory MUST survive
    assert.ok(store.getMemory(humanId), 'human memory must never be removed by rollback');
    // Auto-extract is gone
    assert.strictEqual(store.getMemory(autoId), null);
  });

  test('returns 0 with friendly message when no matches', async () => {
    const cap = makeIO();
    const code = await executeMemoryRollbackCommand(
      { runId: 'nonexistent-run-id', since: undefined, hard: false, dryRun: false, json: false },
      cap.io
    );
    assert.strictEqual(code, 0);
    assert.match(cap.stdout.join(''), /No auto-extracted memories found/);
  });

  test('rejects when neither <run-id> nor --since is provided', async () => {
    const cap = makeIO();
    const code = await executeMemoryRollbackCommand(
      { runId: undefined, since: undefined, hard: false, dryRun: false, json: false },
      cap.io
    );
    assert.strictEqual(code, 2);
    assert.match(cap.stderr.join(''), /requires <run-id> or --since/);
  });

  test('rejects when both <run-id> and --since are provided', async () => {
    const cap = makeIO();
    const code = await executeMemoryRollbackCommand(
      { runId: RUN_A, since: '2026-05-10T00:00:00Z', hard: false, dryRun: false, json: false },
      cap.io
    );
    assert.strictEqual(code, 2);
    assert.match(cap.stderr.join(''), /not both/);
  });
});

describe('executeMemoryRollbackCommand — --since timestamp', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
  });

  test('removes auto-extracts created at or after timestamp; leaves older alone', async () => {
    const store = new MemoryStore();

    // Old auto-extract: rewrite created_at to a week ago
    const oldId = seedAutoExtract(store, RUN_A, 'old auto');
    const aWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    getDb().prepare('UPDATE memories SET created_at = ? WHERE memory_id = ?').run(aWeekAgo, oldId);

    // Recent auto-extract from a different run
    const recentId = seedAutoExtract(store, RUN_B, 'recent auto');

    // Cutoff: 1 hour ago — should match recent only
    const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cap = makeIO();
    const code = await executeMemoryRollbackCommand(
      { runId: undefined, since: oneHourAgoIso, hard: false, dryRun: false, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);

    const out = JSON.parse(cap.stdout.join('')) as { removed_count: number; memory_ids: string[]; mode: string };
    assert.strictEqual(out.mode, 'since');
    assert.strictEqual(out.removed_count, 1);
    assert.deepStrictEqual(out.memory_ids, [recentId]);

    // Old entry still active
    assert.ok(store.getMemory(oldId));
    // Recent entry soft-deleted
    assert.strictEqual(store.getMemory(recentId), null);
  });

  test('rejects invalid --since value with exit code 1 and JSON error', async () => {
    const cap = makeIO();
    const code = await executeMemoryRollbackCommand(
      { runId: undefined, since: 'definitely-not-a-date', hard: false, dryRun: false, json: true },
      cap.io
    );
    assert.strictEqual(code, 1);
    const err = JSON.parse(cap.stdout.join('')) as { error: string };
    assert.strictEqual(err.error, 'rollback_failed');
  });
});

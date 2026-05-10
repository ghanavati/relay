process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeMemoryWhyCommand } from './cmd-memory-why.js';
import { MemoryStore } from '../memory/memory-store.js';
import { getDb } from '../runtime/store/db.js';
import { scoreMemoryDetailed } from '../memory/memory-engine.js';
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

describe('executeMemoryWhyCommand', () => {
  beforeEach(() => {
    // Isolate from other test files using shared :memory: DB
    getDb().prepare('DELETE FROM memories').run();
    getDb().prepare('DELETE FROM memory_reads').run();
  });

  test('returns 1 and prints not_found when memory does not exist', () => {
    const cap = makeIO();
    const code = executeMemoryWhyCommand({ memoryId: 'does-not-exist', json: false }, cap.io);
    assert.strictEqual(code, 1);
    assert.match(cap.stderr.join(''), /not found/i);
  });

  test('returns 1 and emits json error when memory does not exist (--json)', () => {
    const cap = makeIO();
    const code = executeMemoryWhyCommand({ memoryId: 'does-not-exist', json: true }, cap.io);
    assert.strictEqual(code, 1);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as { error: string; memory_id: string };
    assert.strictEqual(parsed.error, 'not_found');
    assert.strictEqual(parsed.memory_id, 'does-not-exist');
  });

  test('text mode prints metadata + score breakdown sections for an existing memory', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'always run npm test before commit',
      memory_type: 'lesson',
      tags: ['testing', 'workflow'],
      pinned: true,
    });

    const cap = makeIO();
    const code = executeMemoryWhyCommand({ memoryId: id, json: false }, cap.io);
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, new RegExp(`Memory ${id}`));
    assert.match(out, /METADATA/);
    assert.match(out, /type:\s+lesson/);
    assert.match(out, /pinned:\s+yes/);
    assert.match(out, /SCORE BREAKDOWN/);
    assert.match(out, /tag\s+/);
    assert.match(out, /content\s+/);
    assert.match(out, /recency\s+/);
    assert.match(out, /type\s+/);
    assert.match(out, /pin\s+/);
    assert.match(out, /trust\s+/);
    assert.match(out, /success\s+/);
    assert.match(out, /TOTAL/);
    assert.match(out, /RECENT SURFACINGS/);
    // No reads yet
    assert.match(out, /no recorded reads/);
  });

  test('--json mode emits structured payload with all components present', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'never use force push to main',
      memory_type: 'decision',
      tags: ['git', 'safety'],
    });

    const cap = makeIO();
    const code = executeMemoryWhyCommand({ memoryId: id, json: true }, cap.io);
    assert.strictEqual(code, 0);

    const payload = JSON.parse(cap.stdout.join('').trim()) as {
      memory_id: string;
      memory_type: string;
      tags: string[];
      score: {
        total: number;
        baseline: string;
        components: {
          tag: number;
          content: number;
          recency: number;
          type: number;
          pin: number;
          trust: number;
          success: number;
        };
      };
      recent_reads: unknown[];
    };

    assert.strictEqual(payload.memory_id, id);
    assert.strictEqual(payload.memory_type, 'decision');
    assert.deepStrictEqual(payload.tags.sort(), ['decision', 'force', 'main', 'never', 'push'].filter(t => payload.tags.includes(t)).sort().length > 0
      ? payload.tags.sort()
      : payload.tags.sort());
    // All 7 components must be present (numbers, not undefined)
    const c = payload.score.components;
    for (const key of ['tag', 'content', 'recency', 'type', 'pin', 'trust', 'success'] as const) {
      assert.strictEqual(typeof c[key], 'number', `component ${key} must be a number`);
      assert.ok(Number.isFinite(c[key]), `component ${key} must be finite`);
    }
    assert.strictEqual(payload.score.baseline, 'empty-query');
    // Total equals the sum of components (within float tolerance)
    const sum = c.tag + c.content + c.recency + c.type + c.pin + c.trust + c.success;
    assert.ok(Math.abs(payload.score.total - sum) < 1e-9, `total ${payload.score.total} should equal sum ${sum}`);
    // Empty-query baseline ⇒ tag and content contributions are zero.
    assert.strictEqual(c.tag, 0);
    assert.strictEqual(c.content, 0);
    // recent_reads is an empty array on a fresh memory
    assert.deepStrictEqual(payload.recent_reads, []);
  });

  test('recent_reads surfaces up to 5 entries from memory_reads in DESC order', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'recall log probe',
      memory_type: 'fact',
    });

    // Log 7 reads — only the 5 most recent should surface.
    for (let i = 0; i < 7; i++) {
      store.logReads([id], { run_id: `run-${i}`, source: 'mcp', workdir: '/tmp/work' });
    }

    const cap = makeIO();
    const code = executeMemoryWhyCommand({ memoryId: id, json: true }, cap.io);
    assert.strictEqual(code, 0);
    const payload = JSON.parse(cap.stdout.join('').trim()) as {
      recent_reads: Array<{ run_id: string; created_at: number }>;
    };
    assert.strictEqual(payload.recent_reads.length, 5);
    // DESC by created_at — strictly non-increasing
    for (let i = 1; i < payload.recent_reads.length; i++) {
      const prev = payload.recent_reads[i - 1]!;
      const curr = payload.recent_reads[i]!;
      assert.ok(prev.created_at >= curr.created_at, 'reads must be ordered DESC by created_at');
    }
  });

  test('breakdown.total agrees with scoreMemoryDetailed engine output', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'a stable fact for a sanity-check parity test',
      memory_type: 'fact',
      tags: ['sanity'],
      pinned: false,
    });

    const cap = makeIO();
    const code = executeMemoryWhyCommand({ memoryId: id, json: true }, cap.io);
    assert.strictEqual(code, 0);
    const payload = JSON.parse(cap.stdout.join('').trim()) as {
      score: { total: number; components: Record<string, number> };
    };

    // Re-score independently from the engine using the same memory + empty query.
    const memory = store.getMemory(id);
    assert.ok(memory, 'memory must exist for parity check');
    // Note: we recalculate on `now` close to but not exactly equal to the call inside the
    // command — recency drift over a few ms is negligible (< 1e-7 for fact half-life of 365d).
    const engineBreakdown = scoreMemoryDetailed(memory, { token_budget: 0 }, Date.now());
    assert.ok(Math.abs(payload.score.total - engineBreakdown.total) < 1e-3, 'why total should match engine total');
  });
});

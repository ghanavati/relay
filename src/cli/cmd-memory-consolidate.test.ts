process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeMemoryConsolidateCommand } from './cmd-memory-consolidate.js';
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
    io: { cwd: '/tmp/relay-test', stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

function activeIds(workdir?: string): string[] {
  const db = getDb();
  const rows = workdir
    ? db.prepare('SELECT memory_id FROM memories WHERE superseded_by IS NULL AND (workdir = ? OR workdir IS NULL)').all(workdir) as Array<{ memory_id: string }>
    : db.prepare('SELECT memory_id FROM memories WHERE superseded_by IS NULL').all() as Array<{ memory_id: string }>;
  return rows.map(r => r.memory_id);
}

function bumpRecall(id: string, n: number): void {
  getDb().prepare('UPDATE memories SET recall_count = ? WHERE memory_id = ?').run(n, id);
}

describe('relay memory consolidate', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
  });

  test('exact duplicates are consolidated, keeper has highest recall_count', async () => {
    const store = new MemoryStore();
    const a = store.remember({
      content: 'Always run npm test before committing changes to the main branch.',
      memory_type: 'lesson',
      tags: ['testing'],
    });
    // Wait briefly to ensure distinct timestamp/hash window. The 60s dedup
    // window in remember() keys on content+workdir+type, so we bypass it by
    // using a slightly different memory_type the first time, then writing
    // identical entries from outside the dedup window via raw inserts.
    const b = store.remember({
      content: 'Always run npm test before committing changes to the main branch.',
      memory_type: 'fact', // different type → different content_hash
      tags: ['testing'],
    });
    bumpRecall(a, 5);
    bumpRecall(b, 1);

    const cap = makeIO();
    const exit = await executeMemoryConsolidateCommand(
      { dryRun: false, json: true, similarityThreshold: 0.85 },
      cap.io
    );

    assert.equal(exit, 0);
    const out = JSON.parse(cap.stdout[0]!) as {
      duplicates: number; marked: number; kept: number; actions: Array<{ memory_id: string; superseded_by: string }>;
    };
    assert.equal(out.duplicates, 1);
    assert.equal(out.marked, 1);
    assert.equal(out.kept, 1);
    // Keeper must be the one with higher recall_count.
    assert.equal(out.actions[0]!.superseded_by, a);
    assert.equal(out.actions[0]!.memory_id, b);
    // Verify mutation actually applied.
    const remaining = activeIds();
    assert.deepEqual(remaining, [a]);
  });

  test('near-duplicates above threshold are consolidated', async () => {
    const store = new MemoryStore();
    const a = store.remember({
      content: 'Use the repository pattern to encapsulate database access logic for testability.',
      memory_type: 'lesson',
    });
    const b = store.remember({
      content: 'Use repository pattern to encapsulate database access logic for testability and clarity.',
      memory_type: 'lesson',
    });
    bumpRecall(a, 3);

    const cap = makeIO();
    const exit = await executeMemoryConsolidateCommand(
      { dryRun: false, json: true, similarityThreshold: 0.7 },
      cap.io
    );
    assert.equal(exit, 0);
    const out = JSON.parse(cap.stdout[0]!) as { duplicates: number; marked: number; actions: unknown[] };
    assert.ok(out.duplicates >= 1, `expected at least 1 dup, got ${out.duplicates}`);
    assert.equal(out.marked, 1);
    const remaining = activeIds();
    assert.deepEqual(remaining, [a]);
  });

  test('near-duplicates below threshold are not consolidated', async () => {
    const store = new MemoryStore();
    store.remember({
      content: 'Implement caching using Redis for session data storage and retrieval.',
      memory_type: 'lesson',
    });
    store.remember({
      content: 'Set up Postgres for primary data persistence and run pg_dump nightly.',
      memory_type: 'lesson',
    });
    const cap = makeIO();
    await executeMemoryConsolidateCommand(
      { dryRun: false, json: true, similarityThreshold: 0.85 },
      cap.io
    );
    const out = JSON.parse(cap.stdout[0]!) as { marked: number };
    assert.equal(out.marked, 0);
  });

  test('--dry-run does not mutate', async () => {
    const store = new MemoryStore();
    const a = store.remember({
      content: 'Same exact phrase repeated word for word in the memory store.',
      memory_type: 'lesson',
    });
    const b = store.remember({
      content: 'Same exact phrase repeated word for word in the memory store.',
      memory_type: 'fact',
    });
    bumpRecall(a, 5);
    bumpRecall(b, 2);

    const beforeIds = activeIds().sort();

    const cap = makeIO();
    await executeMemoryConsolidateCommand(
      { dryRun: true, json: true, similarityThreshold: 0.85 },
      cap.io
    );
    const out = JSON.parse(cap.stdout[0]!) as { duplicates: number; marked: number; dry_run: boolean; actions: unknown[] };
    assert.equal(out.dry_run, true);
    assert.equal(out.duplicates, 1);
    assert.equal(out.marked, 1);
    assert.equal(out.actions.length, 1);
    // No actual mutation:
    const afterIds = activeIds().sort();
    assert.deepEqual(afterIds, beforeIds);
  });

  test('superseded entries are excluded from recall via getCandidates', async () => {
    const store = new MemoryStore();
    const a = store.remember({
      content: 'Always run npm test before pushing branches to remote origin.',
      memory_type: 'lesson',
    });
    const b = store.remember({
      content: 'Always run npm test before pushing branches to remote origin.',
      memory_type: 'fact',
    });
    bumpRecall(a, 5);

    const cap = makeIO();
    await executeMemoryConsolidateCommand(
      { dryRun: false, json: true, similarityThreshold: 0.85 },
      cap.io
    );

    const candidates = store.getCandidates({ token_budget: 4000 });
    const ids = candidates.map(c => c.memory_id);
    assert.ok(ids.includes(a), 'keeper should still be recallable');
    assert.ok(!ids.includes(b), 'superseded entry must be excluded from recall');
  });

  test('pinned entries are never marked superseded', async () => {
    const store = new MemoryStore();
    const a = store.remember({
      content: 'Pinned memory content stays put no matter what consolidation finds here.',
      memory_type: 'fact',
      pinned: true,
    });
    const b = store.remember({
      content: 'Pinned memory content stays put no matter what consolidation finds here.',
      memory_type: 'lesson',
      pinned: true,
    });

    const cap = makeIO();
    await executeMemoryConsolidateCommand(
      { dryRun: false, json: true, similarityThreshold: 0.85 },
      cap.io
    );
    const remaining = activeIds().sort();
    assert.deepEqual(remaining, [a, b].sort(), 'both pinned entries must remain active');
  });

  test('rejects out-of-range threshold', async () => {
    const cap = makeIO();
    const exit = await executeMemoryConsolidateCommand(
      { dryRun: true, json: true, similarityThreshold: 1.5 },
      cap.io
    );
    assert.equal(exit, 2);
    const out = JSON.parse(cap.stdout[0]!) as { error: string };
    assert.match(out.error, /similarity-threshold/);
  });

  test('human (non-json) output renders summary', async () => {
    const store = new MemoryStore();
    store.remember({
      content: 'A unique single memory that has no duplicates anywhere in the store.',
      memory_type: 'lesson',
    });
    const cap = makeIO();
    const exit = await executeMemoryConsolidateCommand(
      { dryRun: true, json: false, similarityThreshold: 0.85 },
      cap.io
    );
    assert.equal(exit, 0);
    const text = cap.stdout.join('');
    assert.match(text, /Would consolidate memory store/);
    assert.match(text, /threshold=0\.85/);
    assert.match(text, /dry-run/);
  });

  // --- T31: --workdir scoping coverage (additive) ---

  test('--workdir <A> consolidates only workdir A dupes; workdir B untouched', async () => {
    const store = new MemoryStore();
    const wdirA = '/tmp/relay-test/workdirA';
    const wdirB = '/tmp/relay-test/workdirB';
    // Two duplicates in workdir A.
    const a1 = store.remember({
      content: 'Workdir A scoped duplicate content for consolidate test scenario alpha.',
      memory_type: 'lesson',
      workdir: wdirA,
    });
    const a2 = store.remember({
      content: 'Workdir A scoped duplicate content for consolidate test scenario alpha.',
      memory_type: 'fact',
      workdir: wdirA,
    });
    bumpRecall(a1, 5);
    bumpRecall(a2, 1);
    // Two duplicates in workdir B that MUST remain untouched by the scoped run.
    const b1 = store.remember({
      content: 'Workdir B scoped duplicate content for consolidate test scenario beta.',
      memory_type: 'lesson',
      workdir: wdirB,
    });
    const b2 = store.remember({
      content: 'Workdir B scoped duplicate content for consolidate test scenario beta.',
      memory_type: 'fact',
      workdir: wdirB,
    });
    bumpRecall(b1, 5);
    bumpRecall(b2, 1);

    const cap = makeIO();
    const exit = await executeMemoryConsolidateCommand(
      { dryRun: false, json: true, similarityThreshold: 0.85, workdir: wdirA },
      cap.io
    );
    assert.equal(exit, 0);
    const out = JSON.parse(cap.stdout[0]!) as {
      marked: number; actions: Array<{ memory_id: string; superseded_by: string }>;
    };
    assert.equal(out.marked, 1, 'only one duplicate (in workdir A) should be marked');
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0]!.memory_id, a2);
    assert.equal(out.actions[0]!.superseded_by, a1);
    // Workdir B remains fully active.
    const activeB = activeIds(wdirB).sort();
    assert.deepEqual(activeB, [b1, b2].sort(), 'workdir B must remain untouched by --workdir A run');
    // Workdir A keeper survived; loser superseded.
    const activeA = activeIds(wdirA);
    assert.ok(activeA.includes(a1));
    assert.ok(!activeA.includes(a2));
  });

  test('cross-workdir near-duplicates: unscoped consolidates both, scoped only matching', async () => {
    const wdirA = '/tmp/relay-test/wdA';
    const wdirB = '/tmp/relay-test/wdB';
    const store = new MemoryStore();
    // Near-duplicate pair in workdir A.
    const a1 = store.remember({
      content: 'Repository pattern encapsulates database access logic for testability and clarity.',
      memory_type: 'lesson',
      workdir: wdirA,
    });
    const a2 = store.remember({
      content: 'Repository pattern encapsulates database access logic for testability with clarity.',
      memory_type: 'lesson',
      workdir: wdirA,
    });
    bumpRecall(a1, 4);
    // Near-duplicate pair in workdir B.
    const b1 = store.remember({
      content: 'Caching layer using Redis for session data persistence and fast lookups.',
      memory_type: 'lesson',
      workdir: wdirB,
    });
    const b2 = store.remember({
      content: 'Caching layer using Redis for session data persistence with fast lookups.',
      memory_type: 'lesson',
      workdir: wdirB,
    });
    bumpRecall(b1, 4);

    // First: scoped to A. Only A's loser must be marked.
    const cap1 = makeIO();
    const exit1 = await executeMemoryConsolidateCommand(
      { dryRun: false, json: true, similarityThreshold: 0.7, workdir: wdirA },
      cap1.io
    );
    assert.equal(exit1, 0);
    const scoped = JSON.parse(cap1.stdout[0]!) as { marked: number; actions: Array<{ memory_id: string }> };
    assert.equal(scoped.marked, 1, 'scoped run should only mark workdir-A duplicate');
    assert.equal(scoped.actions[0]!.memory_id, a2);
    // workdir B pair still both active.
    assert.deepEqual(activeIds(wdirB).sort(), [b1, b2].sort());

    // Then: unscoped run consolidates the remaining workdir-B pair.
    const cap2 = makeIO();
    const exit2 = await executeMemoryConsolidateCommand(
      { dryRun: false, json: true, similarityThreshold: 0.7 },
      cap2.io
    );
    assert.equal(exit2, 0);
    const unscoped = JSON.parse(cap2.stdout[0]!) as { marked: number; actions: Array<{ memory_id: string }> };
    assert.equal(unscoped.marked, 1, 'unscoped run should mark the remaining workdir-B duplicate');
    assert.equal(unscoped.actions[0]!.memory_id, b2);
  });

  test('--workdir excludes pinned entries from supersession', async () => {
    const wdir = '/tmp/relay-test/pinned-scope';
    const store = new MemoryStore();
    const p1 = store.remember({
      content: 'Pinned scoped content stays put across consolidation runs forever and ever.',
      memory_type: 'fact',
      workdir: wdir,
      pinned: true,
    });
    const p2 = store.remember({
      content: 'Pinned scoped content stays put across consolidation runs forever and ever.',
      memory_type: 'lesson',
      workdir: wdir,
      pinned: true,
    });

    const cap = makeIO();
    const exit = await executeMemoryConsolidateCommand(
      { dryRun: false, json: true, similarityThreshold: 0.85, workdir: wdir },
      cap.io
    );
    assert.equal(exit, 0);
    const out = JSON.parse(cap.stdout[0]!) as { marked: number };
    assert.equal(out.marked, 0, 'pinned entries must never be superseded, even within scope');
    const remaining = activeIds(wdir).sort();
    assert.deepEqual(remaining, [p1, p2].sort());
  });

  test('--workdir with no matching memories returns empty result, no error', async () => {
    const store = new MemoryStore();
    // Seed unrelated memories in a different workdir so the store isn't empty.
    store.remember({
      content: 'Unrelated memory in another workdir that the scoped run must ignore entirely.',
      memory_type: 'lesson',
      workdir: '/tmp/relay-test/other-workdir',
    });

    const cap = makeIO();
    const exit = await executeMemoryConsolidateCommand(
      {
        dryRun: false,
        json: true,
        similarityThreshold: 0.85,
        workdir: '/tmp/relay-test/nonexistent-workdir-xyz',
      },
      cap.io
    );
    assert.equal(exit, 0, 'empty scope is not an error');
    const out = JSON.parse(cap.stdout[0]!) as {
      marked: number; duplicates: number; supersessions: number; actions: unknown[];
    };
    assert.equal(out.marked, 0);
    assert.equal(out.duplicates, 0);
    assert.equal(out.supersessions, 0);
    assert.equal(out.actions.length, 0);
    assert.equal(cap.stderr.length, 0, 'no stderr on empty-scope success');
  });
});

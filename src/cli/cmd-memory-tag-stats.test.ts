process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeMemoryTagStatsCommand } from './cmd-memory-tag-stats.js';
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

interface TagStatsJson {
  total_tags: number;
  returned: number;
  limit: number;
  workdir: string | null;
  tags: Array<{
    tag: string;
    memory_count: number;
    total_recall_count: number;
    last_used_at: number | null;
  }>;
}

function bumpRecall(id: string, n: number): void {
  getDb().prepare('UPDATE memories SET recall_count = ? WHERE memory_id = ?').run(n, id);
}

function setAccessedAt(id: string, ts: number): void {
  getDb().prepare('UPDATE memories SET accessed_at = ? WHERE memory_id = ?').run(ts, id);
}

describe('relay memory tag-stats', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
  });

  test('empty store returns total_tags=0 with empty tags array', async () => {
    const cap = makeIO();
    const code = await executeMemoryTagStatsCommand(
      { workdir: undefined, limit: 20, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('')) as TagStatsJson;
    assert.strictEqual(out.total_tags, 0);
    assert.strictEqual(out.returned, 0);
    assert.deepStrictEqual(out.tags, []);
  });

  test('aggregates count, recall sum, and max accessed_at across multi-tag memories', async () => {
    const store = new MemoryStore();
    const wdir = '/test-tag-stats-' + Date.now();
    const a = store.remember({
      content: 'note A about testing pipelines',
      memory_type: 'lesson',
      tags: ['testing', 'ci'],
      workdir: wdir,
    });
    const b = store.remember({
      content: 'note B about testing fixtures',
      memory_type: 'lesson',
      tags: ['testing'],
      workdir: wdir,
    });
    const c = store.remember({
      content: 'note C about deployment scripts',
      memory_type: 'fact',
      tags: ['deploy'],
      workdir: wdir,
    });
    bumpRecall(a, 5);
    bumpRecall(b, 2);
    bumpRecall(c, 7);
    const tA = 1_700_000_000_000;
    const tB = 1_700_000_500_000;
    const tC = 1_700_000_100_000;
    setAccessedAt(a, tA);
    setAccessedAt(b, tB);
    setAccessedAt(c, tC);

    const cap = makeIO();
    const code = await executeMemoryTagStatsCommand(
      { workdir: wdir, limit: 20, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('')) as TagStatsJson;

    // Build a lookup so order-independence on equal counts is fine.
    const byTag = new Map(out.tags.map(t => [t.tag, t]));
    const testing = byTag.get('testing');
    assert.ok(testing, 'expected "testing" tag in stats');
    assert.strictEqual(testing!.memory_count, 2);
    assert.strictEqual(testing!.total_recall_count, 5 + 2);
    assert.strictEqual(testing!.last_used_at, tB);

    const deploy = byTag.get('deploy');
    assert.ok(deploy, 'expected "deploy" tag in stats');
    assert.strictEqual(deploy!.memory_count, 1);
    assert.strictEqual(deploy!.total_recall_count, 7);
    assert.strictEqual(deploy!.last_used_at, tC);

    const ci = byTag.get('ci');
    assert.ok(ci, 'expected "ci" tag in stats');
    assert.strictEqual(ci!.memory_count, 1);
    assert.strictEqual(ci!.total_recall_count, 5);
    assert.strictEqual(ci!.last_used_at, tA);
  });

  test('sorts by memory_count DESC and respects --limit', async () => {
    const store = new MemoryStore();
    const wdir = '/test-tag-stats-sort-' + Date.now();
    // Use the SAME content payload across every entry so extractKeywords()
    // produces an identical auto-keyword set for all rows. That set then has
    // memory_count=6 (one per row) and dominates the ranking, but the
    // explicitly-supplied tags still appear in the right order beneath it.
    const sharedContent = 'shared payload string with reusable wording';
    for (let i = 0; i < 3; i++) {
      // Vary memory_type so the 60s content-hash dedup window does not collapse
      // these into a single row (hash keys on content+workdir+type).
      store.remember({
        content: sharedContent,
        memory_type: i === 0 ? 'fact' : i === 1 ? 'lesson' : 'decision',
        tags: ['z-alpha-tag'],
        workdir: wdir,
      });
    }
    for (let i = 0; i < 2; i++) {
      store.remember({
        content: sharedContent,
        memory_type: i === 0 ? 'context' : 'state',
        tags: ['z-beta-tag'],
        workdir: wdir,
      });
    }
    store.remember({
      content: sharedContent,
      memory_type: 'handoff',
      tags: ['z-gamma-tag'],
      workdir: wdir,
    });

    const cap = makeIO();
    const code = await executeMemoryTagStatsCommand(
      { workdir: wdir, limit: 50, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('')) as TagStatsJson;

    // Verify counts for the explicit tags we set.
    const byTag = new Map(out.tags.map(t => [t.tag, t]));
    assert.strictEqual(byTag.get('z-alpha-tag')?.memory_count, 3);
    assert.strictEqual(byTag.get('z-beta-tag')?.memory_count, 2);
    assert.strictEqual(byTag.get('z-gamma-tag')?.memory_count, 1);

    // Sorting: z-alpha-tag must come before z-beta-tag, and z-beta-tag before z-gamma-tag.
    const idxAlpha = out.tags.findIndex(t => t.tag === 'z-alpha-tag');
    const idxBeta = out.tags.findIndex(t => t.tag === 'z-beta-tag');
    const idxGamma = out.tags.findIndex(t => t.tag === 'z-gamma-tag');
    assert.ok(idxAlpha >= 0 && idxBeta >= 0 && idxGamma >= 0, 'all explicit tags must be present');
    assert.ok(idxAlpha < idxBeta, `z-alpha-tag (idx ${idxAlpha}) must precede z-beta-tag (idx ${idxBeta})`);
    assert.ok(idxBeta < idxGamma, `z-beta-tag (idx ${idxBeta}) must precede z-gamma-tag (idx ${idxGamma})`);

    // --limit honored independently.
    const cap2 = makeIO();
    await executeMemoryTagStatsCommand({ workdir: wdir, limit: 2, json: true }, cap2.io);
    const out2 = JSON.parse(cap2.stdout.join('')) as TagStatsJson;
    assert.strictEqual(out2.returned, 2);
    assert.strictEqual(out2.tags.length, 2);
    assert.ok(out2.total_tags >= 3, 'total_tags counts every distinct tag, including auto-keywords');
  });

  test('--workdir filter scopes results to that workdir (or NULL workdir)', async () => {
    const store = new MemoryStore();
    const wA = '/test-tag-stats-A-' + Date.now();
    const wB = '/test-tag-stats-B-' + Date.now();
    store.remember({
      content: 'A side memory about routing',
      memory_type: 'fact',
      tags: ['routing'],
      workdir: wA,
    });
    store.remember({
      content: 'B side memory about routing',
      memory_type: 'fact',
      tags: ['routing'],
      workdir: wB,
    });

    const cap = makeIO();
    const code = await executeMemoryTagStatsCommand(
      { workdir: wA, limit: 20, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('')) as TagStatsJson;
    const routing = out.tags.find(t => t.tag === 'routing');
    assert.ok(routing, 'expected "routing" tag in stats');
    assert.strictEqual(routing!.memory_count, 1);
  });

  test('superseded memories are excluded from aggregation', async () => {
    const store = new MemoryStore();
    const wdir = '/test-tag-stats-supersede-' + Date.now();
    const id = store.remember({
      content: 'memory that will be forgotten',
      memory_type: 'fact',
      tags: ['ephemeral'],
      workdir: wdir,
    });
    // Soft-delete it
    store.forget(id);

    const cap = makeIO();
    const code = await executeMemoryTagStatsCommand(
      { workdir: wdir, limit: 20, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('')) as TagStatsJson;
    const ephemeral = out.tags.find(t => t.tag === 'ephemeral');
    assert.strictEqual(ephemeral, undefined, 'soft-deleted entry must not contribute');
  });

  test('human-readable output shows table when results exist and friendly message when empty', async () => {
    const store = new MemoryStore();
    const wdir = '/test-tag-stats-human-' + Date.now();

    // Empty case
    const cap1 = makeIO();
    let code = await executeMemoryTagStatsCommand(
      { workdir: wdir, limit: 20, json: false },
      cap1.io
    );
    assert.strictEqual(code, 0);
    assert.match(cap1.stdout.join(''), /No tagged memories/);

    // Populated case
    store.remember({
      content: 'human readable test entry alpha',
      memory_type: 'fact',
      tags: ['human-test-tag'],
      workdir: wdir,
    });
    const cap2 = makeIO();
    code = await executeMemoryTagStatsCommand(
      { workdir: wdir, limit: 20, json: false },
      cap2.io
    );
    assert.strictEqual(code, 0);
    const text = cap2.stdout.join('');
    assert.match(text, /human-test-tag/);
    assert.match(text, /TAG/);
    assert.match(text, /MEMORIES/);
  });

  test('--limit <= 0 returns all rows uncapped', async () => {
    const store = new MemoryStore();
    const wdir = '/test-tag-stats-no-cap-' + Date.now();
    for (let i = 0; i < 5; i++) {
      store.remember({
        content: `unique entry number ${i} content`,
        memory_type: 'fact',
        tags: [`tag-${i}`],
        workdir: wdir,
      });
    }
    const cap = makeIO();
    const code = await executeMemoryTagStatsCommand(
      { workdir: wdir, limit: 0, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('')) as TagStatsJson;
    assert.strictEqual(out.returned, out.total_tags);
    assert.ok(out.total_tags >= 5);
  });

  test('NaN --limit returns exit code 2', async () => {
    const cap = makeIO();
    const code = await executeMemoryTagStatsCommand(
      { workdir: undefined, limit: Number.NaN, json: false },
      cap.io
    );
    assert.strictEqual(code, 2);
    assert.match(cap.stderr.join(''), /must be a finite number/);
  });
});

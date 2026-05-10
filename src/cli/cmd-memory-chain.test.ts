process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeMemoryChainCommand } from './cmd-memory-chain.js';
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

/** Force a single supersession edge a→b directly via SQL — bypasses consolidate(). */
function setSupersededBy(memoryId: string, supersedingId: string): void {
  getDb()
    .prepare('UPDATE memories SET superseded_by = ? WHERE memory_id = ?')
    .run(supersedingId, memoryId);
}

function seed(store: MemoryStore, content: string): string {
  return store.remember({
    content,
    memory_type: 'fact',
    memory_source: 'human',
  });
}

describe('relay memory chain — getChain helper', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
  });

  test('simple linear chain a→b→c walks both directions from each node', () => {
    const store = new MemoryStore();
    const a = seed(store, 'A original fact');
    const b = seed(store, 'B replaces A');
    const c = seed(store, 'C replaces B');
    setSupersededBy(a, b);
    setSupersededBy(b, c);

    // From the middle of the chain we should see one ancestor and one descendant.
    const fromB = store.getChain(b, 5);
    assert.ok(fromB.root);
    assert.strictEqual(fromB.root!.memory_id, b);
    assert.strictEqual(fromB.descendants.length, 1, 'B has one descendant (C)');
    assert.strictEqual(fromB.descendants[0]!.memory.memory_id, c);
    assert.strictEqual(fromB.descendants[0]!.depth, 1);
    assert.strictEqual(fromB.ancestors.length, 1, 'B has one ancestor (A)');
    assert.strictEqual(fromB.ancestors[0]!.memory.memory_id, a);
    assert.strictEqual(fromB.ancestors[0]!.depth, 1);

    // From the head A, descendants is the full forward chain.
    const fromA = store.getChain(a, 5);
    assert.deepStrictEqual(
      fromA.descendants.map(n => n.memory.memory_id),
      [b, c],
    );
    assert.strictEqual(fromA.ancestors.length, 0);
    assert.strictEqual(fromA.root_superseded_by, b);
  });

  test('--depth 0 returns just the root', () => {
    const store = new MemoryStore();
    const a = seed(store, 'A');
    const b = seed(store, 'B');
    setSupersededBy(a, b);

    const chain = store.getChain(a, 0);
    assert.ok(chain.root);
    assert.strictEqual(chain.descendants.length, 0);
    assert.strictEqual(chain.ancestors.length, 0);
  });

  test('branched ancestors — multiple memories superseded by the same root', () => {
    const store = new MemoryStore();
    const root = seed(store, 'merged keeper');
    const x = seed(store, 'x duplicate');
    const y = seed(store, 'y duplicate');
    const z = seed(store, 'z duplicate (older twin of y)');
    setSupersededBy(x, root);
    setSupersededBy(y, root);
    setSupersededBy(z, root);

    const chain = store.getChain(root, 5);
    assert.strictEqual(chain.ancestors.length, 3);
    const ids = new Set(chain.ancestors.map(n => n.memory.memory_id));
    assert.deepStrictEqual(ids, new Set([x, y, z]));
    // All ancestors are at depth 1 (direct supersessions).
    for (const node of chain.ancestors) assert.strictEqual(node.depth, 1);
    assert.strictEqual(chain.descendants.length, 0);
  });

  test('chain ends at tombstone sentinel and never follows it', () => {
    const store = new MemoryStore();
    const a = seed(store, 'A');
    setSupersededBy(a, 'gc-token-budget');

    const chain = store.getChain(a, 5);
    assert.ok(chain.root);
    assert.strictEqual(chain.descendants.length, 0, 'sentinel is not a real id — chain stops');
    assert.strictEqual(chain.root_superseded_by, 'gc-token-budget');
  });

  test('depth limit truncates the forward walk', () => {
    const store = new MemoryStore();
    const a = seed(store, 'A');
    const b = seed(store, 'B');
    const c = seed(store, 'C');
    const d = seed(store, 'D');
    setSupersededBy(a, b);
    setSupersededBy(b, c);
    setSupersededBy(c, d);

    const chain = store.getChain(a, 2);
    assert.deepStrictEqual(
      chain.descendants.map(n => n.memory.memory_id),
      [b, c],
      'depth=2 returns 2 descendants, never the third',
    );
  });

  test('missing id returns null root', () => {
    const store = new MemoryStore();
    const chain = store.getChain('00000000-0000-0000-0000-000000000000', 5);
    assert.strictEqual(chain.root, null);
    assert.strictEqual(chain.ancestors.length, 0);
    assert.strictEqual(chain.descendants.length, 0);
  });
});

describe('relay memory chain — CLI', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
  });

  test('rejects when memory_id is missing (exit 2)', async () => {
    const cap = makeIO();
    const code = await executeMemoryChainCommand(
      { memoryId: '', depth: 5, json: false },
      cap.io,
    );
    assert.strictEqual(code, 2);
    assert.match(cap.stderr.join(''), /requires <memory_id>/);
  });

  test('rejects negative --depth (exit 2)', async () => {
    const cap = makeIO();
    const code = await executeMemoryChainCommand(
      { memoryId: 'whatever', depth: -1, json: false },
      cap.io,
    );
    assert.strictEqual(code, 2);
    assert.match(cap.stderr.join(''), /--depth must be >= 0/);
  });

  test('returns exit 1 + JSON error when memory does not exist', async () => {
    const cap = makeIO();
    const code = await executeMemoryChainCommand(
      { memoryId: 'no-such-id', depth: 5, json: true },
      cap.io,
    );
    assert.strictEqual(code, 1);
    const out = JSON.parse(cap.stdout.join('')) as { error: string; memory_id: string };
    assert.strictEqual(out.error, 'not_found');
    assert.strictEqual(out.memory_id, 'no-such-id');
  });

  test('--json emits structured tree with both directions', async () => {
    const store = new MemoryStore();
    const a = seed(store, 'ancestor entry');
    const b = seed(store, 'middle entry');
    const c = seed(store, 'newest entry');
    setSupersededBy(a, b);
    setSupersededBy(b, c);

    const cap = makeIO();
    const code = await executeMemoryChainCommand(
      { memoryId: b, depth: 5, json: true },
      cap.io,
    );
    assert.strictEqual(code, 0);

    interface JsonShape {
      root: { memory_id: string; superseded_by: string | null };
      ancestors: Array<{ memory_id: string; depth: number }>;
      descendants: Array<{ memory_id: string; depth: number }>;
      depth: number;
    }
    const out = JSON.parse(cap.stdout.join('')) as JsonShape;
    assert.strictEqual(out.root.memory_id, b);
    assert.strictEqual(out.root.superseded_by, c);
    assert.strictEqual(out.depth, 5);
    assert.deepStrictEqual(out.ancestors.map(n => n.memory_id), [a]);
    assert.deepStrictEqual(out.descendants.map(n => n.memory_id), [c]);
    assert.strictEqual(out.ancestors[0]!.depth, 1);
    assert.strictEqual(out.descendants[0]!.depth, 1);
  });

  test('human-mode output includes ROOT, ANCESTORS, and DESCENDANTS sections', async () => {
    const store = new MemoryStore();
    const a = seed(store, 'old fact');
    const b = seed(store, 'new fact');
    setSupersededBy(a, b);

    const cap = makeIO();
    const code = await executeMemoryChainCommand(
      { memoryId: a, depth: 5, json: false },
      cap.io,
    );
    assert.strictEqual(code, 0);
    const text = cap.stdout.join('');
    assert.match(text, /ROOT/);
    assert.match(text, /DESCENDANTS/);
    assert.match(text, new RegExp(b));
    // Active leaf has no ancestors at the head, so we expect the explicit empty notice.
    assert.match(text, /ANCESTORS\s+\(none/);
  });
});

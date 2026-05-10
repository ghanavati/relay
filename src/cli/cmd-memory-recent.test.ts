process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  executeMemoryRecentCommand,
  truncateContent,
  type MemoryRecentJsonEntry,
} from './cmd-memory-recent.js';
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

function seed(store: MemoryStore, content: string, opts: { workdir?: string | null } = {}): string {
  return store.remember({
    content,
    memory_type: 'fact',
    workdir: opts.workdir ?? null,
    memory_source: 'human',
  });
}

describe('truncateContent', () => {
  test('passes short content unchanged', () => {
    assert.strictEqual(truncateContent('hello world'), 'hello world');
  });
  test('truncates long content with ellipsis', () => {
    const out = truncateContent('a'.repeat(200), 50);
    assert.strictEqual(out.length, 50);
    assert.ok(out.endsWith('…'));
  });
  test('flattens whitespace', () => {
    assert.strictEqual(truncateContent('foo\n  bar\tbaz'), 'foo bar baz');
  });
});

describe('executeMemoryRecentCommand', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
  });

  test('JSON output ordered by created_at DESC', async () => {
    const store = new MemoryStore();
    const id1 = seed(store, 'oldest fact');
    // Force created_at ordering deterministically — remember() stamps Date.now()
    // and tests can run inside the same millisecond on fast machines.
    getDb().prepare('UPDATE memories SET created_at = ? WHERE memory_id = ?').run(1000, id1);
    const id2 = seed(store, 'middle fact');
    getDb().prepare('UPDATE memories SET created_at = ? WHERE memory_id = ?').run(2000, id2);
    const id3 = seed(store, 'newest fact');
    getDb().prepare('UPDATE memories SET created_at = ? WHERE memory_id = ?').run(3000, id3);

    const cap = makeIO();
    const code = await executeMemoryRecentCommand(
      { limit: 10, workdir: undefined, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);
    const entries = JSON.parse(cap.stdout.join('')) as MemoryRecentJsonEntry[];
    assert.deepStrictEqual(entries.map(e => e.memory_id), [id3, id2, id1]);
    assert.strictEqual(entries[0]!.created_at_iso, new Date(3000).toISOString());
    assert.strictEqual(entries[0]!.memory_type, 'fact');
  });

  test('honors --limit', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 5; i++) seed(store, `fact ${i}`);

    const cap = makeIO();
    const code = await executeMemoryRecentCommand(
      { limit: 2, workdir: undefined, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);
    const entries = JSON.parse(cap.stdout.join('')) as MemoryRecentJsonEntry[];
    assert.strictEqual(entries.length, 2);
  });

  test('--workdir filter narrows to that workdir + global memories', async () => {
    const store = new MemoryStore();
    const projectId = seed(store, 'project memory', { workdir: '/tmp/proj-a' });
    const otherId = seed(store, 'other memory', { workdir: '/tmp/proj-b' });
    const globalId = seed(store, 'global memory', { workdir: null });

    const cap = makeIO();
    const code = await executeMemoryRecentCommand(
      { limit: 10, workdir: '/tmp/proj-a', json: true },
      cap.io
    );
    assert.strictEqual(code, 0);
    const entries = JSON.parse(cap.stdout.join('')) as MemoryRecentJsonEntry[];
    const ids = new Set(entries.map(e => e.memory_id));
    assert.ok(ids.has(projectId), 'expected project memory to be returned');
    assert.ok(ids.has(globalId), 'expected global (workdir=null) memory to be returned');
    assert.ok(!ids.has(otherId), 'must not return memory from a different workdir');
  });

  test('renders human-friendly columns by default', async () => {
    const store = new MemoryStore();
    seed(store, 'a' .repeat(120));
    const cap = makeIO();
    const code = await executeMemoryRecentCommand(
      { limit: 10, workdir: undefined, json: false },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /created_at/);
    assert.match(out, /type/);
    assert.match(out, /trust/);
    assert.match(out, /content/);
    assert.match(out, /tags/);
    // 80-char preview truncation — content row should NOT contain the
    // full 120-char run, but should end with the ellipsis marker.
    assert.match(out, /…/);
  });

  test('empty store prints friendly message in human mode', async () => {
    const cap = makeIO();
    const code = await executeMemoryRecentCommand(
      { limit: 10, workdir: undefined, json: false },
      cap.io
    );
    assert.strictEqual(code, 0);
    assert.match(cap.stdout.join(''), /No memories found/);
  });

  test('rejects non-positive --limit', async () => {
    const cap = makeIO();
    const code = await executeMemoryRecentCommand(
      { limit: 0, workdir: undefined, json: false },
      cap.io
    );
    assert.strictEqual(code, 2);
    assert.match(cap.stderr.join(''), /--limit must be a positive integer/);
  });
});

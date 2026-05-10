process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeMemorySearchCommand } from './cmd-memory-search.js';
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

interface JsonHit {
  memory_id: string;
  content: string;
  match: { start: number; end: number };
  workdir: string | null;
  memory_type: string;
}

interface JsonOutput {
  pattern: string;
  workdir: string | null;
  limit: number;
  hit_count: number;
  hits: JsonHit[];
}

describe('relay memory search', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
  });

  test('regex match returns hits', async () => {
    const store = new MemoryStore();
    store.remember({
      content: 'Always run npm test before committing changes to the main branch.',
      memory_type: 'lesson',
    });
    store.remember({
      content: 'Cache results from API calls when the response payload is large.',
      memory_type: 'fact',
    });

    const cap = makeIO();
    const exit = await executeMemorySearchCommand(
      { pattern: 'npm test', limit: 50, json: true },
      cap.io
    );
    assert.equal(exit, 0);
    const out = JSON.parse(cap.stdout[0]!) as JsonOutput;
    assert.equal(out.hit_count, 1);
    assert.match(out.hits[0]!.content, /npm test/);
    // Match offsets must point at the literal substring.
    const hit = out.hits[0]!;
    assert.equal(hit.content.slice(hit.match.start, hit.match.end), 'npm test');
  });

  test('regex with character class matches multiple memories', async () => {
    const store = new MemoryStore();
    store.remember({
      content: 'API key sk-prod-abc123 was rotated yesterday after the leak.',
      memory_type: 'fact',
    });
    store.remember({
      content: 'Token sk-test-xyz789 belongs to the staging environment only.',
      memory_type: 'fact',
    });
    store.remember({
      content: 'Unrelated lesson without any secret-looking strings whatsoever here.',
      memory_type: 'lesson',
    });

    const cap = makeIO();
    const exit = await executeMemorySearchCommand(
      { pattern: 'sk-(prod|test)-[a-z0-9]+', limit: 50, json: true },
      cap.io
    );
    assert.equal(exit, 0);
    const out = JSON.parse(cap.stdout[0]!) as JsonOutput;
    assert.equal(out.hit_count, 2);
  });

  test('no match returns empty array with exit 0', async () => {
    const store = new MemoryStore();
    store.remember({
      content: 'A lesson about avoiding mutation in JavaScript codebases.',
      memory_type: 'lesson',
    });

    const cap = makeIO();
    const exit = await executeMemorySearchCommand(
      { pattern: 'nonexistent-token-xyz-9999', limit: 50, json: true },
      cap.io
    );
    assert.equal(exit, 0);
    const out = JSON.parse(cap.stdout[0]!) as JsonOutput;
    assert.equal(out.hit_count, 0);
    assert.deepEqual(out.hits, []);
  });

  test('invalid regex exits 2 with error message', async () => {
    const cap = makeIO();
    const exit = await executeMemorySearchCommand(
      { pattern: '[unclosed', limit: 50, json: true },
      cap.io
    );
    assert.equal(exit, 2);
    const out = JSON.parse(cap.stdout[0]!) as { error: string };
    assert.match(out.error, /invalid regex/);
  });

  test('empty pattern exits 2', async () => {
    const cap = makeIO();
    const exit = await executeMemorySearchCommand(
      { pattern: '   ', limit: 50, json: false },
      cap.io
    );
    assert.equal(exit, 2);
    assert.match(cap.stderr.join(''), /requires a <regex>/);
  });

  test('--workdir filter restricts search to that workdir (NULL workdir included)', async () => {
    const store = new MemoryStore();
    store.remember({
      content: 'Workdir-A specific lesson about local caching strategies adopted here.',
      memory_type: 'lesson',
      workdir: '/repo/a',
    });
    store.remember({
      content: 'Workdir-B specific lesson about local caching strategies adopted here.',
      memory_type: 'lesson',
      workdir: '/repo/b',
    });
    store.remember({
      content: 'Global memory about local caching strategies that applies everywhere.',
      memory_type: 'lesson',
      workdir: null,
    });

    const cap = makeIO();
    const exit = await executeMemorySearchCommand(
      { pattern: 'local caching', workdir: '/repo/a', limit: 50, json: true },
      cap.io
    );
    assert.equal(exit, 0);
    const out = JSON.parse(cap.stdout[0]!) as JsonOutput;
    // Workdir-A entry + global (NULL) entry; workdir-B excluded.
    assert.equal(out.hit_count, 2);
    // Order is created_at DESC; assert set membership rather than order.
    const workdirSet = new Set(out.hits.map(h => h.workdir));
    assert.ok(workdirSet.has(null), 'global (NULL workdir) memory must be included');
    assert.ok(workdirSet.has('/repo/a'), 'workdir-A memory must be included');
    assert.ok(!workdirSet.has('/repo/b'), 'workdir-B memory must be excluded');
  });

  test('--limit caps the result count', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 10; i++) {
      store.remember({
        content: `MATCHME entry number ${i} with unique padding text ${i * 17}.`,
        memory_type: 'fact',
      });
    }
    const cap = makeIO();
    const exit = await executeMemorySearchCommand(
      { pattern: 'MATCHME', limit: 3, json: true },
      cap.io
    );
    assert.equal(exit, 0);
    const out = JSON.parse(cap.stdout[0]!) as JsonOutput;
    assert.equal(out.hit_count, 3);
  });

  test('invalid --limit exits 2', async () => {
    const cap = makeIO();
    const exit = await executeMemorySearchCommand(
      { pattern: 'foo', limit: 0, json: true },
      cap.io
    );
    assert.equal(exit, 2);
    const out = JSON.parse(cap.stdout[0]!) as { error: string };
    assert.match(out.error, /limit/);
  });

  test('superseded memories are excluded', async () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'Soon-to-be-forgotten unique-marker phrase for search test.',
      memory_type: 'fact',
    });
    store.forget(id); // soft delete
    const cap = makeIO();
    const exit = await executeMemorySearchCommand(
      { pattern: 'unique-marker', limit: 50, json: true },
      cap.io
    );
    assert.equal(exit, 0);
    const out = JSON.parse(cap.stdout[0]!) as JsonOutput;
    assert.equal(out.hit_count, 0);
  });

  test('human (non-json) output renders summary with match info', async () => {
    const store = new MemoryStore();
    store.remember({
      content: 'A lesson about prefer immutable data over mutation in TypeScript.',
      memory_type: 'lesson',
    });
    const cap = makeIO();
    const exit = await executeMemorySearchCommand(
      { pattern: 'immutable', limit: 50, json: false },
      cap.io
    );
    assert.equal(exit, 0);
    const text = cap.stdout.join('');
    assert.match(text, /Found 1 match/);
    assert.match(text, /immutable/);
  });

  test('human output reports no matches when empty', async () => {
    const cap = makeIO();
    const exit = await executeMemorySearchCommand(
      { pattern: 'absent', limit: 50, json: false },
      cap.io
    );
    assert.equal(exit, 0);
    assert.match(cap.stdout.join(''), /No memories matched/);
  });
});

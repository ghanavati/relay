process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeMemoryDiffCommand, diffLines, buildHunks } from './cmd-memory-diff.js';
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
    stdout, stderr,
  };
}

describe('diffLines (LCS unit)', () => {
  test('identical arrays produce only eq ops', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'b', 'c']);
    assert.strictEqual(ops.filter(o => o.kind !== 'eq').length, 0);
    assert.strictEqual(ops.length, 3);
  });

  test('pure addition surfaces add ops', () => {
    const ops = diffLines([], ['x', 'y']);
    assert.deepStrictEqual(ops.map(o => o.kind), ['add', 'add']);
    assert.strictEqual(ops[0]!.text, 'x');
  });

  test('pure deletion surfaces del ops', () => {
    const ops = diffLines(['x', 'y'], []);
    assert.deepStrictEqual(ops.map(o => o.kind), ['del', 'del']);
  });

  test('replacement renders as del+add pair', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'B', 'c']);
    const kinds = ops.map(o => o.kind);
    assert.ok(kinds.includes('del'));
    assert.ok(kinds.includes('add'));
    // The 'a' and 'c' lines should remain as eq ops.
    assert.strictEqual(ops.filter(o => o.kind === 'eq').length, 2);
  });
});

describe('buildHunks', () => {
  test('all-eq input produces zero hunks', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'b', 'c']);
    assert.strictEqual(buildHunks(ops).length, 0);
  });

  test('a single change produces one hunk with context', () => {
    const ops = diffLines(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'X', 'd', 'e']);
    const hunks = buildHunks(ops, 1);
    assert.strictEqual(hunks.length, 1);
    // Should include at least the change itself.
    const kinds = hunks[0]!.ops.map(o => o.kind);
    assert.ok(kinds.includes('del'));
    assert.ok(kinds.includes('add'));
  });
});

describe('executeMemoryDiffCommand', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
  });

  test('returns 1 and prints not_found when both ids missing (text mode)', () => {
    const cap = makeIO();
    const code = executeMemoryDiffCommand({ idA: 'nope-a', idB: 'nope-b', json: false }, cap.io);
    assert.strictEqual(code, 1);
    const err = cap.stderr.join('');
    assert.match(err, /not found/i);
    assert.match(err, /nope-a/);
    assert.match(err, /nope-b/);
  });

  test('returns 1 and prints not_found when one id missing (json mode)', () => {
    const store = new MemoryStore();
    const realId = store.remember({ content: 'something', memory_type: 'fact' });
    const cap = makeIO();
    const code = executeMemoryDiffCommand({ idA: realId, idB: 'missing-id', json: true }, cap.io);
    assert.strictEqual(code, 1);
    const payload = JSON.parse(cap.stdout.join('').trim()) as { error: string; missing: string[] };
    assert.strictEqual(payload.error, 'not_found');
    assert.deepStrictEqual(payload.missing, ['missing-id']);
  });

  test('identical content yields zero hunks and "(identical content)" marker', () => {
    const store = new MemoryStore();
    const a = store.remember({ content: 'shared body line', memory_type: 'fact', tags: ['x'] });
    const b = store.remember({ content: 'shared body line', memory_type: 'fact', tags: ['y'] });
    const cap = makeIO();
    const code = executeMemoryDiffCommand({ idA: a, idB: b, json: false }, cap.io);
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /identical content/);
  });

  test('--json mode emits {a, b, additions, deletions, hunks} with content fields', () => {
    const store = new MemoryStore();
    const a = store.remember({ content: 'alpha\nbeta\ngamma', memory_type: 'fact' });
    const b = store.remember({ content: 'alpha\nBETA\ngamma', memory_type: 'fact' });
    const cap = makeIO();
    const code = executeMemoryDiffCommand({ idA: a, idB: b, json: true }, cap.io);
    assert.strictEqual(code, 0);
    const payload = JSON.parse(cap.stdout.join('').trim()) as {
      a: { id: string; content: string };
      b: { id: string; content: string };
      additions: number;
      deletions: number;
      hunks: Array<{ a_start: number; a_count: number; b_start: number; b_count: number; ops: Array<{ kind: string; text: string }> }>;
    };
    assert.strictEqual(payload.a.id, a);
    assert.strictEqual(payload.b.id, b);
    assert.strictEqual(payload.a.content, 'alpha\nbeta\ngamma');
    assert.strictEqual(payload.b.content, 'alpha\nBETA\ngamma');
    assert.strictEqual(payload.additions, 1);
    assert.strictEqual(payload.deletions, 1);
    assert.strictEqual(payload.hunks.length, 1);
    const ops = payload.hunks[0]!.ops;
    assert.ok(ops.some(o => o.kind === 'add' && o.text === 'BETA'));
    assert.ok(ops.some(o => o.kind === 'del' && o.text === 'beta'));
  });

  test('text mode shows colored-or-plain +/- markers and hunk header', () => {
    process.env['NO_COLOR'] = '1'; // force plain text for stable assertions
    const store = new MemoryStore();
    const a = store.remember({ content: 'one\ntwo\nthree', memory_type: 'fact' });
    const b = store.remember({ content: 'one\ntwo modified\nthree', memory_type: 'fact' });
    const cap = makeIO();
    const code = executeMemoryDiffCommand({ idA: a, idB: b, json: false }, cap.io);
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /^--- /m);
    assert.match(out, /^\+\+\+ /m);
    assert.match(out, /@@ /);
    assert.match(out, /^-two$/m);
    assert.match(out, /^\+two modified$/m);
    delete process.env['NO_COLOR'];
  });
});

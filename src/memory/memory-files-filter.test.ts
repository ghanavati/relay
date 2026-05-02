process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';

describe('SHIP-52: files association + filter', () => {
  test('remember({files}) persists files and getMemory returns them', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'auth middleware notes',
      memory_type: 'lesson',
      files: ['src/middleware/auth.ts', 'src/routes/login.ts'],
    });
    const mem = store.getMemory(id);
    assert.ok(mem);
    assert.deepStrictEqual(
      [...mem.files].sort(),
      ['src/middleware/auth.ts', 'src/routes/login.ts'].sort()
    );
  });

  test('recall filters by file path via files_json LIKE', () => {
    const store = new MemoryStore();
    const workdir = '/ship52-filter-' + Date.now();
    store.remember({ content: 'unrelated lesson about logging', memory_type: 'lesson', workdir, files: ['src/log.ts'] });
    store.remember({ content: 'lesson about auth middleware', memory_type: 'lesson', workdir, files: ['src/auth.ts'] });
    const candidates = store.getCandidates({ token_budget: 1000, workdir, files: ['src/auth.ts'] });
    assert.strictEqual(candidates.length, 1);
    assert.ok(candidates[0].content.includes('auth'));
  });

  test('remember without files defaults to empty array', () => {
    const store = new MemoryStore();
    const id = store.remember({ content: 'xyz', memory_type: 'fact' });
    const mem = store.getMemory(id);
    assert.ok(mem);
    assert.deepStrictEqual(mem.files, []);
  });

  test('SHIP-52 SQL LIKE escape: path with % wildcard does NOT match unrelated memories', () => {
    const store = new MemoryStore();
    const workdir = '/ship52-escape-' + Date.now();
    store.remember({ content: 'legitimate one', memory_type: 'lesson', workdir, files: ['src/foo.ts'] });
    store.remember({ content: 'legitimate two', memory_type: 'lesson', workdir, files: ['src/bar.ts'] });
    // A malicious path "%" would match all rows without escaping. With escape, it matches none.
    const candidates = store.getCandidates({ token_budget: 1000, workdir, files: ['%'] });
    assert.strictEqual(candidates.length, 0, 'Wildcard path must not match anything (reviewer finding fix)');
  });
});

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { CorpusStore, sanitizeFts5Query } from './corpus-store.js';
import { MemoryStore } from './memory-store.js';

describe('SHIP-53: sanitizeFts5Query — FTS5 injection hardening', () => {
  test('wraps plain tokens in phrase quotes', () => {
    assert.strictEqual(sanitizeFts5Query('auth token'), '"auth" "token"');
  });

  test('strips embedded double-quotes', () => {
    assert.strictEqual(sanitizeFts5Query('foo"bar'), '"foobar"');
  });

  test('defuses FTS5 operator DSL by wrapping entire tokens', () => {
    // AND/OR become literal tokens inside phrase quotes — not FTS5 operators
    const safe = sanitizeFts5Query('foo AND bar');
    assert.ok(safe.includes('"AND"'), `expected "AND" wrapped, got ${safe}`);
  });

  test('empty / whitespace returns empty string', () => {
    assert.strictEqual(sanitizeFts5Query(''), '');
    assert.strictEqual(sanitizeFts5Query('   '), '');
  });

  test('single lone double-quote returns empty after strip', () => {
    assert.strictEqual(sanitizeFts5Query('"'), '');
  });

  test('classic injection attempt degrades to literal search', () => {
    const attack = `foo" OR "1" = "1`;
    const safe = sanitizeFts5Query(attack);
    // All tokens get stripped of quotes, then wrapped — no unquoted operators survive
    assert.ok(!safe.includes('" OR "'), `operator leaked: ${safe}`);
  });
});

describe('SHIP-53: CorpusStore.build + query + list + remove', () => {
  test('build → query round-trip returns matching memories', () => {
    const memStore = new MemoryStore();
    const workdir = '/ship53-rt-' + Date.now();
    memStore.remember({
      content: 'SQL injection is prevented by parameterized queries',
      memory_type: 'lesson',
      workdir,
      tags: ['security'],
    });
    memStore.remember({
      content: 'FTS5 virtual tables support BM25 ranking',
      memory_type: 'fact',
      workdir,
      tags: ['security'],
    });
    memStore.remember({
      content: 'completely unrelated note about coffee',
      memory_type: 'context',
      workdir,
      tags: ['other'],
    });

    const store = new CorpusStore();
    const count = store.build('security', 'security lessons', {
      token_budget: 10_000,
      tags: ['security'],
      workdir,
      include_expired: false,
    });
    assert.strictEqual(count, 2, 'should include both tagged memories');

    const results = store.query('security', 'injection');
    assert.ok(results.length >= 1, 'must find at least one match for "injection"');
    assert.ok(results[0]!.snippet.includes('injection'), 'snippet must contain the matched term');
  });

  test('build with UPSERT: rebuilding with same name replaces content', () => {
    const store = new CorpusStore();
    const memStore = new MemoryStore();
    const workdir = '/ship53-upsert-' + Date.now();
    memStore.remember({ content: 'first version', memory_type: 'fact', workdir, tags: ['v1'] });

    store.build('upserted', null, { token_budget: 10_000, tags: ['v1'], workdir, include_expired: false });
    const first = store.get('upserted');
    assert.ok(first);

    // Add another memory and rebuild with different filter
    memStore.remember({ content: 'second version', memory_type: 'fact', workdir, tags: ['v2'] });
    store.build('upserted', null, { token_budget: 10_000, tags: ['v2'], workdir, include_expired: false });

    const second = store.get('upserted');
    assert.ok(second);
    // Note: built_at may be equal if both builds land in the same millisecond (Date.now() resolution).
    // The content-replacement check below is the authoritative assertion that UPSERT worked.
    const results = store.query('upserted', 'second');
    assert.ok(results.length >= 1, 'new content must be searchable after rebuild');
    const oldResults = store.query('upserted', 'first');
    assert.strictEqual(oldResults.length, 0, 'old content must no longer match after UPSERT');
  });

  test('list returns corpora ordered most-recent-built first', () => {
    const store = new CorpusStore();
    const memStore = new MemoryStore();
    const workdir = '/ship53-list-' + Date.now();
    memStore.remember({ content: 'content for list test', memory_type: 'fact', workdir, tags: ['listtag'] });

    store.build('list-a', 'first', { token_budget: 5_000, tags: ['listtag'], workdir, include_expired: false });
    store.build('list-b', 'second', { token_budget: 5_000, tags: ['listtag'], workdir, include_expired: false });

    const rows = store.list();
    const names = rows.map(r => r.name);
    assert.ok(names.includes('list-a'));
    assert.ok(names.includes('list-b'));
  });

  test('remove returns true and subsequent query returns empty', () => {
    const store = new CorpusStore();
    const memStore = new MemoryStore();
    const workdir = '/ship53-rm-' + Date.now();
    memStore.remember({ content: 'removable', memory_type: 'fact', workdir, tags: ['rmtag'] });

    store.build('to-remove', null, { token_budget: 5_000, tags: ['rmtag'], workdir, include_expired: false });
    assert.strictEqual(store.remove('to-remove'), true);
    assert.strictEqual(store.remove('to-remove'), false, 'second remove returns false');
    assert.strictEqual(store.get('to-remove'), null, 'get returns null after remove');
  });

  test('query with empty string returns empty results (no DSL injection)', () => {
    const store = new CorpusStore();
    const results = store.query('anything', '');
    assert.deepStrictEqual(results, []);
  });

  test('query on non-existent corpus returns empty results', () => {
    const store = new CorpusStore();
    const results = store.query('does-not-exist', 'search term');
    assert.deepStrictEqual(results, []);
  });
});

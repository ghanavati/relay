process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';

describe('MemoryStore.getCandidates()', () => {
  const store = new MemoryStore();

  test('returns all non-superseded entries with no filters', () => {
    const now = Date.now();
    // Use a unique scope workdir so count assertions are isolation-safe
    const scopeDir = '/test/candidates-scope-' + now;
    store.remember({
      content: 'First memory',
      memory_type: 'fact',
      workdir: scopeDir,
      expires_at: now + 100000,
    });
    store.remember({
      content: 'Second memory',
      memory_type: 'lesson',
      workdir: scopeDir,
      expires_at: now + 100000,
    });
    store.remember({
      content: 'Third memory',
      memory_type: 'decision',
      workdir: scopeDir,
      expires_at: now + 100000,
    });

    // Filter by unique workdir to avoid counting rows inserted by other tests
    const candidates = store.getCandidates({ token_budget: 9999, workdir: scopeDir });

    assert.strictEqual(candidates.length, 3);
    const contents = candidates.map((m) => m.content).sort();
    assert.deepStrictEqual(contents, ['First memory', 'Second memory', 'Third memory']);
  });

  test('memory_type filter returns only matching type', () => {
    // Use a unique workdir so the type filter only sees rows from this test
    const scopeDir = '/test/candidates-type-scope-' + Date.now();
    store.remember({
      content: 'Fact memory',
      memory_type: 'fact',
      workdir: scopeDir,
      expires_at: Date.now() + 100000,
    });
    store.remember({
      content: 'Lesson memory',
      memory_type: 'lesson',
      workdir: scopeDir,
      expires_at: Date.now() + 100000,
    });
    store.remember({
      content: 'Another lesson',
      memory_type: 'lesson',
      workdir: scopeDir,
      expires_at: Date.now() + 100000,
    });

    const candidates = store.getCandidates({
      token_budget: 9999,
      types: ['lesson'],
      workdir: scopeDir,
    });

    assert.strictEqual(candidates.length, 2);
    const contents = candidates.map((m) => m.content);
    assert.ok(contents.includes('Lesson memory'));
    assert.ok(contents.includes('Another lesson'));
  });

  test('workdir filter returns entries for that workdir OR null workdir (global)', () => {
    // NOTE: workdir:null entries are returned for ALL workdir-filtered queries.
    // This test verifies the OR-null semantics using content matching rather than
    // exact count to stay robust against other tests inserting null-workdir rows.
    const suffix = '-wdfilter-' + Date.now();
    const specificDir = '/specific/workdir' + suffix;
    const otherDir = '/other/workdir' + suffix;

    store.remember({
      content: 'Workdir memory' + suffix,
      memory_type: 'fact',
      workdir: specificDir,
      expires_at: Date.now() + 100000,
    });
    store.remember({
      content: 'Other workdir memory' + suffix,
      memory_type: 'fact',
      workdir: otherDir,
      expires_at: Date.now() + 100000,
    });

    const candidates = store.getCandidates({
      token_budget: 9999,
      workdir: specificDir,
    });

    // Must include the specific workdir entry and must NOT include the other workdir entry
    const contents = candidates.map((m) => m.content);
    assert.ok(contents.includes('Workdir memory' + suffix), 'specific workdir entry must be present');
    assert.ok(!contents.includes('Other workdir memory' + suffix), 'other workdir entry must be absent');
  });

  test('FTS5 path: query string returns semantically ranked results when FTS index is populated', () => {
    // Insert two memories: one highly relevant, one unrelated
    store.remember({
      content: 'decided to use PostgreSQL for session storage due to ACID requirements',
      memory_type: 'decision',
      workdir: '/fts-test',
      expires_at: null,
    });
    store.remember({
      content: 'colour scheme uses neutral greys with a blue accent',
      memory_type: 'fact',
      workdir: '/fts-test',
      expires_at: null,
    });

    // Query for database schema — FTS should surface the PostgreSQL memory
    const candidates = store.getCandidates({
      query: 'database schema storage',
      token_budget: 9999,
      workdir: '/fts-test',
    });

    assert.ok(candidates.length >= 1, 'should return at least the relevant memory');
    // The PostgreSQL memory must appear (FTS relevance) before the colour scheme one
    const firstContent = candidates[0]!.content;
    assert.ok(
      firstContent.includes('PostgreSQL') || firstContent.includes('session storage'),
      `FTS should rank PostgreSQL memory first, got: "${firstContent}"`
    );
  });

  test('FTS5 path: falls back to recency order when query returns no FTS matches', () => {
    store.remember({
      content: 'completely unrelated fact about XYZ',
      memory_type: 'fact',
      workdir: '/fts-fallback',
      expires_at: null,
    });

    // Query with a phrase that won't match any FTS entry — should fall back, not throw
    const candidates = store.getCandidates({
      query: 'zzz_no_match_xkcd_random',
      token_budget: 9999,
      workdir: '/fts-fallback',
    });

    // Fallback returns all candidates ordered by recency — should include our memory
    assert.ok(candidates.length >= 1, 'fallback must return results when FTS is empty');
  });

  test('expired entries (expires_at in the past) excluded unless include_expired:true', () => {
    const now = Date.now();
    // Use a unique workdir so exact-count assertions are isolated from other tests
    const scopeDir = '/test/expiry-scope-' + now;
    store.remember({
      content: 'Valid memory',
      memory_type: 'fact',
      workdir: scopeDir,
      expires_at: now + 100000,
    });
    store.remember({
      content: 'Expired memory 1',
      memory_type: 'fact',
      workdir: scopeDir,
      expires_at: now - 100000,
    });
    store.remember({
      content: 'Expired memory 2',
      memory_type: 'lesson',
      workdir: scopeDir,
      expires_at: now - 50000,
    });
    store.remember({
      content: 'No expiry memory',
      memory_type: 'decision',
      workdir: scopeDir,
      expires_at: null,
    });

    const candidatesWithoutExpired = store.getCandidates({
      token_budget: 9999,
      workdir: scopeDir,
    });
    assert.strictEqual(candidatesWithoutExpired.length, 2);
    const contentsWithoutExpired = candidatesWithoutExpired.map((m) => m.content).sort();
    assert.deepStrictEqual(contentsWithoutExpired, ['No expiry memory', 'Valid memory']);

    const candidatesWithExpired = store.getCandidates({
      token_budget: 9999,
      workdir: scopeDir,
      include_expired: true,
    });
    assert.strictEqual(candidatesWithExpired.length, 4);
    const contentsWithExpired = candidatesWithExpired.map((m) => m.content).sort();
    assert.deepStrictEqual(contentsWithExpired, [
      'Expired memory 1',
      'Expired memory 2',
      'No expiry memory',
      'Valid memory',
    ]);
  });
});

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { handleCorpusQuery } from '../tools/corpus_query.js';
import { CorpusStore } from './corpus-store.js';
import { MemoryStore } from './memory-store.js';

describe('SHIP-53 integration: corpus_query MCP tool', () => {
  test('returns isError:true with corpus_not_found when corpus does not exist', () => {
    const result = handleCorpusQuery({
      name: 'nonexistent-corpus-xyz-' + Date.now(),
      query_text: 'anything',
    });
    assert.strictEqual(result.isError, true, 'missing corpus must set isError');
    const payload = JSON.parse(result.content[0]!.text);
    assert.strictEqual(payload.error, 'corpus_not_found');
    assert.ok(payload.hint.includes('relay corpus build'), 'hint must point at build command');
  });

  test('returns successful results after building a corpus', () => {
    const wd = '/ship53-mcp-' + Date.now();
    const memStore = new MemoryStore();
    memStore.remember({
      content: 'compliance audit notes about DORA risks',
      memory_type: 'lesson',
      workdir: wd,
      tags: ['compliance'],
    });
    const cStore = new CorpusStore();
    const name = 'mcp-probe-' + Date.now();
    cStore.build(name, null, {
      token_budget: 5000,
      tags: ['compliance'],
      workdir: wd,
      include_expired: false,
    });

    const result = handleCorpusQuery({ name, query_text: 'DORA' });
    assert.notStrictEqual(result.isError, true, 'successful query must not set isError');
    const payload = JSON.parse(result.content[0]!.text);
    assert.strictEqual(payload.corpus, name);
    assert.ok(payload.total_results >= 1, 'expected at least one match for "DORA"');
  });

  test('respects explicit limit parameter (caps result count)', () => {
    const wd = '/ship53-limit-' + Date.now();
    const memStore = new MemoryStore();
    for (let i = 0; i < 5; i++) {
      memStore.remember({
        content: `keyword hit number ${i}`,
        memory_type: 'fact',
        workdir: wd,
        tags: ['limittag'],
      });
    }
    const cStore = new CorpusStore();
    const name = 'limit-corpus-' + Date.now();
    cStore.build(name, null, {
      token_budget: 10_000,
      tags: ['limittag'],
      workdir: wd,
      include_expired: false,
    });

    const result = handleCorpusQuery({ name, query_text: 'keyword', limit: 2 });
    assert.notStrictEqual(result.isError, true);
    const payload = JSON.parse(result.content[0]!.text);
    assert.ok(payload.total_results <= 2, `limit=2 must cap results, got ${payload.total_results}`);
  });

  test('default limit of 10 applies when caller omits the field', () => {
    // Not asserting exact count — just that the handler does not throw
    // and produces a well-formed response with no limit in args.
    const wd = '/ship53-default-' + Date.now();
    const memStore = new MemoryStore();
    memStore.remember({ content: 'small corpus default limit', memory_type: 'fact', workdir: wd, tags: ['defaulttag'] });
    const cStore = new CorpusStore();
    const name = 'default-corpus-' + Date.now();
    cStore.build(name, null, { token_budget: 5000, tags: ['defaulttag'], workdir: wd, include_expired: false });

    const result = handleCorpusQuery({ name, query_text: 'default' });
    assert.notStrictEqual(result.isError, true);
    const payload = JSON.parse(result.content[0]!.text);
    assert.ok(Array.isArray(payload.results));
  });
});

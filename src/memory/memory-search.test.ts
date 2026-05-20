process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { handleMemorySearch } from '../tools/memory_search.js';
import { MemoryStore } from './memory-store.js';

type SearchResponse = Awaited<ReturnType<typeof handleMemorySearch>>;

function parseResult(result: SearchResponse): {
  results: Array<{ memory_id: string; memory_type: string; tags: string[]; score: number; token_count: number; recall_count: number; trust_level: string; created_at: number; excerpt: string }>;
  total_results: number;
  omitted_count: number;
} {
  return JSON.parse(result.content[0]!.text);
}

describe('SHIP-54: memory_search progressive disclosure', () => {
  test('returns compact index with excerpt, not full content', async () => {
    const store = new MemoryStore();
    const workdir = '/ship54-' + Date.now();
    const longContent = 'a'.repeat(500);
    store.remember({ content: longContent, memory_type: 'lesson', workdir, tags: ['tag1'] });

    const parsed = parseResult(await handleMemorySearch({
      token_budget: 2000,
      tags: ['tag1'],
      workdir,
      include_expired: false,
    }));

    assert.strictEqual(parsed.results.length, 1);
    const entry = parsed.results[0]!;
    assert.ok(entry.memory_id);
    assert.strictEqual(entry.memory_type, 'lesson');
    assert.ok(entry.excerpt.length <= 101, `excerpt should be <= 100 chars + ellipsis, got ${entry.excerpt.length}`);
    assert.ok(entry.excerpt.endsWith('…'), 'excerpt longer than 100 chars must end with ellipsis');
    // Compact form: no `content` field
    assert.ok(!('content' in entry), 'memory_search must NOT expose full content');
  });

  test('does NOT increment recall_count (excerpt is not content disclosure)', async () => {
    const store = new MemoryStore();
    const workdir = '/ship54-recall-' + Date.now();
    const id = store.remember({ content: 'test lesson content', memory_type: 'lesson', workdir, tags: ['probe'] });

    await handleMemorySearch({ token_budget: 2000, tags: ['probe'], workdir, include_expired: false });

    const mem = store.getMemory(id);
    assert.ok(mem);
    // store.getMemory() is read-only — does NOT touch. So memory_search should leave
    // recall_count at 0 (only full-content disclosure via MCP `get_memory` or `recall` touches).
    assert.strictEqual(mem.recall_count, 0, 'memory_search must NOT increment recall_count — only full disclosure does');
  });

  test('excerpt of short content has no ellipsis', async () => {
    const store = new MemoryStore();
    const workdir = '/ship54-short-' + Date.now();
    store.remember({ content: 'short', memory_type: 'fact', workdir, tags: ['shorttag'] });

    const parsed = parseResult(await handleMemorySearch({ token_budget: 2000, tags: ['shorttag'], workdir, include_expired: false }));
    assert.strictEqual(parsed.results.length, 1);
    assert.strictEqual(parsed.results[0]!.excerpt, 'short');
  });

  test('surfaces trust_level in the compact index', async () => {
    const store = new MemoryStore();
    const workdir = '/ship54-trust-' + Date.now();
    store.remember({ content: 'pinned human decision', memory_type: 'decision', workdir, memory_source: 'human', pinned: true, tags: ['trusttag'] });

    const parsed = parseResult(await handleMemorySearch({ token_budget: 2000, tags: ['trusttag'], workdir, include_expired: false }));
    assert.strictEqual(parsed.results.length, 1);
    assert.strictEqual(parsed.results[0]!.trust_level, 'trusted');
  });
});

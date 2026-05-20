/**
 * PLAN-4 T7 — Integration test: end-to-end semantic recall via live LM Studio.
 *
 * Validates EMBED-05 acceptance criterion:
 *   "5 CSS-naming memories written; query 'naming conventions for stylesheets'
 *    surfaces 'prefer kebab-case' in the top results despite ZERO word overlap."
 *
 * Gated by RELAY_INTEGRATION_LM_STUDIO=1 — skipped in CI by default. To run:
 *   lms load text-embedding-nomic-embed-text-v1.5 -y && \
 *   RELAY_INTEGRATION_LM_STUDIO=1 \
 *   RELAY_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5 \
 *   LMSTUDIO_ENDPOINT=http://127.0.0.1:1234 \
 *   node --test dist/memory/embeddings-wire-up.integration.test.js
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';
import { closeDb } from '../runtime/store/db.js';
import { probeEmbeddingsModel } from './embedding-client.js';

const INTEGRATION_ENABLED = process.env['RELAY_INTEGRATION_LM_STUDIO'] === '1';
const NOMIC = 'text-embedding-nomic-embed-text-v1.5';

/** Spin until the queueMicrotask-scheduled embed UPDATE lands. */
async function waitForEmbeddings(
  store: MemoryStore,
  ids: readonly string[],
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = store.getRawEmbeddings(ids);
    let allReady = true;
    for (const id of ids) {
      const entry = raw.get(id);
      if (!entry || entry.blob.byteLength !== 3072 || entry.model !== NOMIC) {
        allReady = false;
        break;
      }
    }
    if (allReady) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Embeddings did not complete within ${timeoutMs}ms (got ${
      store.getRawEmbeddings(ids).size
    }/${ids.length})`
  );
}

describe('PLAN-4 T7 — EMBED-05 CSS naming integration', { skip: !INTEGRATION_ENABLED }, () => {
  test(
    'kebab-case memory recalled despite zero word overlap (semantic-driven recall)',
    { timeout: 120_000 },
    async () => {
      // Pre-flight: confirm LM Studio is reachable and the nomic model is loaded.
      // If not, fail loudly with the runbook (rather than silently passing).
      const probe = await probeEmbeddingsModel({
        endpoint: process.env['LMSTUDIO_ENDPOINT'] ?? 'http://127.0.0.1:1234',
        model: NOMIC,
      });
      assert.ok(
        probe.ok,
        `LM Studio probe failed (${probe.reason ?? 'unknown'}). ` +
          `Load the model first:  lms load ${NOMIC} -y`
      );

      // Set env so the lazy embed-on-write path picks up the right model + endpoint.
      process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
      process.env['LMSTUDIO_ENDPOINT'] = process.env['LMSTUDIO_ENDPOINT'] ?? 'http://127.0.0.1:1234';

      const workdir = '/t7-css-' + Date.now();
      const store = new MemoryStore();

      // Five CSS-naming memories. Memory #1 is the target — uses "kebab-case",
      // "CSS classes", "nav-link" — ZERO word overlap with the query
      // "naming conventions for stylesheets" ({naming, conventions, stylesheets}
      // n {prefer, kebab, case, css, classes, e, g, nav, link, not, navlink} = O).
      const contents = [
        'Prefer kebab-case for CSS classes (e.g. .nav-link not .navLink)',
        'Use BEM block__element--modifier when components nest',
        'Avoid camelCase identifiers in stylesheet selectors',
        'ID selectors should be reserved for JS hooks, not styling',
        'Tailwind utility classes follow their own convention - leave them as-is',
      ];

      const ids: string[] = [];
      for (const content of contents) {
        ids.push(
          store.remember({
            content,
            memory_type: 'lesson',
            workdir,
            tags: ['css', 'naming'],
          })
        );
      }

      // Wait for the queueMicrotask-scheduled embed UPDATE to complete for ALL
      // 5 rows. Each embed is ~250ms over a warm nomic model.
      await waitForEmbeddings(store, ids);

      // Sanity: all 5 rows have nomic embeddings of correct size.
      const raw = store.getRawEmbeddings(ids);
      assert.strictEqual(raw.size, 5, 'all 5 memories must have embeddings');
      for (const [, { blob, model }] of raw) {
        assert.strictEqual(blob.byteLength, 3072, 'each blob must be 3072 bytes');
        assert.strictEqual(model, NOMIC, 'each row must record the nomic model');
      }

      // Recall via the wired-up handleRecall (T6) — must surface kebab-case
      // memory in the top 3 despite zero word overlap with the query.
      const { handleRecall } = await import('../tools/recall.js');
      const response = await handleRecall({
        query: 'naming conventions for stylesheets',
        tags: [],
        token_budget: 4000,
        workdir,
        include_expired: false,
      });
      const parsed = JSON.parse(response.content[0]!.text) as {
        memories: Array<{ memory_id: string; content: string; score: number }>;
        total_tokens: number;
      };

      assert.ok(parsed.memories.length > 0, 'recall must return memories');

      const kebabId = ids[0]!;
      const kebabRank = parsed.memories.findIndex((m) => m.memory_id === kebabId);
      assert.ok(
        kebabRank >= 0,
        `kebab-case memory must appear in recall results (got ${parsed.memories
          .map((m) => m.content.slice(0, 40))
          .join('; ')})`
      );
      assert.ok(
        kebabRank < 3,
        `kebab-case memory must rank in top 3 (got rank ${kebabRank + 1}, contents: ${parsed.memories
          .map((m, i) => `#${i + 1} ${m.content.slice(0, 40)}`)
          .join('; ')})`
      );

      const kebabScore = parsed.memories[kebabRank]!.score;
      // Score must exceed a level that word-overlap alone cannot reach for a
      // zero-overlap query. Word-overlap gives content=0, so the only way the
      // total exceeds ~0.3 is via the semantic content bonus (content x 0.15
      // where cosine for related text is typically 0.5-0.8 -> 0.075-0.12 alone,
      // plus tag overlap and recency push above 0.3).
      assert.ok(
        kebabScore > 0.3,
        `kebab-case score (${kebabScore}) must exceed word-overlap floor (semantic ranking)`
      );

      closeDb();
    }
  );
});

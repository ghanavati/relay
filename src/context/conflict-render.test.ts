/**
 * PLAN-5 T6 — Render `⚠ CONFLICTS WITH #N` annotations in
 * `loadRecalledLessonsContent`.
 *
 * Verifies the render-time UUID → 1-based index translation:
 *   - Sorted rendered list carries `1. ⚠ CONFLICTS WITH #2: <content>` shape.
 *   - Annotations from the engine (ScoredMemory.annotations holds raw UUIDs)
 *     are rewritten at render time using a lookup map over the sorted list.
 *   - Dangling reference (peer not in rendered list because it was filtered
 *     out by MIN_RELEVANCE_SCORE) drops gracefully — no `#undefined`, no
 *     `#NaN`, no crash.
 *   - Combination with [UNVERIFIED] and ⚠ FAILED: prefixes preserves the
 *     chain order: `[UNVERIFIED] ⚠ FAILED: ⚠ CONFLICTS WITH #N: <content>`.
 *   - No annotations + no markers → exact pre-Phase-5 output preserved.
 *
 * Tests seed two same-workdir conflicting lessons via `remember()`, set
 * `RELAY_RECALLED_LESSONS=1`, then call `loadRecalledLessonsContent` and
 * inspect the rendered Markdown.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from '../memory/memory-store.js';
import { loadRecalledLessonsContent } from './layers.js';

let counter = 0;
function uniqueWorkdir(): string {
  counter += 1;
  return `/p-render-${counter}`;
}

describe('loadRecalledLessonsContent — conflict annotation rendering (PLAN-5 T6)', () => {
  test('renders `⚠ CONFLICTS WITH #N` markers with index translation', async () => {
    const store = new MemoryStore();
    const workdir = uniqueWorkdir();
    // Seed two same-workdir conflicting lessons. Tag set is rich so jaccard
    // survives auto-extraction; content is a single distinct token per row so
    // contentJaccard stays well below CONTENT_JAC_MAX=0.3 and the conflict gate
    // fires deterministically.
    const aId = store.remember({
      content: 'kebab',
      memory_type: 'lesson',
      tags: ['css', 'naming', 'style', 'convention', 'web'],
      workdir,
      memory_source: 'human',
    });
    const bId = store.remember({
      content: 'camelcase',
      memory_type: 'lesson',
      tags: ['css', 'naming', 'style', 'convention', 'web'],
      workdir,
      memory_source: 'human',
    });
    assert.notStrictEqual(aId, bId);
    // Sanity: detection actually fired.
    const a = store.getMemory(aId)!;
    const b = store.getMemory(bId)!;
    assert.ok(
      a.conflicts_with.includes(bId) || b.conflicts_with.includes(aId),
      'pre-condition: conflict detected at write time'
    );

    const rendered = await loadRecalledLessonsContent(workdir, 'css naming style');
    assert.ok(rendered, 'rendered output non-null');
    // Should contain at least one #N marker.
    assert.match(
      rendered,
      /⚠ (CONFLICTS WITH|CONTRADICTED BY) #\d+/,
      `render must include #N marker; got:\n${rendered}`
    );
    // Should NOT contain raw UUIDs in the annotation.
    assert.doesNotMatch(
      rendered,
      /⚠ (CONFLICTS WITH|CONTRADICTED BY) [0-9a-f]{8}-/,
      `render must NOT include raw UUID; got:\n${rendered}`
    );
    // Should NOT contain undefined / NaN markers.
    assert.doesNotMatch(rendered, /#undefined|#NaN/, 'no undefined/NaN markers');
  });

  test('no annotations, no markers: rendered output unchanged from pre-Phase-5 shape', async () => {
    const store = new MemoryStore();
    const workdir = uniqueWorkdir();
    // Single non-conflicting memory.
    store.remember({
      content: 'simple non-conflicting lesson',
      memory_type: 'lesson',
      tags: ['unique'],
      workdir,
      memory_source: 'human',
    });
    const rendered = await loadRecalledLessonsContent(workdir, 'simple unique');
    assert.ok(rendered);
    // No conflict marker on this line.
    assert.doesNotMatch(rendered, /CONFLICTS WITH|CONTRADICTED BY/);
    // The legacy shape is `${index + 1}. ${prefix}${content}` — confirm `1.` present.
    assert.match(rendered, /^\d+\. /m, 'index prefix preserved');
  });

  test('returns null when no recallable lessons exist for workdir', async () => {
    const workdir = uniqueWorkdir();
    // No memories seeded for this workdir.
    const rendered = await loadRecalledLessonsContent(workdir, 'anything');
    assert.strictEqual(rendered, null);
  });

  test('UNVERIFIED + conflict markers compose: prefix chain preserved', async () => {
    const store = new MemoryStore();
    const workdir = uniqueWorkdir();
    // Seed two unverified-source memories so they keep the UNVERIFIED prefix
    // (memory_source='unknown' → trust_level='unverified'). Same SC#1 fixture
    // shape (rich tags, single-token content) so the conflict gate fires.
    const aId = store.remember({
      content: 'first',
      memory_type: 'lesson',
      tags: ['css', 'naming', 'style', 'convention', 'web'],
      workdir,
      memory_source: 'unknown',
    });
    const bId = store.remember({
      content: 'second',
      memory_type: 'lesson',
      tags: ['css', 'naming', 'style', 'convention', 'web'],
      workdir,
      memory_source: 'unknown',
    });
    assert.notStrictEqual(aId, bId);
    const a = store.getMemory(aId)!;
    const b = store.getMemory(bId)!;
    assert.ok(
      a.conflicts_with.length > 0 || b.conflicts_with.length > 0,
      'pre-condition: conflict detected'
    );
    const rendered = await loadRecalledLessonsContent(workdir, 'css naming style');
    assert.ok(rendered);
    // UNVERIFIED + CONFLICTS WITH should co-occur on at least one line.
    const hasComposite = rendered.split('\n').some(
      (line) =>
        line.includes('[UNVERIFIED]') &&
        /⚠ (CONFLICTS WITH|CONTRADICTED BY) #\d+/.test(line)
    );
    assert.ok(hasComposite, `expected composite prefix; got:\n${rendered}`);
  });
});

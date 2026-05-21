/**
 * PLAN-5 T4 — Recall-time pairwise conflict resolution in `budgetedRecall`.
 *
 * Exercises the second-pass `resolveConflicts` integration:
 *   - default policy 'annotate' (ANNOTATE_BOTH): both kept with markers
 *   - 'drop-lower-trust': loser dropped; omitted_count increments
 *   - Pinned never dropped even under drop policy
 *   - K cap = 32 (conflicts beyond top-32 sort positions pass through un-annotated)
 *   - Empty conflicts_with → bit-identical pre-Phase-5 behavior
 *   - Reference to absent ID is silently dropped (no throw, no annotation)
 *   - memory-engine.ts purity preserved (grep guard runs in T7)
 */

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { budgetedRecall } from './memory-engine.js';
import type { Memory, RecallQuery } from './types.js';
import { RECALL_K_CAP } from './conflict-thresholds.js';

const NOW = Date.parse('2026-05-21T00:00:00Z');

function mkMemory(overrides: Partial<Memory> & { memory_id: string }): Memory {
  return {
    memory_id: overrides.memory_id,
    memory_type: overrides.memory_type ?? 'lesson',
    content: overrides.content ?? `content for ${overrides.memory_id}`,
    tags: overrides.tags ?? ['css', 'naming'],
    workdir: overrides.workdir ?? '/p',
    token_count: overrides.token_count ?? 10,
    pinned: overrides.pinned ?? false,
    source_run_id: overrides.source_run_id ?? null,
    git_ref: overrides.git_ref ?? null,
    created_at: overrides.created_at ?? NOW - 1000,
    accessed_at: overrides.accessed_at ?? NOW,
    expires_at: overrides.expires_at ?? null,
    entity_key: overrides.entity_key ?? null,
    sources: overrides.sources ?? [],
    recall_count: overrides.recall_count ?? 0,
    memory_source: overrides.memory_source ?? 'unknown',
    success_recall_count: overrides.success_recall_count ?? 0,
    files: overrides.files ?? [],
    trust_level: overrides.trust_level ?? 'unverified',
    conflicts_with: overrides.conflicts_with ?? [],
  };
}

describe('budgetedRecall — conflict annotation (PLAN-5 T4)', () => {
  test('default policy "annotate": both rows kept with markers (ANNOTATE_BOTH)', () => {
    const memories: Memory[] = [
      mkMemory({
        memory_id: 'A', trust_level: 'trusted',
        content: 'use kebab-case for css', tags: ['css', 'naming'],
        conflicts_with: ['B'],
      }),
      mkMemory({
        memory_id: 'B', trust_level: 'unverified',
        content: 'use camelCase for css', tags: ['css', 'naming'],
        conflicts_with: ['A'],
      }),
      mkMemory({
        memory_id: 'C', tags: ['unrelated'], content: 'unrelated content',
      }),
    ];
    const query: RecallQuery = { query: 'css naming', token_budget: 10_000 };
    const result = budgetedRecall(memories, query, NOW);

    const a = result.memories.find((m) => m.memory_id === 'A');
    const b = result.memories.find((m) => m.memory_id === 'B');
    assert.ok(a && b, 'both rows kept under annotate policy');

    // A is trusted → wins precedence → gets "CONFLICTS WITH B"; B gets "CONTRADICTED BY A".
    assert.ok(
      a.annotations?.some((s) => s.includes('CONFLICTS WITH') && s.includes('B')),
      `A annotation expected; got ${JSON.stringify(a.annotations)}`
    );
    assert.ok(
      b.annotations?.some((s) => s.includes('CONTRADICTED BY') && s.includes('A')),
      `B annotation expected; got ${JSON.stringify(b.annotations)}`
    );
  });

  test('"drop-lower-trust": loser dropped, omitted_count incremented', () => {
    const memories: Memory[] = [
      mkMemory({
        memory_id: 'A', trust_level: 'trusted',
        content: 'use kebab-case for css', tags: ['css', 'naming'],
        conflicts_with: ['B'],
      }),
      mkMemory({
        memory_id: 'B', trust_level: 'unverified',
        content: 'use camelCase for css', tags: ['css', 'naming'],
        conflicts_with: ['A'],
      }),
    ];
    const query: RecallQuery = {
      query: 'css naming', token_budget: 10_000, conflictPolicy: 'drop-lower-trust',
    };
    const result = budgetedRecall(memories, query, NOW);
    assert.strictEqual(result.memories.length, 1, 'only A survives');
    assert.strictEqual(result.memories[0]!.memory_id, 'A');
    assert.ok(result.omitted_count >= 1, 'omitted_count reflects the dropped peer');
  });

  test('pinned never dropped (CONFLICT-03, DELTA §10 Q2): B pinned survives drop policy with annotation', () => {
    const memories: Memory[] = [
      mkMemory({
        memory_id: 'A', trust_level: 'trusted',
        content: 'use kebab-case for css', tags: ['css', 'naming'],
        conflicts_with: ['B'],
      }),
      mkMemory({
        memory_id: 'B', trust_level: 'unverified', pinned: true,
        content: 'use camelCase for css', tags: ['css', 'naming'],
        conflicts_with: ['A'],
      }),
    ];
    const query: RecallQuery = {
      query: 'css naming', token_budget: 10_000, conflictPolicy: 'drop-lower-trust',
    };
    const result = budgetedRecall(memories, query, NOW);
    const b = result.memories.find((m) => m.memory_id === 'B');
    assert.ok(b, 'pinned B survives drop policy');
    assert.ok(
      b.annotations?.some((s) => s.includes('CONTRADICTED BY')),
      'pinned-but-loser carries annotation'
    );
  });

  test('K cap = RECALL_K_CAP: conflicts beyond rank K pass through un-annotated', () => {
    const memories: Memory[] = [];
    // Fill top-K with high-score, no-conflict rows.
    for (let i = 0; i < RECALL_K_CAP; i++) {
      memories.push(
        mkMemory({
          memory_id: `top-${i}`,
          // Force high score via "css naming" content match + pinned
          content: 'css naming top result',
          tags: ['css', 'naming'],
          pinned: true,
        })
      );
    }
    // Two mutually-conflicting rows at the BOTTOM of the sort — much lower
    // score (stale + unrelated tags so they fall below the top-K window).
    const stale = NOW - 365 * 24 * 60 * 60 * 1000;
    memories.push(
      mkMemory({
        memory_id: 'XLOW',
        content: 'unrelated stale row x', tags: ['unrelated'],
        accessed_at: stale, memory_type: 'state',
        conflicts_with: ['YLOW'],
      })
    );
    memories.push(
      mkMemory({
        memory_id: 'YLOW',
        content: 'unrelated stale row y', tags: ['unrelated'],
        accessed_at: stale, memory_type: 'state',
        conflicts_with: ['XLOW'],
      })
    );
    const query: RecallQuery = { query: 'css naming', token_budget: 100_000 };
    const result = budgetedRecall(memories, query, NOW);

    // Sort by score desc — top-K by definition wins; XLOW + YLOW fall below.
    // After resolveConflicts, neither receives annotation because they're
    // outside the cap.
    const x = result.memories.find((m) => m.memory_id === 'XLOW');
    const y = result.memories.find((m) => m.memory_id === 'YLOW');
    if (x) assert.strictEqual(x.annotations, undefined, 'XLOW outside cap → no annotation');
    if (y) assert.strictEqual(y.annotations, undefined, 'YLOW outside cap → no annotation');
  });

  test('empty conflicts_with: bit-identical pre-Phase-5 behavior', () => {
    const memories: Memory[] = [
      mkMemory({ memory_id: 'A', content: 'css naming useful', tags: ['css', 'naming'] }),
      mkMemory({ memory_id: 'B', content: 'css naming notes', tags: ['css', 'naming'] }),
    ];
    const query: RecallQuery = { query: 'css naming', token_budget: 10_000 };
    const result = budgetedRecall(memories, query, NOW);
    // No annotations attached anywhere when conflicts_with is empty.
    for (const m of result.memories) {
      assert.strictEqual(
        m.annotations, undefined,
        `memory ${m.memory_id} should have no annotations`
      );
    }
  });

  test('reference to absent ID: silently dropped, no throw, no annotation', () => {
    const memories: Memory[] = [
      mkMemory({
        memory_id: 'A',
        content: 'use css naming convention',
        tags: ['css', 'naming'],
        conflicts_with: ['ghost-uuid-does-not-exist'],
      }),
    ];
    const query: RecallQuery = { query: 'css naming', token_budget: 10_000 };
    const result = budgetedRecall(memories, query, NOW);
    const a = result.memories.find((m) => m.memory_id === 'A');
    assert.ok(a);
    // Mutual-only edge: ghost not in candidate set so no annotation produced.
    assert.strictEqual(a.annotations, undefined);
  });

  test('one-sided reference does NOT produce annotation (mutual-only edge requirement)', () => {
    const memories: Memory[] = [
      mkMemory({
        memory_id: 'A', conflicts_with: ['B'],
        content: 'css naming kebab', tags: ['css', 'naming'],
      }),
      mkMemory({
        memory_id: 'B', conflicts_with: [], // B does NOT point back to A
        content: 'css naming camel', tags: ['css', 'naming'],
      }),
    ];
    const query: RecallQuery = { query: 'css naming', token_budget: 10_000 };
    const result = budgetedRecall(memories, query, NOW);
    for (const m of result.memories) {
      assert.strictEqual(m.annotations, undefined, 'no annotation without mutual edge');
    }
  });
});

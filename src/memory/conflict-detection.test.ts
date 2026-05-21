/**
 * PLAN-5 T2 — Pure conflict-detection helpers.
 *
 * Exercises pure functions in `conflict-detection.ts`:
 *   - tagJaccard / contentJaccard (set-Jaccard)
 *   - isConflictCandidate (Jaccard-only + cosine-gated)
 *   - resolveConflicts (annotate / drop-lower-trust / drop-all-conflicts;
 *     pinned protection; precedence trust → score → recency; K cap)
 *
 * Module must have NO DB / HTTP / fs imports — engine purity invariant
 * (PITFALL 2.1, CC.4). Verified by a grep guard in T7.
 */

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  tagJaccard,
  contentJaccard,
  isConflictCandidate,
  resolveConflicts,
  type ConflictPolicy,
} from './conflict-detection.js';
import { RECALL_K_CAP } from './conflict-thresholds.js';
import type { ScoredMemory } from './types.js';

// ── tagJaccard / contentJaccard ───────────────────────────────────────────

describe('tagJaccard / contentJaccard (PLAN-5 T2)', () => {
  test('tagJaccard {a,b} ∩ {a,c} → 1/3', () => {
    assert.strictEqual(tagJaccard(new Set(['a', 'b']), new Set(['a', 'c'])), 1 / 3);
  });

  test('tagJaccard empty ∩ empty → 0 (no NaN)', () => {
    assert.strictEqual(tagJaccard(new Set(), new Set()), 0);
  });

  test('tagJaccard disjoint → 0', () => {
    assert.strictEqual(tagJaccard(new Set(['a', 'b']), new Set(['c', 'd'])), 0);
  });

  test('tagJaccard identical → 1', () => {
    assert.strictEqual(tagJaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  });

  test('contentJaccard has identical algebra over pre-tokenized sets', () => {
    assert.strictEqual(
      contentJaccard(new Set(['use', 'kebab', 'css']), new Set(['use', 'camel', 'css'])),
      2 / 4
    );
  });
});

// ── isConflictCandidate — Jaccard-only mode ───────────────────────────────

describe('isConflictCandidate — Jaccard-only (cosine undefined)', () => {
  test('CONFLICT-02 baseline: tag=0.6, content=0.2, shared=2 → true', () => {
    assert.strictEqual(
      isConflictCandidate({ tagJac: 0.6, contentJac: 0.2, sharedTagCount: 2 }),
      true
    );
  });

  test('content too similar (paraphrase-class via Jaccard alone): tag=0.6, content=0.5 → false', () => {
    assert.strictEqual(
      isConflictCandidate({ tagJac: 0.6, contentJac: 0.5, sharedTagCount: 2 }),
      false
    );
  });

  test('tag below TAG_JAC_MIN: tag=0.4 → false', () => {
    assert.strictEqual(
      isConflictCandidate({ tagJac: 0.4, contentJac: 0.2, sharedTagCount: 2 }),
      false
    );
  });

  test('shared-tag floor (DELTA-MEM-CONFLICT.md §8 #1): tag=0.8, content=0.1, shared=1 → false', () => {
    assert.strictEqual(
      isConflictCandidate({ tagJac: 0.8, contentJac: 0.1, sharedTagCount: 1 }),
      false
    );
  });
});

// ── isConflictCandidate — cosine-gated ───────────────────────────────────

describe('isConflictCandidate — cosine-gated (CONFLICT-04)', () => {
  test('cosine below 0.7 (genuine conflict): tag=0.6, content=0.2, shared=2, cosine=0.6 → true', () => {
    assert.strictEqual(
      isConflictCandidate({ tagJac: 0.6, contentJac: 0.2, sharedTagCount: 2, cosine: 0.6 }),
      true
    );
  });

  test('cosine above 0.7 (paraphrase): tag=0.6, content=0.2, shared=2, cosine=0.75 → false', () => {
    assert.strictEqual(
      isConflictCandidate({ tagJac: 0.6, contentJac: 0.2, sharedTagCount: 2, cosine: 0.75 }),
      false
    );
  });

  test('cosine = 0.7 (boundary): strict less-than gate → false', () => {
    assert.strictEqual(
      isConflictCandidate({ tagJac: 0.6, contentJac: 0.2, sharedTagCount: 2, cosine: 0.7 }),
      false
    );
  });

  test('cosine undefined when Jaccard would flag → degrade to Jaccard-only → true', () => {
    assert.strictEqual(
      isConflictCandidate({ tagJac: 0.6, contentJac: 0.2, sharedTagCount: 2, cosine: undefined }),
      true
    );
  });
});

// ── resolveConflicts — fixtures ───────────────────────────────────────────

function mkScored(overrides: Partial<ScoredMemory> & { memory_id: string; score: number }): ScoredMemory {
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
    created_at: overrides.created_at ?? 1_000_000,
    accessed_at: overrides.accessed_at ?? 1_000_000,
    expires_at: overrides.expires_at ?? null,
    entity_key: overrides.entity_key ?? null,
    sources: overrides.sources ?? [],
    recall_count: overrides.recall_count ?? 0,
    memory_source: overrides.memory_source ?? 'unknown',
    success_recall_count: overrides.success_recall_count ?? 0,
    files: overrides.files ?? [],
    trust_level: overrides.trust_level ?? 'unverified',
    conflicts_with: overrides.conflicts_with ?? [],
    score: overrides.score,
  };
}

describe('resolveConflicts — policy="annotate"', () => {
  test('A (trusted, 0.9) ↔ B (unverified, 0.8) both kept, mutual annotations', () => {
    const a = mkScored({ memory_id: 'A', score: 0.9, trust_level: 'trusted', conflicts_with: ['B'] });
    const b = mkScored({ memory_id: 'B', score: 0.8, trust_level: 'unverified', conflicts_with: ['A'] });

    const result = resolveConflicts([a, b], 'annotate');

    assert.strictEqual(result.kept.length, 2, 'both rows kept');
    const ka = result.kept.find((m) => m.memory_id === 'A');
    const kb = result.kept.find((m) => m.memory_id === 'B');
    assert.ok(ka && kb);
    // A is the winner — uses CONFLICTS WITH; B is the loser — uses CONTRADICTED BY.
    assert.deepEqual(ka.annotations, ['⚠ CONFLICTS WITH B']);
    assert.deepEqual(kb.annotations, ['⚠ CONTRADICTED BY A']);
  });

  test('precedence: trust > score > recency (CONFLICT-03 / DELTA-MEM-CONFLICT.md §6)', () => {
    // A (provisional, score 0.7) vs B (trusted, score 0.5). Trust wins — B keeps "CONFLICTS WITH A".
    const a = mkScored({ memory_id: 'A', score: 0.7, trust_level: 'provisional', conflicts_with: ['B'] });
    const b = mkScored({ memory_id: 'B', score: 0.5, trust_level: 'trusted', conflicts_with: ['A'] });
    const result = resolveConflicts([a, b], 'annotate');
    const ka = result.kept.find((m) => m.memory_id === 'A');
    const kb = result.kept.find((m) => m.memory_id === 'B');
    assert.deepEqual(kb!.annotations, ['⚠ CONFLICTS WITH A']);
    assert.deepEqual(ka!.annotations, ['⚠ CONTRADICTED BY B']);
  });

  test('precedence tiebreak: equal trust, score wins', () => {
    const a = mkScored({ memory_id: 'A', score: 0.9, trust_level: 'unverified', conflicts_with: ['B'] });
    const b = mkScored({ memory_id: 'B', score: 0.8, trust_level: 'unverified', conflicts_with: ['A'] });
    const result = resolveConflicts([a, b], 'annotate');
    const ka = result.kept.find((m) => m.memory_id === 'A');
    assert.deepEqual(ka!.annotations, ['⚠ CONFLICTS WITH B']);
  });

  test('precedence tiebreak: equal trust + score, recency wins', () => {
    const a = mkScored({
      memory_id: 'A', score: 0.5, trust_level: 'unverified',
      accessed_at: 2_000_000, conflicts_with: ['B'],
    });
    const b = mkScored({
      memory_id: 'B', score: 0.5, trust_level: 'unverified',
      accessed_at: 1_000_000, conflicts_with: ['A'],
    });
    const result = resolveConflicts([a, b], 'annotate');
    const ka = result.kept.find((m) => m.memory_id === 'A');
    assert.deepEqual(ka!.annotations, ['⚠ CONFLICTS WITH B']);
  });
});

describe('resolveConflicts — policy="drop-lower-trust"', () => {
  test('A (trusted) ↔ B (unverified) → A kept (no annotation), B dropped', () => {
    const a = mkScored({ memory_id: 'A', score: 0.9, trust_level: 'trusted', conflicts_with: ['B'] });
    const b = mkScored({ memory_id: 'B', score: 0.8, trust_level: 'unverified', conflicts_with: ['A'] });
    const result = resolveConflicts([a, b], 'drop-lower-trust');

    assert.strictEqual(result.kept.length, 1, 'B dropped');
    const ka = result.kept[0]!;
    assert.strictEqual(ka.memory_id, 'A');
    assert.strictEqual(ka.annotations, undefined, 'winner gets no annotation under drop policy');
  });

  test('pinned exception: B pinned survives drop policy with annotation (DELTA-MEM-CONFLICT.md §10 Q2)', () => {
    const a = mkScored({ memory_id: 'A', score: 0.9, trust_level: 'trusted', conflicts_with: ['B'] });
    const b = mkScored({
      memory_id: 'B', score: 0.8, trust_level: 'unverified',
      pinned: true, conflicts_with: ['A'],
    });
    const result = resolveConflicts([a, b], 'drop-lower-trust');

    assert.strictEqual(result.kept.length, 2, 'pinned never dropped');
    const kb = result.kept.find((m) => m.memory_id === 'B');
    assert.ok(kb, 'pinned B still present');
    assert.deepEqual(kb.annotations, ['⚠ CONTRADICTED BY A']);
  });
});

describe('resolveConflicts — empty / no-conflict fast paths', () => {
  test('all conflicts_with empty → kept identical, no annotations', () => {
    const memos = [
      mkScored({ memory_id: 'A', score: 0.9, conflicts_with: [] }),
      mkScored({ memory_id: 'B', score: 0.8, conflicts_with: [] }),
    ];
    const result = resolveConflicts(memos, 'annotate');
    assert.strictEqual(result.kept.length, 2);
    for (const m of result.kept) {
      assert.strictEqual(m.annotations, undefined);
    }
  });

  test('conflicts_with reference an absent ID → no throw, no annotation', () => {
    const a = mkScored({ memory_id: 'A', score: 0.9, conflicts_with: ['ghost'] });
    const result = resolveConflicts([a], 'annotate');
    assert.strictEqual(result.kept.length, 1);
    assert.strictEqual(result.kept[0]!.annotations, undefined);
  });
});

describe('resolveConflicts — K cap (CONFLICT-03 / ROADMAP SC#5)', () => {
  test('input length > RECALL_K_CAP only first K participate; remainder passes through', () => {
    const memos: ScoredMemory[] = [];
    // First RECALL_K_CAP rows: no conflicts.
    for (let i = 0; i < RECALL_K_CAP; i++) {
      memos.push(mkScored({ memory_id: `top-${i}`, score: 1 - i * 0.01 }));
    }
    // Two extra rows with mutual conflicts, BUT they fall outside the cap.
    memos.push(mkScored({ memory_id: 'X', score: 0.001, conflicts_with: ['Y'] }));
    memos.push(mkScored({ memory_id: 'Y', score: 0.0009, conflicts_with: ['X'] }));

    const result = resolveConflicts(memos, 'annotate');
    assert.strictEqual(result.kept.length, memos.length, 'all rows pass through');
    const x = result.kept.find((m) => m.memory_id === 'X');
    const y = result.kept.find((m) => m.memory_id === 'Y');
    assert.strictEqual(x!.annotations, undefined, 'X outside K cap → no annotation');
    assert.strictEqual(y!.annotations, undefined, 'Y outside K cap → no annotation');
  });

  test('K=32 worst case completes under 100ms (latency upper bound CI-stable)', () => {
    const memos: ScoredMemory[] = [];
    // Fill the entire top-K with mutually-conflicting pairs to force max comparisons.
    for (let i = 0; i < RECALL_K_CAP; i++) {
      const otherIds: string[] = [];
      for (let j = 0; j < RECALL_K_CAP; j++) if (j !== i) otherIds.push(`mem-${j}`);
      memos.push(mkScored({ memory_id: `mem-${i}`, score: 1 - i * 0.001, conflicts_with: otherIds }));
    }
    const t0 = Date.now();
    resolveConflicts(memos, 'annotate');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 100, `RECALL_K_CAP×RECALL_K_CAP pairwise pass took ${elapsed}ms (cap 100)`);
  });
});

describe('resolveConflicts — purity (no async, no side-effects)', () => {
  test('input ScoredMemory[] is not mutated', () => {
    const a = mkScored({ memory_id: 'A', score: 0.9, trust_level: 'trusted', conflicts_with: ['B'] });
    const b = mkScored({ memory_id: 'B', score: 0.8, trust_level: 'unverified', conflicts_with: ['A'] });
    const before = JSON.stringify([a, b]);
    resolveConflicts([a, b], 'annotate');
    const after = JSON.stringify([a, b]);
    assert.strictEqual(before, after, 'inputs frozen — no mutation');
  });

  test('resolveConflicts is a sync function (no Promise return)', () => {
    const a = mkScored({ memory_id: 'A', score: 0.9 });
    const result = resolveConflicts([a], 'annotate' as ConflictPolicy);
    // If `result` is a Promise, .then would be a function — fail.
    assert.strictEqual(typeof (result as unknown as { then?: unknown }).then, 'undefined');
  });
});

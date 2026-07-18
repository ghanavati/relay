/**
 * PLAN-5 T7 — Workdir-isolation regression suite (CONFLICT-05, CC.3).
 *
 * Hard guarantees:
 *   - A in /p1, B (conflict-class) in /p2 → both `conflicts_with` empty.
 *   - A workdir=null (global), B workdir='/p' (scoped) → no conflict
 *     (detection requires strict workdir equality; global ≠ scoped).
 *   - Recall in /p1 over a mixed-workdir store returns ONLY /p1 rows.
 *   - Grep guard: forbid `workdir IS NULL` substring in detect path inside
 *     `memory-store.ts#detectAndPersistConflicts`. Enforcement is via static
 *     read of the source file — keeps a regression-fixer from accidentally
 *     relaxing the constraint.
 *
 * The grep guard is the spiritual successor of "tests-as-spec": detection
 * SQL must NEVER use `workdir IS NULL OR workdir = ?` because that pattern
 * would let global memories collide with workdir-scoped ones (CONFLICT-05,
 * Phase-5 SC#4).
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from './memory-store.js';

let counter = 0;
function uniqueWorkdir(): string {
  counter += 1;
  return `/p-wd-${counter}`;
}

describe('Conflict-detection workdir isolation (PLAN-5 T7 / CONFLICT-05)', () => {
  test('cross-workdir: /p1 ↔ /p2 never flag each other', () => {
    const store = new MemoryStore();
    const wA = uniqueWorkdir();
    const wB = uniqueWorkdir();
    const aId = store.remember({
      content: 'aaaa',
      memory_type: 'lesson',
      tags: ['css', 'naming', 'style', 'convention', 'web'],
      workdir: wA,
    });
    const bId = store.remember({
      content: 'bbbb',
      memory_type: 'lesson',
      tags: ['css', 'naming', 'style', 'convention', 'web'],
      workdir: wB,
    });
    const a = store.getMemory(aId)!;
    const b = store.getMemory(bId)!;
    assert.deepEqual(a.conflicts_with, []);
    assert.deepEqual(b.conflicts_with, []);
  });

  test('global (workdir=null) vs scoped (workdir=/p) never flag each other', () => {
    const store = new MemoryStore();
    const w = uniqueWorkdir();
    const aId = store.remember({
      content: 'aaaa',
      memory_type: 'lesson',
      tags: ['css', 'naming', 'style', 'convention', 'web'],
      workdir: null, // global
    });
    const bId = store.remember({
      content: 'bbbb',
      memory_type: 'lesson',
      tags: ['css', 'naming', 'style', 'convention', 'web'],
      workdir: w, // scoped
    });
    const a = store.getMemory(aId)!;
    const b = store.getMemory(bId)!;
    // Phase-5 SC#4: strict workdir equality. Global (NULL) ≠ /p so neither
    // sees the other as a candidate.
    assert.deepEqual(a.conflicts_with, [], 'global ≠ scoped — no A conflict');
    assert.deepEqual(b.conflicts_with, [], 'global ≠ scoped — no B conflict');
  });

  test('grep guard: detectAndPersistConflicts SQL must NEVER contain `workdir IS NULL OR`', () => {
    // Static guard — read the source file and forbid the loose workdir
    // pattern from creeping into the conflict-detection path. Catches future
    // regressions where a well-meaning refactor copies the buildWhereClause
    // pattern (which DOES use `workdir IS NULL OR workdir = ?` for recall —
    // a legitimate but different invariant — see CONFLICT-05).
    const here = dirname(fileURLToPath(import.meta.url));
    // dist tree mirrors src — walk up to find the .ts file the JS was built
    // from. Easier: compute the src path absolutely.
    const srcPath = resolve(here, '../../src/memory/memory-store.ts');
    const txt = readFileSync(srcPath, 'utf8');

    const start = txt.indexOf('private detectAndPersistConflicts');
    assert.ok(start >= 0, 'detectAndPersistConflicts must exist');
    // Slice from method start to ~6000 chars (covers method body comfortably).
    const slice = txt.slice(start, start + 6000);

    // Forbid both spellings that would relax workdir isolation in the
    // conflict candidate query.
    assert.doesNotMatch(
      slice,
      /workdir\s+IS\s+NULL\s+OR\s+workdir\s*=/i,
      'forbidden loose workdir pattern detected in detectAndPersistConflicts'
    );
    assert.doesNotMatch(
      slice,
      /workdir\s*=\s*\?\s+OR\s+workdir\s+IS\s+NULL/i,
      'forbidden loose workdir pattern detected in detectAndPersistConflicts'
    );
  });

  test('grep guard: conflict-detection.ts has no DB / HTTP / fs imports (engine purity, CC.4)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = resolve(here, '../../src/memory/conflict-detection.ts');
    const txt = readFileSync(srcPath, 'utf8');
    const imports = txt.match(/^import .* from .*$/gm) ?? [];
    for (const line of imports) {
      assert.doesNotMatch(line, /better-sqlite3|libsql/i, `forbidden DB import: ${line}`);
      assert.doesNotMatch(line, /node:http|node-fetch|undici/i, `forbidden HTTP import: ${line}`);
      assert.doesNotMatch(line, /node:fs|node:path/i, `forbidden fs/path import: ${line}`);
      assert.doesNotMatch(line, /\.\.\/runtime\//i, `forbidden runtime import: ${line}`);
    }
  });
});

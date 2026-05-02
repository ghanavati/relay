import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { RememberArgsSchema, RecallArgsSchema, GetMemoryArgsSchema } from './memory.js';

// 1. RememberArgsSchema — valid minimal input succeeds; defaults applied
test('RememberArgsSchema — valid minimal input', () => {
  const result = RememberArgsSchema.safeParse({ content: 'hello', memory_type: 'fact' });
  assert.strictEqual(result.success, true);
  if (result.success) {
    assert.deepStrictEqual(result.data.tags, []);
    assert.strictEqual(result.data.pinned, false);
  }
});

// 2. RememberArgsSchema — content empty string fails
test('RememberArgsSchema — content empty string fails', () => {
  const result = RememberArgsSchema.safeParse({ content: '', memory_type: 'fact' });
  assert.strictEqual(result.success, false);
});

// 3. RememberArgsSchema — content over 50000 chars fails
test('RememberArgsSchema — content over 50000 chars fails', () => {
  const result = RememberArgsSchema.safeParse({ content: 'a'.repeat(50_001), memory_type: 'fact' });
  assert.strictEqual(result.success, false);
});

// 4. RememberArgsSchema — invalid memory_type fails
test('RememberArgsSchema — invalid memory_type fails', () => {
  const result = RememberArgsSchema.safeParse({ content: 'hello', memory_type: 'invalid' as any });
  assert.strictEqual(result.success, false);
});

// 5. RememberArgsSchema — all valid memory_type values succeed
test('RememberArgsSchema — all valid memory_type values succeed', () => {
  const types = ['fact', 'decision', 'lesson', 'context', 'state', 'handoff'] as const;
  for (const t of types) {
    const result = RememberArgsSchema.safeParse({ content: 'hello', memory_type: t });
    assert.strictEqual(result.success, true);
  }
});

// 6. RememberArgsSchema — tags over 20 items fails
test('RememberArgsSchema — tags over 20 items fails', () => {
  const result = RememberArgsSchema.safeParse({ content: 'hello', memory_type: 'fact', tags: Array(21).fill('tag') });
  assert.strictEqual(result.success, false);
});

// 7. RememberArgsSchema — expires_in_hours=0 fails (min 1)
test('RememberArgsSchema — expires_in_hours=0 fails', () => {
  const result = RememberArgsSchema.safeParse({ content: 'hello', memory_type: 'fact', expires_in_hours: 0 });
  assert.strictEqual(result.success, false);
});

// 8. RememberArgsSchema — expires_in_hours=8761 fails (max 8760)
test('RememberArgsSchema — expires_in_hours=8761 fails', () => {
  const result = RememberArgsSchema.safeParse({ content: 'hello', memory_type: 'fact', expires_in_hours: 8761 });
  assert.strictEqual(result.success, false);
});

// 9. RecallArgsSchema — valid minimal (token_budget:500) succeeds
test('RecallArgsSchema — valid minimal input', () => {
  const result = RecallArgsSchema.safeParse({ token_budget: 500 });
  assert.strictEqual(result.success, true);
});

// 10. RecallArgsSchema — token_budget missing fails
test('RecallArgsSchema — token_budget missing fails', () => {
  const result = RecallArgsSchema.safeParse({} as any);
  assert.strictEqual(result.success, false);
});

// 11. RecallArgsSchema — token_budget=99 fails (min 100)
test('RecallArgsSchema — token_budget=99 fails', () => {
  const result = RecallArgsSchema.safeParse({ token_budget: 99 });
  assert.strictEqual(result.success, false);
});

// 12. RecallArgsSchema — types=['fact','lesson'] succeeds
test('RecallArgsSchema — valid types array succeeds', () => {
  const result = RecallArgsSchema.safeParse({ token_budget: 500, types: ['fact', 'lesson'] });
  assert.strictEqual(result.success, true);
});

// 13. RecallArgsSchema — types=['invalid'] fails
test('RecallArgsSchema — invalid type in array fails', () => {
  const result = RecallArgsSchema.safeParse({ token_budget: 500, types: ['invalid'] as any });
  assert.strictEqual(result.success, false);
});

// 14. GetMemoryArgsSchema — valid UUID succeeds
test('GetMemoryArgsSchema — valid UUID succeeds', () => {
  const result = GetMemoryArgsSchema.safeParse({ memory_id: '550e8400-e29b-41d4-a716-446655440000' });
  assert.strictEqual(result.success, true);
});

// 15. GetMemoryArgsSchema — non-UUID string fails
test('GetMemoryArgsSchema — non-UUID string fails', () => {
  const result = GetMemoryArgsSchema.safeParse({ memory_id: 'not-a-uuid' });
  assert.strictEqual(result.success, false);
});

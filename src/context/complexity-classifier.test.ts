import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyTaskComplexity, getAllowedLayersForTier } from './complexity-classifier.js';

describe('complexity-classifier', () => {
  test('classifyTaskComplexity("refactor auth") === "complex"', () => {
    assert.strictEqual(classifyTaskComplexity('refactor auth'), 'complex');
  });

  test('classifyTaskComplexity("fix typo in README") === "simple"', () => {
    assert.strictEqual(classifyTaskComplexity('fix typo in README'), 'simple');
  });

  test('classifyTaskComplexity("add new endpoint") === "moderate"', () => {
    assert.strictEqual(classifyTaskComplexity('add new endpoint'), 'moderate');
  });

  test('getAllowedLayersForTier("simple") is a Set, has("worker_constraints") === true', () => {
    const layers = getAllowedLayersForTier('simple');
    assert.ok(layers instanceof Set);
    assert.strictEqual(layers.has('worker_constraints'), true);
  });

  test('getAllowedLayersForTier("moderate") === null', () => {
    assert.strictEqual(getAllowedLayersForTier('moderate'), null);
  });

  test('getAllowedLayersForTier("complex") === null', () => {
    assert.strictEqual(getAllowedLayersForTier('complex'), null);
  });
});
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scoreRelevance, filterLayersByRelevance } from './relevance-filter.js';

describe('relevance-filter', () => {
  describe('scoreRelevance', () => {
    test('empty content and query returns score 1.0', async () => {
      const result = scoreRelevance('', '');
      assert.strictEqual(result, 1.0);
    });

    test('related content returns positive score', async () => {
      const result = scoreRelevance('database migration script', 'database migration');
      assert.ok(result > 0);
    });

    test('unrelated content returns score 0', async () => {
      const result = scoreRelevance('unrelated content here', 'database migration');
      assert.strictEqual(result, 0);
    });
  });

  describe('filterLayersByRelevance', () => {
    const layers = [
      { id: 'always-kept', content: 'this should be kept' },
      { id: 'worker_constraints', content: 'constraint layer' },
      { id: 'skill:openui', content: 'openui skill layer' },
      { id: 'extra', content: 'this layer has low relevance' },
    ];

    test('worker_constraints layer is always kept', async () => {
      const result = filterLayersByRelevance(layers, 'irrelevant task', 0.5);
      const workerConstraints = result.find((l) => l.id === 'worker_constraints');
      assert.ok(workerConstraints);
    });

    test('skill:openui layer is always kept', async () => {
      const result = filterLayersByRelevance(layers, 'irrelevant task', 0.5);
      const openuiLayer = result.find((l) => l.id === 'skill:openui');
      assert.ok(openuiLayer);
    });

    test('extra layer with score below threshold is filtered out', async () => {
      const result = filterLayersByRelevance(layers, 'irrelevant task', 0.5);
      const extraLayer = result.find((l) => l.id === 'extra');
      assert.strictEqual(extraLayer, undefined);
    });
  });
});
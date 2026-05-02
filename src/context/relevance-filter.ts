import type { ContextLayer } from './layers.js';

const MANDATORY_IDS = new Set(['worker_constraints', 'agents', 'caller_context']);

function isMandatory(id: string): boolean {
  return MANDATORY_IDS.has(id) || id.startsWith('skill:') || id.startsWith('plugin:');
}

export function scoreRelevance(content: string, task: string): number {
  const taskWords = new Set(
    task.toLowerCase().split(/\W+/).filter(w => w.length > 3)
  );
  if (taskWords.size === 0) return 1.0;
  const contentWords = content.toLowerCase().split(/\W+/);
  const matches = contentWords.filter(w => taskWords.has(w)).length;
  return Math.min(1.0, matches / taskWords.size);
}

export function filterLayersByRelevance(
  layers: ContextLayer[],
  task: string,
  threshold: number,
): ContextLayer[] {
  return layers.filter(
    layer => isMandatory(layer.id) || scoreRelevance(layer.content, task) >= threshold,
  );
}

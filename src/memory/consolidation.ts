import type { Memory } from './types.js';
import type { MemoryStore } from './memory-store.js';

export interface ConsolidationCluster {
  shared_tags: string[];
  memories: Memory[];
}

export interface ConsolidationPlan {
  clusters: ConsolidationCluster[];
  total_active: number;
}

export interface ConsolidationResult {
  clusters_processed: number;
  memories_consolidated: number;
  memories_forgotten: number;
}

/**
 * Find groups of memories sharing ≥ minSharedTags tags.
 * Pure function — reads memories, returns clusters, no side effects.
 */
export function findConsolidationClusters(memories: Memory[], minSharedTags = 2): ConsolidationCluster[] {
  const clusters: ConsolidationCluster[] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < memories.length; i++) {
    const a = memories[i];
    if (assigned.has(a.memory_id)) continue;
    const cluster: Memory[] = [a];

    for (let j = i + 1; j < memories.length; j++) {
      const b = memories[j];
      if (assigned.has(b.memory_id)) continue;
      const shared = a.tags.filter((t: string) => b.tags.includes(t));
      if (shared.length >= minSharedTags) {
        cluster.push(b);
      }
    }

    if (cluster.length > 1) {
      cluster.forEach(m => assigned.add(m.memory_id));
      const allShared = a.tags.filter((t: string) => cluster.every(m => m.tags.includes(t)));
      clusters.push({
        shared_tags: allShared.length > 0 ? allShared : a.tags.slice(0, 3),
        memories: cluster,
      });
    }
  }

  return clusters;
}

/**
 * Apply consolidation: for each cluster, upsert the primary memory with combined
 * content and forget the absorbed entries.
 */
export function applyConsolidation(store: MemoryStore, clusters: ConsolidationCluster[]): ConsolidationResult {
  let memories_consolidated = 0;
  let memories_forgotten = 0;

  for (const cluster of clusters) {
    const sorted = [...cluster.memories].sort((a, b) => b.accessed_at - a.accessed_at);
    const primary = sorted[0];
    const rest = sorted.slice(1);

    const synthesized = [
      primary.content,
      ...rest.map(m => `\n\n---\n[Absorbed: ${m.entity_key ?? m.memory_id}]\n${m.content}`),
    ].join('');

    store.upsert({
      entity_key: primary.entity_key ?? primary.memory_id,
      content: synthesized,
      memory_type: primary.memory_type,
      tags: [...new Set([...cluster.shared_tags, ...primary.tags])],
      workdir: primary.workdir ?? undefined,
      pinned: primary.pinned,
    });
    memories_consolidated++;

    for (const m of rest) {
      store.forget(m.memory_id);
      memories_forgotten++;
    }
  }

  return { clusters_processed: clusters.length, memories_consolidated, memories_forgotten };
}

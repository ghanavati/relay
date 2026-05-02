/**
 * SHIP-54 — Progressive disclosure: compact search over memories.
 *
 * `memory_search` is the "index" half of the two-step recall pattern:
 *   step 1 — `memory_search` returns compact summaries (ID + tags + 100-char excerpt)
 *   step 2 — `get_memory` returns full content for the IDs the AI decides it needs
 *
 * Token cost vs `recall`: ~30 tokens/entry here, vs ~400 tokens/entry in `recall`.
 * For a 50-memory workdir, that's ~10x savings when the AI needs 2–3 full memories.
 *
 * Reuses `RecallArgsSchema` — no new schema. `recall` stays unchanged for
 * backwards compatibility.
 */

import { MemoryStore } from '../memory/memory-store.js';
import { budgetedRecall } from '../memory/memory-engine.js';
import type { RecallArgs } from '../contracts/memory.js';
import type { MemoryType, RecallQuery } from '../memory/types.js';

type McpToolResult = { content: Array<{ type: 'text'; text: string }> };

export function handleMemorySearch(args: RecallArgs): McpToolResult {
  const store = new MemoryStore();

  const query: RecallQuery = {
    query: args.query,
    tags: args.tags,
    types: args.types as MemoryType[] | undefined,
    token_budget: args.token_budget,
    workdir: args.workdir,
    include_expired: args.include_expired,
    created_after: args.created_after,
    created_before: args.created_before,
    files: args.file ? [args.file] : undefined,
  };

  const candidates = store.getCandidates(query);
  const result = budgetedRecall(candidates, query, Date.now());

  // Unlike `recall`, we do NOT call touchMemories() or logReads() here.
  // The AI has only seen a 100-char excerpt, not consumed the full memory —
  // recall_count / read-audit trail should reflect actual content disclosure,
  // which happens when `get_memory` is called for a specific ID.

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        results: result.memories.map(m => ({
          memory_id: m.memory_id,
          memory_type: m.memory_type,
          tags: m.tags,
          score: Math.round(m.score * 1000) / 1000,
          token_count: m.token_count,
          recall_count: m.recall_count,
          trust_level: m.trust_level,
          created_at: m.created_at,
          excerpt: m.content.slice(0, 100) + (m.content.length > 100 ? '…' : ''),
        })),
        total_results: result.memories.length,
        omitted_count: result.omitted_count,
      }),
    }],
  };
}

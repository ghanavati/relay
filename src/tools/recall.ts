import { MemoryStore } from '../memory/memory-store.js';
import { budgetedRecall } from '../memory/memory-engine.js';
import { computeSemanticSimilarities } from '../memory/semantic-similarities.js';
import type { RecallArgs } from '../contracts/memory.js';
import type { MemoryType, RecallQuery } from '../memory/types.js';

type McpToolResult = { content: Array<{ type: 'text'; text: string }> };

export async function handleRecall(args: RecallArgs): Promise<McpToolResult> {
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
    min_trust: args.min_trust,
  };

  // 1. Get all candidate memories (SQL-filtered by type, workdir, expiry)
  const candidates = store.getCandidates(query);

  // 2. PLAN-4 T6 — Compute semantic similarities at impure boundary BEFORE
  //    scoring. Returns empty Map when RELAY_EMBEDDING_MODEL is unset or
  //    LM Studio is unreachable, in which case the engine falls through to
  //    word-overlap (byte-identical to pre-T6 behaviour). Never throws.
  const similarities = await computeSemanticSimilarities(store, query, candidates);

  // 3. Score and select within token budget
  const result = budgetedRecall(candidates, query, Date.now(), similarities);

  // 4. Touch accessed memories to keep them fresh + SHIP-65 audit log
  const accessedIds = result.memories.map(m => m.memory_id);
  store.touchMemories(accessedIds);
  store.logReads(accessedIds, { source: 'mcp', workdir: args.workdir });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        memories: result.memories.map(m => ({
          memory_id: m.memory_id,
          memory_type: m.memory_type,
          content: m.content,
          tags: m.tags,
          score: Math.round(m.score * 1000) / 1000,
          token_count: m.token_count,
          pinned: m.pinned,
          created_at: m.created_at,
          accessed_at: m.accessed_at,
        })),
        total_tokens: result.total_tokens,
        budget_remaining: result.budget_remaining,
        omitted_count: result.omitted_count,
        candidate_count: candidates.length,
      }),
    }],
  };
}

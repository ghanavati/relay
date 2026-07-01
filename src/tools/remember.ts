import { MemoryStore } from '../memory/memory-store.js';
import type { RememberArgs } from '../contracts/memory.js';
import type { MemoryType, MemorySource } from '../memory/types.js';
import { estimateTokens } from '../memory/memory-engine.js';

type McpToolResult = { content: Array<{ type: 'text'; text: string }> };

export function handleRemember(args: RememberArgs, memorySource: MemorySource = 'worker-mcp'): McpToolResult {
  const store = new MemoryStore();

  const expiresAt = args.expires_in_hours
    ? Date.now() + args.expires_in_hours * 60 * 60 * 1000
    : null;

  const memoryId = store.remember({
    content: args.content,
    memory_type: args.memory_type as MemoryType,
    tags: args.tags,
    workdir: args.workdir ?? null,
    pinned: args.pinned,
    source_run_id: args.source_run_id,
    expires_at: expiresAt,
    memory_source: memorySource,
  });

  const tokenCount = estimateTokens(args.content);
  const totalMemories = store.count(args.workdir ?? undefined);
  const totalTokens = store.totalTokens(args.workdir ?? undefined);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        memory_id: memoryId,
        token_count: tokenCount,
        memory_type: args.memory_type,
        tags: args.tags,
        pinned: args.pinned,
        expires_at: expiresAt,
        store_stats: {
          total_memories: totalMemories,
          total_tokens: totalTokens,
        },
      }),
    }],
  };
}

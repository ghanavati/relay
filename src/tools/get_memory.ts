import { MemoryStore } from '../memory/memory-store.js';
import type { GetMemoryArgs } from '../contracts/memory.js';
import { toMcpResult } from './mcp-result.js';

type McpToolResult = { content: Array<{ type: 'text'; text: string }> };

export function handleGetMemory(args: GetMemoryArgs): McpToolResult {
  const store = new MemoryStore();
  const memory = store.getMemory(args.memory_id);
  if (!memory) {
    return toMcpResult({ error: 'not_found', memory_id: args.memory_id });
  }
  store.touchMemories([args.memory_id]);
  return toMcpResult(memory);
}

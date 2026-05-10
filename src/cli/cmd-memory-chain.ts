/**
 * `relay memory chain <root_id> [--depth N] [--json]` — show provenance chain.
 *
 * Walks `memories.superseded_by` in BOTH directions from the root:
 *   - descendants — what supersedes this (forward, linear)
 *   - ancestors   — what this supersedes (backward, may branch)
 *
 * Default depth is 5. `--depth 0` returns the root only.
 * `--json` emits a structured tree; otherwise a compact human-readable view
 * with arrows that mirror the chain direction.
 */

import type { CliIO } from './commands.js';
import type { ChainNode, MemoryChain } from '../memory/memory-store.js';
import type { Memory } from '../memory/types.js';
// Memory is referenced in label() — keep the import.

export interface MemoryChainOptions {
  readonly memoryId: string;
  readonly depth: number;
  readonly json: boolean;
}

const DEFAULT_DEPTH = 5;

/** Truncate a content preview so the tree view stays one-line per node. */
function preview(content: string, max: number = 60): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Compact label combining type + tags + a short content preview. */
function label(memory: Memory): string {
  const tagPart = memory.tags.length > 0 ? ` [${memory.tags.slice(0, 3).join(', ')}]` : '';
  return `${memory.memory_type}${tagPart} — ${preview(memory.content)}`;
}

/** Pure JSON projection of a single chain node — exported for tests. */
export function nodeToJson(node: ChainNode): Record<string, unknown> {
  return {
    memory_id: node.memory.memory_id,
    memory_type: node.memory.memory_type,
    workdir: node.memory.workdir,
    pinned: node.memory.pinned,
    tags: node.memory.tags,
    created_at: node.memory.created_at,
    superseded_by: node.superseded_by,
    depth: node.depth,
    content: node.memory.content,
  };
}

/** Render the human-readable tree view. Exported so tests can assert on text. */
export function renderChainText(chain: MemoryChain, rootId: string): string {
  if (!chain.root) return `Memory ${rootId} not found\n`;

  const lines: string[] = [];
  lines.push(`Memory ${chain.root.memory_id}`);
  lines.push('');

  // ANCESTORS — what this root supersedes (printed oldest-deepest first, then upward).
  if (chain.ancestors.length > 0) {
    lines.push(`ANCESTORS (${chain.ancestors.length} — what root supersedes)`);
    const sorted = [...chain.ancestors].sort((a, b) => b.depth - a.depth);
    for (const node of sorted) {
      const indent = '  '.repeat(node.depth);
      lines.push(`${indent}${node.memory.memory_id}  ↓`);
      lines.push(`${indent}  ${label(node.memory)}`);
    }
    lines.push('');
  } else {
    lines.push('ANCESTORS  (none — nothing supersedes through this root)');
    lines.push('');
  }

  // ROOT
  lines.push('ROOT');
  lines.push(`  ${chain.root.memory_id}`);
  lines.push(`  ${label(chain.root)}`);
  lines.push('');

  // DESCENDANTS — what supersedes the root (linear forward chain).
  if (chain.descendants.length > 0) {
    lines.push(`DESCENDANTS (${chain.descendants.length} — what supersedes root)`);
    for (const node of chain.descendants) {
      const indent = '  '.repeat(node.depth);
      lines.push(`${indent}↓`);
      lines.push(`${indent}${node.memory.memory_id}`);
      lines.push(`${indent}  ${label(node.memory)}`);
    }
  } else {
    const tail = chain.root_superseded_by;
    if (tail && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tail)) {
      lines.push(`DESCENDANTS (chain continues at ${tail} — beyond depth or pointer dangling)`);
    } else if (tail) {
      lines.push(`DESCENDANTS (root tombstoned: superseded_by=${tail})`);
    } else {
      lines.push('DESCENDANTS (none — root is still active)');
    }
  }

  return lines.join('\n') + '\n';
}

export async function executeMemoryChainCommand(
  command: MemoryChainOptions,
  io: CliIO
): Promise<number> {
  if (!command.memoryId) {
    io.stderr('relay memory chain requires <memory_id>\n');
    return 2;
  }
  const depth = Number.isFinite(command.depth) ? command.depth : DEFAULT_DEPTH;
  if (depth < 0) {
    io.stderr('relay memory chain --depth must be >= 0\n');
    return 2;
  }

  const { MemoryStore } = await import('../memory/memory-store.js');
  const store = new MemoryStore();
  const chain = store.getChain(command.memoryId, depth);

  if (!chain.root) {
    if (command.json) {
      io.stdout(JSON.stringify({ error: 'not_found', memory_id: command.memoryId }) + '\n');
    } else {
      io.stderr(`Memory ${command.memoryId} not found\n`);
    }
    return 1;
  }

  if (command.json) {
    io.stdout(JSON.stringify({
      root: {
        memory_id: chain.root.memory_id,
        memory_type: chain.root.memory_type,
        workdir: chain.root.workdir,
        pinned: chain.root.pinned,
        tags: chain.root.tags,
        created_at: chain.root.created_at,
        superseded_by: chain.root_superseded_by,
        content: chain.root.content,
      },
      ancestors: chain.ancestors.map(nodeToJson),
      descendants: chain.descendants.map(nodeToJson),
      depth,
    }) + '\n');
    return 0;
  }

  io.stdout(renderChainText(chain, command.memoryId));
  return 0;
}

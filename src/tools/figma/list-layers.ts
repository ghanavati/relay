/**
 * Phase 7 / Task 3 — figma_list_layers tool.
 *
 * Returns a flat layer tree for a Figma page or document root.
 * Read-only — safe for any plan tier (FIGMA-01).
 *
 * Routing:
 *   - page_id present → GET /v1/files/{key}/nodes?ids={page_id}&depth={depth|infinity}
 *   - page_id absent  → GET /v1/files/{key}?depth={depth|1}
 *     (default depth=1 at root to bound the payload — large files can return
 *      multi-megabyte responses at full depth)
 *
 * Output: `{ layers: [{ id, name, type, parent_id, depth }] }` —
 * pre-flattened so the model doesn't recurse client-side.
 */

import { z } from 'zod';
import type { ToolDef } from '../../workers/types.js';
import { figmaGet, type FetchFn, type SleepFn } from './rest-client.js';

export interface FlatLayer {
  id: string;
  name: string;
  type: string;
  parent_id: string | null;
  depth: number;
}

/** Args schema — file_key required; page_id and depth optional. */
const LIST_LAYERS_ARGS = z.object({
  file_key: z.string().min(1),
  page_id: z.string().min(1).optional(),
  // `depth` is normally a positive integer, but Figma also accepts the literal
  // "infinity" string when paired with `ids=` — allow both forms.
  depth: z.union([z.number().int().positive(), z.literal('infinity')]).optional(),
});

export const LIST_LAYERS_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'figma_list_layers',
    description:
      'Return a flat layer tree for a Figma page. Read-only. Uses the GET file ' +
      'nodes endpoint. Safe for any plan tier.',
    parameters: {
      type: 'object',
      properties: {
        file_key: {
          type: 'string',
          description: 'Figma file key (the segment after /file/ in the Figma URL)',
        },
        page_id: {
          type: 'string',
          description:
            'Node ID of the page (CANVAS node). If omitted, returns layers from the document root.',
        },
        depth: {
          description:
            'Tree traversal depth. Integer >= 1, or "infinity". Defaults to 1 at root, infinity when page_id is set.',
        },
      },
      required: ['file_key'],
    },
  },
};

/**
 * Recursive flattener — converts a Figma node tree into `FlatLayer[]`.
 * Walks `children` array preserving parent_id and depth. Iterative-safe
 * because Figma trees are bounded by file constraints (<1M nodes per file
 * in practice; even pathological depths flatten in O(N)).
 *
 * Tail-call optimization not required — explicit stack via Array.push is fine.
 */
function flattenNode(
  node: { id: string; name?: string; type?: string; children?: unknown[] },
  parentId: string | null,
  depth: number,
  out: FlatLayer[],
): void {
  out.push({
    id: node.id,
    name: typeof node.name === 'string' ? node.name : '',
    type: typeof node.type === 'string' ? node.type : '',
    parent_id: parentId,
    depth,
  });
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (child && typeof child === 'object' && typeof (child as { id?: unknown }).id === 'string') {
      flattenNode(child as { id: string; children?: unknown[] }, node.id, depth + 1, out);
    }
  }
}

interface HandlerCtx {
  workdir: string;
  pat: string;
  fetchImpl?: FetchFn;
  sleepImpl?: SleepFn;
}

export async function handleListLayers(
  args: unknown,
  ctx: HandlerCtx,
): Promise<{ layers: FlatLayer[] }> {
  const parsed = LIST_LAYERS_ARGS.parse(args);

  // Build path + query for the two route shapes.
  let path: string;
  const query: Record<string, string | number | undefined> = {};
  if (parsed.page_id) {
    path = `/v1/files/${encodeURIComponent(parsed.file_key)}/nodes`;
    query['ids'] = parsed.page_id;
    query['depth'] = parsed.depth === undefined ? 'infinity' : String(parsed.depth);
  } else {
    path = `/v1/files/${encodeURIComponent(parsed.file_key)}`;
    query['depth'] = parsed.depth === undefined ? 1 : String(parsed.depth);
  }

  const response = await figmaGet(path, {
    pat: ctx.pat,
    query,
    fetchImpl: ctx.fetchImpl,
    sleepImpl: ctx.sleepImpl,
  });

  // Extract the root document node from either shape.
  const layers: FlatLayer[] = [];
  const respObj = (response ?? {}) as {
    document?: { id: string; children?: unknown[] };
    nodes?: Record<string, { document?: { id: string; children?: unknown[] } }>;
  };

  if (respObj.nodes && typeof respObj.nodes === 'object') {
    // /nodes endpoint shape — nodes[<id>].document
    for (const entry of Object.values(respObj.nodes)) {
      if (entry && entry.document) {
        flattenNode(entry.document, null, 0, layers);
      }
    }
  } else if (respObj.document) {
    // /files/{key} endpoint shape — top-level document
    flattenNode(respObj.document, null, 0, layers);
  }

  return { layers };
}

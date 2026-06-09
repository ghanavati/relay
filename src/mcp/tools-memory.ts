/**
 * Phase 9 / Plan 03 — the v0.4 MCP tool surface: relay_memory_recall +
 * relay_memory_save (D-07: memory only — no control, no dispatch, no shell).
 *
 * THIN wrappers over the existing memory handlers (D-09):
 *   - handleRecall / handleRemember own all behavior; nothing reimplemented.
 *   - inputSchema IS the contracts Zod object (D-08/MCP-03) — single source
 *     of truth, asserted by identity in tests. SDK 1.29.0 accepts a
 *     constructed Zod v3 object as inputSchema (zod-compat AnySchema /
 *     normalizeObjectSchema) — verified against the installed package.
 *   - Workdir scoping (RELAY_MEMORY_ALLOWED_WORKDIRS) is inherited because
 *     the handlers call through MemoryStore.assertWorkdirAllowed (D-10/MCP-02);
 *     a forbidden workdir maps to an MCP isError result via result.ts.
 *   - The handlers emit the { content } envelope but do NOT redact; redaction
 *     happens HERE, at the boundary (D-11/MCP-04, threat T-09-09), on every
 *     text field crossing out — success and error paths alike.
 *
 * Deliberately SDK-free (same rule as result.ts): registrations are plain
 * { name, config: { description, inputSchema }, handler } objects that Plan
 * 04's server passes to McpServer.registerTool.
 */
import { handleRecall } from '../tools/recall.js';
import { RecallArgsSchema } from '../contracts/memory.js';
import type { RecallArgs } from '../contracts/memory.js';
import { relayErrorToMcpResult } from './result.js';
import type { McpToolResult } from './result.js';
import { redactSecrets } from '../security/redaction.js';

/** One MCP tool registration: what Plan 04 hands to McpServer.registerTool. */
export interface MemoryMcpTool<TSchema, TArgs> {
  readonly name: string;
  readonly config: {
    readonly description: string;
    readonly inputSchema: TSchema;
  };
  readonly handler: (args: TArgs) => Promise<McpToolResult>;
}

export type RecallMcpTool = MemoryMcpTool<typeof RecallArgsSchema, RecallArgs>;

/**
 * Boundary redaction for an envelope the handlers already built: redactSecrets
 * on every text field, shape preserved. (result.ts's toMcpResult would
 * double-wrap an already-enveloped handler result — this is the
 * "re-serialize + redact the returned text" path instead.)
 */
function redactEnvelope(envelope: {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
}): McpToolResult {
  return {
    content: envelope.content.map(item => ({
      type: 'text' as const,
      text: redactSecrets(item.text),
    })),
  };
}

const RECALL_DESCRIPTION =
  'Recall persistent Relay memories (facts, decisions, lessons, context) for a project. ' +
  'Memory persists across sessions and across tools — anything saved earlier by the CLI, ' +
  'a worker, or another MCP client is searchable here. token_budget hard-caps the total ' +
  'tokens returned; set it to what your context can afford. Pass workdir (absolute project ' +
  'path) to scope results to that project. Optional query, tags, and types narrow the search.';

export function buildMemoryMcpTools(): readonly [RecallMcpTool] {
  const recall: RecallMcpTool = {
    name: 'relay_memory_recall',
    config: {
      description: RECALL_DESCRIPTION,
      inputSchema: RecallArgsSchema,
    },
    handler: async (args: RecallArgs): Promise<McpToolResult> => {
      try {
        // handleRecall is async (semantic-similarity embedding) and already
        // returns the { content } envelope — redact it, do not re-wrap.
        return redactEnvelope(await handleRecall(args));
      } catch (err) {
        // e.g. MEMORY_WORKDIR_FORBIDDEN thrown by MemoryStore's
        // assertWorkdirAllowed gate — code preserved, message redacted,
        // stack never crosses.
        return relayErrorToMcpResult(err);
      }
    },
  };

  return [recall];
}

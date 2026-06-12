/**
 * Phase 9 — Relay MCP server (REQ-MCP-01..07).
 *
 * Serves the existing `src/tools/*` handlers (extracted from relay-mcp, where
 * they were born as MCP tools) over the Model Context Protocol via the
 * official SDK. Stdio transport only — wiring lives in cli/cmd-mcp.ts.
 *
 * Security posture (PRD D-03 + REQ-MCP-03/05):
 *  - writes enter as memory_source='worker-mcp' → trust 'unverified'
 *  - `pinned` and `source_run_id` are NOT exposed — pinning jumps quarantine
 *    (pinned ⇒ trusted) and source_run_id bypasses the write rate limit
 *  - recall defaults to min_trust='provisional' (Wave 4 lesson 10), so
 *    MCP-written entries cannot surface over MCP until promoted
 *  - the `relay pause` sentinel blocks recall/search/remember/prompt
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { recallSchema, rememberSchema, GetMemoryArgsSchema } from '../contracts/memory.js';
import { corpusQuerySchema } from '../contracts/corpus.js';
import { browseRunsSchema } from '../contracts/browse_runs.js';
import { compareRunsSchema } from '../contracts/compare-runs.js';
import { handleRecall } from '../tools/recall.js';
import { handleMemorySearch } from '../tools/memory_search.js';
import { handleGetMemory } from '../tools/get_memory.js';
import { handleCorpusQuery } from '../tools/corpus_query.js';
import { handleBrowseRuns } from '../tools/browse_runs.js';
import { handleCompareRuns } from '../tools/compare-runs.js';
import { handleRemember } from '../tools/remember.js';
import { resolveMcpWorkdir } from './workdir.js';
import { isPaused } from '../cli/cmd-pause.js';
import type { RecallArgs, RememberArgs } from '../contracts/memory.js';
import type { CorpusQueryArgs } from '../contracts/corpus.js';
import type { BrowseRunsArgs } from '../contracts/browse_runs.js';
import type { CompareRunsArgs } from '../contracts/compare-runs.js';

/** Version reported in serverInfo. Reconciled with package.json in 09-04. */
export const RELAY_MCP_SERVER_VERSION = '0.1.2';

export const MCP_TOOL_NAMES: readonly string[] = [
  'relay_recall',
  'relay_memory_search',
  'relay_get_memory',
  'relay_corpus_query',
  'relay_browse_runs',
  'relay_compare_runs',
  'relay_remember',
];

type McpToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * REQ-MCP-01 — error mapping. RelayError-shaped throws become isError tool
 * results carrying code+message; everything is logged to stderr (stdout is
 * protocol-only in stdio mode; "no silent error swallowing" per AGENTS.md).
 */
function guard<TArgs>(
  name: string,
  fn: (args: TArgs) => McpToolResult | Promise<McpToolResult>
): (args: TArgs) => Promise<McpToolResult> {
  return async (args: TArgs): Promise<McpToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      const e = err as Partial<{ code: string; message: string }>;
      const code = typeof e.code === 'string' ? e.code : 'UNKNOWN';
      const message = typeof e.message === 'string' ? e.message : String(err);
      process.stderr.write(`[relay-mcp] ${name}: ${code} ${message}\n`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
        isError: true,
      };
    }
  };
}

function pausedResult(): McpToolResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        paused: true,
        memories: [],
        message: 'relay is paused (~/.relay/paused) — run `relay resume` to re-enable memory',
      }),
    }],
  };
}

/** Pause sentinel check — '*' scope checks the global sentinel only. */
async function pausedFor(workdir: string): Promise<boolean> {
  return isPaused(workdir === '*' ? undefined : workdir);
}

// REQ-MCP-02 — MCP-friendly recall shape: token_budget becomes optional with
// the CLI's default; everything else is the canonical contract, untouched.
const mcpRecallShape = {
  ...recallSchema,
  token_budget: z.number().int().min(100).max(50_000).optional().default(4000)
    .describe('Hard cap on total tokens returned (default 4000)'),
};

// REQ-MCP-03 — restricted remember shape. `pinned` (jumps quarantine: pinned
// ⇒ trusted) and `source_run_id` (bypasses write rate limit) are deliberately
// absent; the SDK's Zod parse strips them if a client sends them anyway.
const mcpRememberShape = {
  content: rememberSchema.content,
  memory_type: rememberSchema.memory_type,
  tags: rememberSchema.tags,
  workdir: rememberSchema.workdir,
  expires_in_hours: rememberSchema.expires_in_hours,
};

type McpRecallArgs = Omit<RecallArgs, 'token_budget'> & { token_budget: number };

function toRecallArgs(args: McpRecallArgs, workdir: string): RecallArgs {
  return {
    ...args,
    workdir,
    // Wave 4 lesson 10 — provisional floor for LLM-facing surfaces. Explicit
    // min_trust='unverified' is the documented opt-in to raw MCP writes.
    min_trust: args.min_trust ?? 'provisional',
  };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'relay', version: RELAY_MCP_SERVER_VERSION });

  server.registerTool('relay_recall', {
    description:
      'Recall scored memories for a project workdir within a token budget. ' +
      "Defaults min_trust='provisional' — pass 'unverified' to include raw MCP/auto writes.",
    inputSchema: mcpRecallShape,
  }, guard('relay_recall', async (args: McpRecallArgs) => {
    const workdir = resolveMcpWorkdir(args.workdir, 'read');
    if (await pausedFor(workdir)) return pausedResult();
    return handleRecall(toRecallArgs(args, workdir));
  }));

  server.registerTool('relay_memory_search', {
    description:
      'Compact index search over memories (ID + tags + excerpt). Pair with ' +
      'relay_get_memory for full content — ~10x cheaper than relay_recall for browsing.',
    inputSchema: mcpRecallShape,
  }, guard('relay_memory_search', async (args: McpRecallArgs) => {
    const workdir = resolveMcpWorkdir(args.workdir, 'read');
    if (await pausedFor(workdir)) return pausedResult();
    return handleMemorySearch(toRecallArgs(args, workdir));
  }));

  server.registerTool('relay_get_memory', {
    description: 'Fetch one memory entry in full by memory_id.',
    inputSchema: GetMemoryArgsSchema.shape,
  }, guard('relay_get_memory', async (args: { memory_id: string }) =>
    handleGetMemory(args)
  ));

  server.registerTool('relay_corpus_query', {
    description: 'Query a named corpus built with `relay corpus build` (read-only).',
    inputSchema: corpusQuerySchema,
  }, guard('relay_corpus_query', async (args: CorpusQueryArgs) =>
    handleCorpusQuery(args)
  ));

  server.registerTool('relay_browse_runs', {
    description: 'List recorded delegation runs (provider, model, status, files changed).',
    inputSchema: browseRunsSchema,
  }, guard('relay_browse_runs', async (args: BrowseRunsArgs) =>
    handleBrowseRuns(args)
  ));

  server.registerTool('relay_compare_runs', {
    description: 'Compare 2+ runs by run_id: shared vs diverged files changed.',
    inputSchema: compareRunsSchema,
  }, guard('relay_compare_runs', async (args: CompareRunsArgs) =>
    handleCompareRuns(args)
  ));

  server.registerTool('relay_remember', {
    description:
      'Store a memory for a project workdir. MCP writes enter quarantined ' +
      "(source 'worker-mcp', trust 'unverified') and do not surface at default " +
      'recall until promoted — see `relay memory why` / trust tiers.',
    inputSchema: mcpRememberShape,
  }, guard('relay_remember', async (args: {
    content: string;
    memory_type: RememberArgs['memory_type'];
    tags: string[];
    workdir?: string;
    expires_in_hours?: number;
  }) => {
    const workdir = resolveMcpWorkdir(args.workdir, 'write');
    if (await pausedFor(workdir)) return pausedResult();
    const rememberArgs: RememberArgs = {
      content: args.content,
      memory_type: args.memory_type,
      tags: args.tags ?? [],
      pinned: false,
      workdir,
      ...(args.expires_in_hours !== undefined ? { expires_in_hours: args.expires_in_hours } : {}),
    };
    return handleRemember(rememberArgs, 'worker-mcp');
  }));

  // REQ-MCP-07 — one-tap context loading for clients without hooks
  // (Claude Desktop). Mirrors `relay memory show-context` defaults:
  // lesson+decision, 800-token budget, provisional floor.
  server.registerPrompt('relay-context', {
    description:
      "Load relay's recalled lessons + decisions for a project workdir into the conversation.",
    argsSchema: {
      workdir: z.string().optional().describe(
        'Project workdir to load context for (falls back to RELAY_MCP_DEFAULT_WORKDIR)'
      ),
      query: z.string().optional().describe('Optional focus query to bias recall'),
    },
  }, async (args: { workdir?: string; query?: string }) => {
    const workdir = resolveMcpWorkdir(args.workdir, 'read');
    if (await pausedFor(workdir)) {
      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: 'Relay is paused — no context loaded. Run `relay resume` to re-enable.' },
        }],
      };
    }
    const recallArgs: RecallArgs = {
      query: args.query,
      tags: [],
      types: ['lesson', 'decision'],
      token_budget: 800,
      workdir,
      include_expired: false,
      min_trust: 'provisional',
    };
    const result = await handleRecall(recallArgs);
    const payload = JSON.parse(result.content[0]!.text) as {
      memories: Array<{ memory_type: string; content: string; tags: string[] }>;
      omitted_count: number;
    };
    const lines = payload.memories.map(
      m => `- [${m.memory_type}] ${m.content}${m.tags.length > 0 ? ` (tags: ${m.tags.join(', ')})` : ''}`
    );
    const text = lines.length > 0
      ? `# Relay context — ${workdir}\n\n${lines.join('\n')}\n\n(${payload.omitted_count} entries omitted by budget/trust floor)`
      : `# Relay context — ${workdir}\n\nNo provisional-or-better lessons/decisions stored for this workdir yet.`;
    return {
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
    };
  });

  return server;
}

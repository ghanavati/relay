/**
 * Phase 9 / Plan 03 — the v0.4 MCP tool surface: relay_memory_recall +
 * relay_memory_save (D-07: memory only — no control, no dispatch, no shell).
 *
 * THIN wrappers over the existing memory handlers (D-09):
 *   - handleRecall / handleRemember own all behavior; nothing reimplemented.
 *   - recall's inputSchema IS the contracts Zod object (D-08/MCP-03) —
 *     single source of truth, asserted by identity in tests. save's schema
 *     is DERIVED from it via .omit (pinned/source_run_id are not client-
 *     settable over MCP — review fix 4); the remaining field schemas stay
 *     the same objects by reference. SDK 1.29.0 accepts a constructed Zod
 *     v3 object as inputSchema (zod-compat AnySchema / normalizeObjectSchema)
 *     — verified against the installed package.
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
import { handleRemember } from '../tools/remember.js';
import { RecallArgsSchema, RememberArgsSchema } from '../contracts/memory.js';
import type { RecallArgs, RememberArgs } from '../contracts/memory.js';
import { relayErrorToMcpResult } from './result.js';
import type { McpToolResult } from './result.js';
import { redactSecrets } from '../security/redaction.js';
import type { MemorySource } from '../memory/types.js';

/**
 * The MCP save surface (review fix 4): the contracts schema MINUS pinned and
 * source_run_id. Pinned rows gain retrieval score boost plus GC/conflict
 * protection — letting an external MCP client set pinned would amplify
 * memory poisoning (T-09-09); source_run_id would let it claim provenance
 * from a run it never was. zod .omit keeps the remaining field schemas as
 * the SAME objects (single-source with contracts/memory.ts, D-08/MCP-03).
 */
export const McpSaveArgsSchema = RememberArgsSchema.omit({
  pinned: true,
  source_run_id: true,
});
export type McpSaveArgs = Omit<RememberArgs, 'pinned' | 'source_run_id'>;

/**
 * Memory source tag for MCP-client saves. The MemorySource union has no
 * MCP-specific value; 'worker-mcp' is the existing worker-MCP-path tag and
 * keeps the trust model right: non-human sources start unverified-by-default
 * (computeTrustLevel), which is exactly the posture an external MCP client's
 * write deserves.
 */
export const MCP_MEMORY_SOURCE: MemorySource = 'worker-mcp';

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
export type SaveMcpTool = MemoryMcpTool<typeof McpSaveArgsSchema, McpSaveArgs>;

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

/**
 * Allowed workdir roots from RELAY_MEMORY_ALLOWED_WORKDIRS — the same split
 * MemoryStore.assertWorkdirAllowed applies (colon-separated, trimmed, empties
 * dropped). Read lazily at call time, like the store's gate.
 */
function allowedWorkdirRoots(): readonly string[] {
  const raw = process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
  if (!raw) return [];
  return raw
    .split(':')
    .map(p => p.trim())
    .filter(Boolean);
}

/**
 * Desktop ergonomics: MCP clients often launch the server with a junk cwd and
 * omit workdir. When the allow-list is configured, an omitted workdir means
 * "the configured project" — the FIRST allowed root — instead of falling
 * through to a cwd-based default the gate would reject. With no allow-list
 * the args pass through untouched (existing cwd/global behavior downstream).
 * MCP-handler-only: the CLI path and contracts schemas are not involved.
 */
function applyWorkdirDefault<T extends { readonly workdir?: string | undefined }>(args: T): T {
  if (args.workdir !== undefined) return args;
  const first = allowedWorkdirRoots()[0];
  return first === undefined ? args : { ...args, workdir: first };
}

/**
 * When the workdir gate still rejects a call, name the allowed roots in the
 * error so the client model can retry with a valid path instead of asking
 * the user. Roots come straight from the env var the user configured — no
 * other paths are disclosed. Non-gate errors pass through untouched.
 */
function enrichForbiddenWorkdir(err: unknown): unknown {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code !== 'MEMORY_WORKDIR_FORBIDDEN') return err;
  const roots = allowedWorkdirRoots();
  if (roots.length === 0) return err;
  const message = err instanceof Error ? err.message : String(err);
  const enriched = new Error(`${message}. Allowed workdirs: ${roots.join(', ')}`);
  (enriched as Error & { code?: string }).code = 'MEMORY_WORKDIR_FORBIDDEN';
  return enriched;
}

// Trigger-rich on purpose: MCP clients (Claude Desktop above all) only call
// tools whose descriptions say WHEN to call them. tools-memory.test.ts pins
// the trigger phrases.
const RECALL_DESCRIPTION =
  "Search the user's persistent cross-tool memory — shared with Claude Code, Cursor, and " +
  'the terminal — which holds context this conversation does not. Use it before answering ' +
  'any question about past decisions, agreements, lessons, prior work, or project history: ' +
  'anything like "what did we decide, agree, or learn?". Pass workdir as the project\'s ' +
  "absolute path, or omit it to use the server's default allowed project. token_budget " +
  'hard-caps response tokens; ~800 is typical. Optional query, tags, and types narrow ' +
  'the search.';

const SAVE_DESCRIPTION =
  'Save durable decisions, lessons, and facts the user states or confirms, so other tools ' +
  '(Claude Code, Cursor, the terminal) and future sessions can recall them. memory_type ' +
  'sets decay and retrieval priority: fact (durable knowledge), decision (what was decided ' +
  'and why), lesson (mistakes and corrections), context (working state), state (volatile ' +
  "current task), handoff (session continuity). Pass workdir as the project's absolute " +
  "path, or omit it for the server's default allowed project. Never save secrets, " +
  'credentials, or API keys. Writes are deduplicated, rate-limited, and redacted by ' +
  'the store.';

export function buildMemoryMcpTools(): readonly [RecallMcpTool, SaveMcpTool] {
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
        return redactEnvelope(await handleRecall(applyWorkdirDefault(args)));
      } catch (err) {
        // e.g. MEMORY_WORKDIR_FORBIDDEN thrown by MemoryStore's
        // assertWorkdirAllowed gate — code preserved, message redacted
        // (and gate errors name the allowed roots), stack never crosses.
        return relayErrorToMcpResult(enrichForbiddenWorkdir(err));
      }
    },
  };

  const save: SaveMcpTool = {
    name: 'relay_memory_save',
    config: {
      description: SAVE_DESCRIPTION,
      inputSchema: McpSaveArgsSchema,
    },
    handler: async (args: McpSaveArgs): Promise<McpToolResult> => {
      try {
        // handleRemember is synchronous (better-sqlite3) — no await on it;
        // the async signature is the MCP handler contract, nothing more.
        // Same MemoryStore gates as the CLI: workdir scoping, per-source
        // write rate limit, 60s content dedup, redaction-on-save.
        //
        // Field-by-field whitelist (review fix 4): pinned is forced false
        // and source_run_id never set, even if a client smuggled them past
        // the omitted schema — defense in depth on top of McpSaveArgsSchema.
        const constrained: RememberArgs = applyWorkdirDefault({
          content: args.content,
          memory_type: args.memory_type,
          tags: args.tags,
          pinned: false,
          ...(args.workdir !== undefined ? { workdir: args.workdir } : {}),
          ...(args.expires_in_hours !== undefined
            ? { expires_in_hours: args.expires_in_hours }
            : {}),
        });
        return redactEnvelope(handleRemember(constrained, MCP_MEMORY_SOURCE));
      } catch (err) {
        return relayErrorToMcpResult(enrichForbiddenWorkdir(err));
      }
    },
  };

  return [recall, save];
}

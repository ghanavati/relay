// src/mcp/result.ts — the ONE module that owns the MCP envelope, boundary
// redaction, and RelayError→MCP-error mapping (MCP-04, decisions D-11).
//
// Deliberately SDK-free: these are pure transforms returning plain objects
// shaped like the SDK's CallToolResult, so the module tests under node:test
// without the SDK and stays decoupled from the SDK surface. Plan 03's tool
// wrappers route every result through here so no secret or raw exception can
// cross the MCP boundary (threats T-09-05, T-09-06).
import { redactSecrets } from '../security/redaction.js';

export interface McpTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface McpToolResult {
  readonly content: readonly McpTextContent[];
  readonly isError?: boolean;
}

/**
 * JSON.stringify that never returns undefined: bare undefined / functions /
 * symbols fall back to String() so the envelope always carries text.
 */
function serialize(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

/**
 * Wrap any value in the MCP text-content envelope. Redaction runs on the
 * SERIALIZED text (after JSON.stringify) so secrets nested anywhere in the
 * object graph are covered. Inputs are never mutated.
 */
export function toMcpResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: redactSecrets(serialize(value)) }] };
}

/**
 * Map a thrown value to an MCP tool-error result. A RelayException (string
 * `code`, same guard as src/control/tools.ts) keeps its code; anything else
 * folds to 'UNKNOWN'. Only `message` crosses the boundary — never the stack —
 * and the serialized text is redacted. This function never throws.
 */
export function relayErrorToMcpResult(err: unknown): McpToolResult {
  const rawCode = (err as { code?: unknown } | null | undefined)?.code;
  const code = typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : 'UNKNOWN';
  const message = err instanceof Error ? err.message : String(err);
  const text = redactSecrets(serialize({ ok: false, code, message }));
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Run a handler and shape its outcome into an MCP result: success through
 * toMcpResult, RelayError through the code-bearing mapping, any other throw
 * to a generic UNKNOWN isError result. A throw never escapes — the MCP server
 * must not crash from a handler error.
 */
export async function withMcpResult(fn: () => unknown): Promise<McpToolResult> {
  try {
    return toMcpResult(await fn());
  } catch (err) {
    return relayErrorToMcpResult(err);
  }
}

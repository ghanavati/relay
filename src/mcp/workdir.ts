/**
 * Phase 9 (REQ-MCP-04) — workdir resolution for MCP-served tools.
 *
 * MCP clients (Claude Desktop, Cursor, Windsurf) have no meaningful cwd, so
 * the CLI's cwd-default path (resolve-memory-workdir.ts) does not apply here.
 * Resolution order:
 *   1. explicit `workdir` tool argument — always wins ('*' allowed read-only)
 *   2. RELAY_MCP_DEFAULT_WORKDIR from the client's MCP server `env` block
 *   3. refuse with an instructive error
 * Never a silent global fallback: a desktop client talking to the wrong
 * project's memory is the cross-project leakage failure mode this guards.
 */
import { makeError, toRelayException } from '../errors.js';

export function resolveMcpWorkdir(
  explicit: string | undefined,
  mode: 'read' | 'write',
  env: NodeJS.ProcessEnv = process.env,
): string {
  const provided = explicit && explicit.length > 0 ? explicit : undefined;
  if (provided !== undefined) {
    if (provided === '*' && mode === 'write') {
      throw toRelayException(makeError(
        'INVALID_ARGS',
        "workdir '*' is a read-only scope — writes must name a single project workdir",
        false,
        'mcp'
      ));
    }
    return provided;
  }
  const fallback = env['RELAY_MCP_DEFAULT_WORKDIR'];
  if (fallback && fallback.length > 0) return fallback;
  throw toRelayException(makeError(
    'INVALID_ARGS',
    'workdir required: pass a `workdir` argument, or set RELAY_MCP_DEFAULT_WORKDIR in the MCP server env block of your client config',
    false,
    'mcp'
  ));
}

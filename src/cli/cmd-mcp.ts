/**
 * Phase 9 (REQ-MCP-01) — `relay mcp serve [--selfcheck]`.
 *
 * Stdio MCP server over the existing tool handlers. In serve mode stdout is
 * protocol-only: nothing in this path may write to stdout except the SDK
 * transport. Diagnostics go to stderr.
 *
 * `--selfcheck` runs an in-process client/server handshake over
 * InMemoryTransport (no stdio takeover), prints a JSON verdict, exits 0/1.
 */
import type { CliIO } from './commands.js';

const USAGE = `Usage: relay mcp serve [--selfcheck]

  serve         Serve relay memory tools over MCP stdio (for Claude Desktop,
                Cursor, Windsurf, or any MCP client).
  --selfcheck   In-process handshake + tools/list verification. Exits 0 on ok.

Client config (Claude Desktop — claude_desktop_config.json):
  { "mcpServers": { "relay": {
      "command": "node",
      "args": ["<abs-path-to-repo>/dist/cli.js", "mcp", "serve"],
      "env": { "RELAY_MCP_DEFAULT_WORKDIR": "<abs-path-to-your-project>" }
  } } }
`;

export async function executeMcpCommand(rest: readonly string[], io: CliIO): Promise<number> {
  const sub = rest[0];
  if (sub !== 'serve') {
    io.stderr(USAGE);
    return 2;
  }
  if (rest.includes('--selfcheck')) {
    return runSelfcheck(io);
  }
  return runServe();
}

async function runServe(): Promise<number> {
  const [{ buildMcpServer }, { StdioServerTransport }] = await Promise.all([
    import('../mcp/server.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
  ]);
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until the client closes stdin (or kills us). The SDK invokes
  // Protocol.onclose when the transport goes away.
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  return 0;
}

async function runSelfcheck(io: CliIO): Promise<number> {
  const [{ buildMcpServer, MCP_TOOL_NAMES }, { Client }, { InMemoryTransport }] = await Promise.all([
    import('../mcp/server.js'),
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/inMemory.js'),
  ]);
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'relay-selfcheck', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();
    const toolNames = tools.map(t => t.name).sort();
    const promptNames = prompts.map(p => p.name);
    const ok =
      [...MCP_TOOL_NAMES].sort().every(n => toolNames.includes(n)) &&
      promptNames.includes('relay-context');
    io.stdout(JSON.stringify({ ok, tools: toolNames, prompts: promptNames }) + '\n');
    return ok ? 0 : 1;
  } finally {
    await client.close();
    await server.close();
  }
}

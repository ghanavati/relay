/**
 * MCP client auto-wiring — registers the `relay` stdio MCP server with every
 * client detected on this machine.
 *
 *   Claude Code     → `claude mcp add --scope user` (its own stable CLI)
 *   Claude Desktop  → JSON merge into claude_desktop_config.json
 *   Cursor          → JSON merge into ~/.cursor/mcp.json
 *   Codex CLI       → `[mcp_servers.relay]` block in ~/.codex/config.toml
 *
 * Same safety pattern as the hook installer (cmd-memory-ops.ts): abort on an
 * unparseable config rather than overwrite it, preserve foreign entries,
 * idempotent re-runs. The written command uses absolute paths (node binary +
 * dist/cli.js) because GUI clients launch without the shell's PATH.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_MCP_ENTRY } from '../control/adapters/codex.js';

export type McpClient = 'claude-code' | 'claude-desktop' | 'cursor' | 'codex';

export interface McpWireResult {
  readonly client: McpClient;
  readonly status: 'wired' | 'already' | 'not-detected' | 'failed';
  readonly detail: string;
}

export interface McpProbeResult {
  readonly client: McpClient;
  /** true = registered, false = client present but no relay entry, null = client not detected */
  readonly registered: boolean | null;
  readonly detail: string;
}

export interface McpServerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function resolveRelayMcpCommand(): McpServerCommand {
  // dist/cli/mcp-clients.js → dist/cli.js
  const cliJs = join(dirname(dirname(fileURLToPath(import.meta.url))), 'cli.js');
  return { command: process.execPath, args: [cliJs, 'mcp'] };
}

/**
 * Merge `mcpServers.relay` into a JSON config file (Claude Desktop, Cursor).
 * Creates the file when missing; a differing existing relay entry is updated
 * in place (covers node-path changes). Exported for tests.
 */
export function upsertMcpJsonEntry(
  configPath: string,
  cmd: McpServerCommand
): { status: 'wired' | 'already' | 'failed'; detail: string } {
  let root: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      return {
        status: 'failed',
        detail: `${configPath} is not valid JSON — fix or remove it, then re-run`,
      };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'failed', detail: `${configPath} is not a JSON object` };
    }
    root = parsed as Record<string, unknown>;
  }
  const serversRaw = root['mcpServers'] ?? {};
  if (serversRaw === null || typeof serversRaw !== 'object' || Array.isArray(serversRaw)) {
    return { status: 'failed', detail: `${configPath} has a non-object "mcpServers"` };
  }
  const servers = serversRaw as Record<string, unknown>;
  const desired = { command: cmd.command, args: [...cmd.args] };
  if (JSON.stringify(servers['relay']) === JSON.stringify(desired)) {
    return { status: 'already', detail: configPath };
  }
  servers['relay'] = desired;
  root['mcpServers'] = servers;
  writeFileSync(configPath, JSON.stringify(root, null, 2) + '\n');
  return { status: 'wired', detail: configPath };
}

/**
 * Append a `[mcp_servers.relay]` block to Codex's config.toml when absent.
 * Presence is detected with the same regex Codex control probing uses.
 * Exported for tests.
 */
export function upsertCodexMcpEntry(
  configPath: string,
  cmd: McpServerCommand
): { status: 'wired' | 'already' | 'failed'; detail: string } {
  let current = '';
  if (existsSync(configPath)) {
    try {
      current = readFileSync(configPath, 'utf8');
    } catch (err) {
      return { status: 'failed', detail: `cannot read ${configPath}: ${(err as Error).message}` };
    }
  }
  if (RELAY_MCP_ENTRY.test(current)) {
    return { status: 'already', detail: configPath };
  }
  const argList = cmd.args.map(a => JSON.stringify(a)).join(', ');
  const block =
    '\n# Added by `relay init` — Relay memory MCP server\n' +
    '[mcp_servers.relay]\n' +
    `command = ${JSON.stringify(cmd.command)}\n` +
    `args = [${argList}]\n`;
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  writeFileSync(configPath, current + sep + block);
  return { status: 'wired', detail: configPath };
}

export function claudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  const appData = process.env['APPDATA'];
  if (process.platform === 'win32' && appData) {
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function cursorConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json');
}

function codexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

function wireClaudeCode(cmd: McpServerCommand): McpWireResult {
  const probe = spawnSync('claude', ['mcp', 'get', 'relay'], { encoding: 'utf8', timeout: 15000 });
  if (probe.error) {
    return { client: 'claude-code', status: 'not-detected', detail: 'claude CLI not on PATH' };
  }
  // `claude mcp get` exits 0 either way — absence is signalled in the text.
  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  if (!/No MCP server named/i.test(out) && probe.status === 0) {
    return { client: 'claude-code', status: 'already', detail: 'registered (claude mcp get relay)' };
  }
  const add = spawnSync(
    'claude',
    ['mcp', 'add', '--scope', 'user', 'relay', '--', cmd.command, ...cmd.args],
    { encoding: 'utf8', timeout: 20000 }
  );
  if (add.error || add.status !== 0) {
    const reason = (add.stderr || add.error?.message || 'claude mcp add failed').trim();
    return { client: 'claude-code', status: 'failed', detail: reason.slice(0, 200) };
  }
  return { client: 'claude-code', status: 'wired', detail: 'claude mcp add --scope user relay' };
}

/** Register relay with every detected client. Idempotent. */
export function wireMcpClients(): McpWireResult[] {
  const cmd = resolveRelayMcpCommand();
  const results: McpWireResult[] = [];

  results.push(wireClaudeCode(cmd));

  const desktop = claudeDesktopConfigPath();
  results.push(
    existsSync(dirname(desktop))
      ? { client: 'claude-desktop', ...upsertMcpJsonEntry(desktop, cmd) }
      : { client: 'claude-desktop', status: 'not-detected', detail: 'app config dir absent' }
  );

  const cursor = cursorConfigPath();
  results.push(
    existsSync(dirname(cursor))
      ? { client: 'cursor', ...upsertMcpJsonEntry(cursor, cmd) }
      : { client: 'cursor', status: 'not-detected', detail: '~/.cursor absent' }
  );

  const codex = codexConfigPath();
  results.push(
    existsSync(dirname(codex))
      ? { client: 'codex', ...upsertCodexMcpEntry(codex, cmd) }
      : { client: 'codex', status: 'not-detected', detail: '~/.codex absent' }
  );

  return results;
}

function probeJsonRegistration(client: McpClient, configPath: string): McpProbeResult {
  if (!existsSync(dirname(configPath))) {
    return { client, registered: null, detail: 'client not detected' };
  }
  if (!existsSync(configPath)) {
    return { client, registered: false, detail: `no relay entry (${configPath} absent) — run relay init` };
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return parsed?.mcpServers && 'relay' in parsed.mcpServers
      ? { client, registered: true, detail: configPath }
      : { client, registered: false, detail: `no relay entry in ${configPath} — run relay init` };
  } catch {
    return { client, registered: false, detail: `${configPath} unreadable/invalid` };
  }
}

/** Read-only registration status for `relay doctor`. Never writes. */
export function probeMcpClients(): McpProbeResult[] {
  const results: McpProbeResult[] = [];

  const probe = spawnSync('claude', ['mcp', 'get', 'relay'], { encoding: 'utf8', timeout: 15000 });
  if (probe.error) {
    results.push({ client: 'claude-code', registered: null, detail: 'claude CLI not on PATH' });
  } else {
    const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
    const registered = probe.status === 0 && !/No MCP server named/i.test(out);
    results.push({
      client: 'claude-code',
      registered,
      detail: registered ? 'registered' : 'not registered — run relay init',
    });
  }

  results.push(probeJsonRegistration('claude-desktop', claudeDesktopConfigPath()));
  results.push(probeJsonRegistration('cursor', cursorConfigPath()));

  const codex = codexConfigPath();
  if (!existsSync(dirname(codex))) {
    results.push({ client: 'codex', registered: null, detail: 'client not detected' });
  } else if (!existsSync(codex)) {
    results.push({ client: 'codex', registered: false, detail: `no relay entry (${codex} absent) — run relay init` });
  } else {
    try {
      const registered = RELAY_MCP_ENTRY.test(readFileSync(codex, 'utf8'));
      results.push({
        client: 'codex',
        registered,
        detail: registered ? codex : `no [mcp_servers.relay] in ${codex} — run relay init`,
      });
    } catch {
      results.push({ client: 'codex', registered: false, detail: `${codex} unreadable` });
    }
  }

  return results;
}

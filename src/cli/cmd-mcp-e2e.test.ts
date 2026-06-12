/**
 * Phase 9 (REQ-MCP-01/06 + pause sentinel) — protocol e2e against the real binary.
 *
 * Spawns `node dist/cli.js mcp serve` with an isolated HOME + file-backed DB,
 * speaks raw newline-delimited JSON-RPC over stdio, and asserts:
 *   - initialize handshake (serverInfo.name === 'relay')
 *   - tools/list over the wire
 *   - remember → recall round-trip persists to the shared DB file
 *   - read audit row lands with read_source='mcp' (REQ-MCP-06)
 *   - pause sentinel (~/.relay/paused) blocks recall (privacy off-switch)
 *   - `mcp serve --selfcheck` exits 0
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'cli.js'); // dist layout: dist/cli/cmd-mcp-e2e.test.js → dist/cli.js

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class McpProcess {
  private child: ChildProcess;
  private buffer = '';
  private pending = new Map<number, (msg: JsonRpcMessage) => void>();
  private nextId = 1;

  constructor(env: Record<string, string | undefined>) {
    this.child = spawn(process.execPath, [CLI, 'mcp', 'serve'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }

  request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id ${id})`));
      }, 15_000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.child.stdin!.write(line);
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
  }

  kill(): void {
    this.child.kill('SIGTERM');
  }
}

function textPayload(msg: JsonRpcMessage): Record<string, unknown> {
  const content = (msg.result as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content[0]!.type, 'text');
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe('mcp serve protocol e2e', () => {
  test('handshake, remember→recall round-trip, audit row, pause sentinel', async () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-mcp-e2e-'));
    const dbPath = join(home, 'relay.db');
    const workdir = join(home, 'proj');
    mkdirSync(workdir, { recursive: true });

    const proc = new McpProcess({
      HOME: home,
      RELAY_DB_PATH: dbPath,
      RELAY_MCP_DEFAULT_WORKDIR: undefined,
      RELAY_MEMORY_ALLOWED_WORKDIRS: undefined,
      RELAY_EMBEDDING_MODEL: undefined,
    });

    try {
      const init = await proc.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0' },
      });
      assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
      const serverInfo = init.result!['serverInfo'] as { name: string };
      assert.equal(serverInfo.name, 'relay');
      proc.notify('notifications/initialized');

      const list = await proc.request('tools/list', {});
      const tools = (list.result!['tools'] as Array<{ name: string }>).map(t => t.name);
      assert.ok(tools.includes('relay_recall') && tools.includes('relay_remember'));

      const marker = `e2e-roundtrip-${Date.now()}`;
      const wrote = await proc.request('tools/call', {
        name: 'relay_remember',
        arguments: { content: `${marker} body`, memory_type: 'lesson', workdir },
      });
      const writePayload = textPayload(wrote);
      assert.ok(writePayload['memory_id'], 'memory_id returned over the wire');

      const recalled = await proc.request('tools/call', {
        name: 'relay_recall',
        arguments: { query: marker, workdir, min_trust: 'unverified' },
      });
      const recallPayload = textPayload(recalled);
      const hits = (recallPayload['memories'] as Array<{ content: string }>).filter(
        m => m.content.includes(marker)
      );
      assert.equal(hits.length, 1, 'write visible through a separate process via shared DB file');

      // REQ-MCP-06 — the read must be audited with source 'mcp'.
      const db = new Database(dbPath, { readonly: true });
      const audit = db.prepare(
        "SELECT COUNT(*) AS n FROM memory_reads WHERE read_source = 'mcp'"
      ).get() as { n: number };
      db.close();
      assert.ok(audit.n >= 1, 'memory_reads carries read_source=mcp rows');

      // Pause sentinel — the documented off-switch must hold for MCP recall.
      mkdirSync(join(home, '.relay'), { recursive: true });
      writeFileSync(
        join(home, '.relay', 'paused'),
        JSON.stringify({ paused_at: Date.now(), expires_at: null })
      );
      const paused = await proc.request('tools/call', {
        name: 'relay_recall',
        arguments: { query: marker, workdir, min_trust: 'unverified' },
      });
      const pausedPayload = textPayload(paused);
      assert.equal(pausedPayload['paused'], true, 'pause sentinel must block MCP recall');
    } finally {
      proc.kill();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('mcp serve --selfcheck exits 0', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-mcp-self-'));
    try {
      const result = spawnSync(process.execPath, [CLI, 'mcp', 'serve', '--selfcheck'], {
        env: { ...process.env, HOME: home, RELAY_DB_PATH: join(home, 'relay.db') },
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(result.status, 0, `selfcheck failed: ${result.stdout} ${result.stderr}`);
      assert.match(result.stdout, /"ok":\s*true/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

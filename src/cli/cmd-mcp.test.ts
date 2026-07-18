/**
 * Phase 9 / Plan 04 — `relay mcp`: the CLI entry for the stdio MCP server.
 *
 * The operational landmine of stdio MCP is a stray stdout write corrupting
 * the protocol framing (T-09-11). Test 1 is the guard: with a fake server
 * whose transport writes one framed protocol message to ITS wire and the
 * command emitting its human diagnostic, NOTHING lands on io.stdout — the
 * diagnostic goes to stderr, the protocol stays on the transport's channel.
 *
 * The fake start function stands in for startMcpServer (server.test.ts owns
 * the server assembly contract); these tests own the command-layer contract:
 * stdout discipline, clean exit, signal-driven graceful shutdown, and the
 * additive-only CLI surface.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { executeMcpCommand } from './cmd-mcp.js';
import type { McpStartFn } from './cmd-mcp.js';
import type { McpServerHandle, StartMcpServerDeps } from '../mcp/server.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd: '/tmp', stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

interface FakeServerKit {
  start: McpStartFn;
  wire: string[];
  startCalls: StartMcpServerDeps[];
  shutdownCalls: () => number;
  /** Simulate the client disconnecting (resolves the handle's closed promise). */
  disconnect: () => void;
}

function makeFakeServer(opts: { shutdownError?: Error } = {}): FakeServerKit {
  const wire: string[] = [];
  const startCalls: StartMcpServerDeps[] = [];
  let shutdowns = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const handle: McpServerHandle = {
    server: {},
    toolNames: ['relay_memory_recall', 'relay_memory_save'],
    closed,
    shutdown: async () => {
      shutdowns++;
      // Mirrors the real handle contract (review fix 6): closed ALWAYS
      // resolves; a real close failure travels via the rejection.
      resolveClosed();
      if (opts.shutdownError) throw opts.shutdownError;
    },
  };
  const start: McpStartFn = async (deps?: StartMcpServerDeps) => {
    startCalls.push(deps ?? {});
    // The SDK-owned transport speaks the protocol on ITS channel — one framed
    // message stands in for the initialize handshake. This must never appear
    // on (or be mixed into) the CLI io's stdout.
    wire.push(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }));
    return handle;
  };
  return { start, wire, startCalls, shutdownCalls: () => shutdowns, disconnect: resolveClosed };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('executeMcpCommand — stdout discipline (Test 1)', () => {
  test('diagnostics land on stderr; io.stdout gets NOTHING; protocol stays on the wire', async () => {
    const { io, stdout, stderr } = makeIO();
    const fake = makeFakeServer();

    const pending = executeMcpCommand({ version: '1.2.3', start: fake.start }, io);
    await tick();
    fake.disconnect();
    const code = await pending;

    assert.strictEqual(code, 0);
    assert.strictEqual(stdout.length, 0, `io.stdout must stay protocol-only/empty, got: ${JSON.stringify(stdout)}`);
    const errText = stderr.join('');
    assert.match(errText, /relay mcp/, 'human diagnostic must appear on stderr');
    assert.match(errText, /relay_memory_recall/, 'diagnostic names the registered tools');
    assert.match(errText, /relay_memory_save/, 'diagnostic names the registered tools');
    assert.strictEqual(fake.wire.length, 1, 'the protocol frame went to the transport wire');
    assert.ok(!errText.includes('"jsonrpc"'), 'protocol frames never leak into diagnostics');
  });
});

describe('executeMcpCommand — start + clean exit (Test 2)', () => {
  test('starts the server once with the CLI version and returns 0 on graceful shutdown', async () => {
    const { io } = makeIO();
    const fake = makeFakeServer();

    const pending = executeMcpCommand({ version: '0.0.7-test', start: fake.start }, io);
    await tick();
    assert.strictEqual(fake.startCalls.length, 1, 'startMcpServer invoked exactly once');
    assert.strictEqual(fake.startCalls[0]!.version, '0.0.7-test', 'CLI version flows to the server');
    fake.disconnect();
    const code = await pending;
    assert.strictEqual(code, 0);
  });

  test('a start failure reports to stderr and exits 1 — stdout untouched', async () => {
    const { io, stdout, stderr } = makeIO();
    const start: McpStartFn = async () => {
      throw new Error('MCP_SDK_UNRESOLVED: synthetic probe failure');
    };
    const code = await executeMcpCommand({ version: '1.2.3', start }, io);
    assert.strictEqual(code, 1);
    assert.strictEqual(stdout.length, 0);
    assert.match(stderr.join(''), /MCP_SDK_UNRESOLVED: synthetic probe failure/);
  });
});

describe('executeMcpCommand — SIGINT/SIGTERM graceful shutdown', () => {
  test('SIGINT triggers shutdown, exits 0, and removes its listeners', async () => {
    const { io } = makeIO();
    const fake = makeFakeServer();
    const signals = new EventEmitter();

    const pending = executeMcpCommand({ version: '1.2.3', start: fake.start, signals }, io);
    await tick();
    assert.strictEqual(signals.listenerCount('SIGINT'), 1);
    assert.strictEqual(signals.listenerCount('SIGTERM'), 1);

    signals.emit('SIGINT');
    const code = await pending;
    assert.strictEqual(code, 0);
    assert.strictEqual(fake.shutdownCalls(), 1, 'signal path goes through handle.shutdown()');
    assert.strictEqual(signals.listenerCount('SIGINT'), 0, 'no dangling SIGINT listener');
    assert.strictEqual(signals.listenerCount('SIGTERM'), 0, 'no dangling SIGTERM listener');
  });

  test('SIGTERM triggers the same graceful path', async () => {
    const { io } = makeIO();
    const fake = makeFakeServer();
    const signals = new EventEmitter();

    const pending = executeMcpCommand({ version: '1.2.3', start: fake.start, signals }, io);
    await tick();
    signals.emit('SIGTERM');
    const code = await pending;
    assert.strictEqual(code, 0);
    assert.strictEqual(fake.shutdownCalls(), 1);
    assert.strictEqual(signals.listenerCount('SIGTERM'), 0);
  });

  test('a failing shutdown surfaces on stderr and exits 1 — never silently swallowed (review fix 6)', async () => {
    const { io, stdout, stderr } = makeIO();
    const fake = makeFakeServer({ shutdownError: new Error('EPIPE: stream destroyed') });
    const signals = new EventEmitter();

    const pending = executeMcpCommand({ version: '1.2.3', start: fake.start, signals }, io);
    await tick();
    signals.emit('SIGINT');
    const code = await pending;

    assert.strictEqual(code, 1, 'a real close failure must be a nonzero exit');
    assert.strictEqual(stdout.length, 0, 'stdout stays protocol-only even on failure');
    const errText = stderr.join('');
    assert.match(errText, /shutdown failed/);
    assert.match(errText, /EPIPE: stream destroyed/);
    assert.strictEqual(signals.listenerCount('SIGINT'), 0, 'listeners still removed');
    assert.strictEqual(signals.listenerCount('SIGTERM'), 0);
  });

  test('a second signal during a failing shutdown does not double-report (review fix 6)', async () => {
    const { io, stderr } = makeIO();
    const fake = makeFakeServer({ shutdownError: new Error('EPIPE: stream destroyed') });
    const signals = new EventEmitter();

    const pending = executeMcpCommand({ version: '1.2.3', start: fake.start, signals }, io);
    await tick();
    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    const code = await pending;

    assert.strictEqual(code, 1);
    const reports = stderr.join('').match(/shutdown failed/g) ?? [];
    assert.strictEqual(reports.length, 1, 'exactly one failure report');
  });
});

describe('relay CLI surface — additive only (Test 3)', () => {
  const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

  test('--help lists mcp AND keeps every prior section', () => {
    const res = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /relay mcp/, 'help must list the new mcp command');
    for (const section of [
      'MEMORY COMMANDS',
      'CONTEXT COMMANDS',
      'DELEGATION COMMANDS',
      'SESSION COMMANDS',
      'relay run <task>',
      'relay parallel',
      'relay providers',
      'relay tui',
      'relay memory remember <content>',
    ]) {
      assert.ok(res.stdout.includes(section), `help must keep: ${section}`);
    }
  });

  test('version still prints the version', () => {
    const res = spawnSync(process.execPath, [cliPath, 'version'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /^relay v\d+\.\d+\.\d+/);
  });

  test('unknown commands still return the unknown-command error', () => {
    const res = spawnSync(process.execPath, [cliPath, 'definitely-not-a-command'], {
      encoding: 'utf8',
    });
    assert.strictEqual(res.status, 2);
    assert.match(res.stderr, /unknown command/);
  });
});

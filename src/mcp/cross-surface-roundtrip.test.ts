/**
 * The product promise, as a test: one store, reachable from every surface.
 * A memory written through the real CLI binary (separate process) must be
 * recallable through the MCP tool handler (this process), and a memory saved
 * through the MCP handler must be recallable through the CLI binary.
 */
import { test, describe, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMemoryMcpTools } from './tools-memory.js';
import { closeDb } from '../runtime/store/db.js';

const WORKDIR = '/cross-surface-test';
const dbDir = mkdtempSync(join(tmpdir(), 'relay-cross-surface-'));
const dbPath = join(dbDir, 'shared.db');
const cliJs = join(dirname(dirname(fileURLToPath(import.meta.url))), 'cli.js');

const cliEnv = {
  ...process.env,
  RELAY_DB_PATH: dbPath,
};
delete (cliEnv as Record<string, unknown>)['RELAY_MEMORY_ALLOWED_WORKDIRS'];
delete (cliEnv as Record<string, unknown>)['RELAY_DB_URL'];

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliJs, ...args], { encoding: 'utf8', env: cliEnv, timeout: 30000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('cross-surface memory roundtrip (CLI process ↔ MCP handler)', () => {
  // The MCP handlers in THIS process must read the same file the CLI wrote.
  process.env['RELAY_DB_PATH'] = dbPath;
  delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
  delete process.env['RELAY_DB_URL'];
  const [recallTool, saveTool] = buildMemoryMcpTools();

  after(() => {
    closeDb();
    rmSync(dbDir, { recursive: true, force: true });
  });

  test('CLI write → MCP recall', async () => {
    const w = cli('memory', 'remember', 'the deploy password lives in vault seven', '--type', 'fact', '--workdir', WORKDIR);
    assert.equal(w.status, 0, `cli remember failed: ${w.stderr}`);

    const res = await recallTool!.handler({
      query: 'vault seven',
      workdir: WORKDIR,
      token_budget: 2000,
    } as never);
    const payload = JSON.parse((res as { content: ReadonlyArray<{ text: string }> }).content[0]!.text) as {
      memories: Array<{ content: string }>;
    };
    assert.ok(
      payload.memories.some(m => m.content.includes('vault seven')),
      `CLI-written memory not visible through MCP recall: ${JSON.stringify(payload)}`
    );
  });

  test('MCP save → CLI recall', async () => {
    const res = await saveTool!.handler({
      content: 'the staging cluster is named osprey',
      memory_type: 'fact',
      workdir: WORKDIR,
    } as never);
    const saved = JSON.parse((res as { content: ReadonlyArray<{ text: string }> }).content[0]!.text) as {
      memory_id?: string;
    };
    assert.ok(saved.memory_id, `MCP save failed: ${JSON.stringify(saved)}`);

    const r = cli('memory', 'recall', '--query', 'staging cluster osprey', '--workdir', WORKDIR);
    assert.equal(r.status, 0, `cli recall failed: ${r.stderr}`);
    assert.match(r.stdout, /osprey/, `MCP-saved memory not visible through CLI recall: ${r.stdout}`);
  });
});

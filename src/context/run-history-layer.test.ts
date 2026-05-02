import { describe, test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunHistoryLayerProvider } from './run-history-layer.js';
import { getRunStore } from '../runtime/store/run-store.js';

let runCounter = 0;
const makeRun = (
  workdir: string,
  overrides: Partial<{
    run_id: string;
    status: string;
    queued_at: number;
    task_excerpt: string;
  }> = {},
) => ({
  run_id: `run-${++runCounter}`,
  provider: 'lmstudio',
  model: null,
  workdir,
  status: 'success',
  queued_at: Date.now(),
  ...overrides,
});

describe('run-history-layer', () => {
  let tmpDir: string;

  before(() => {
    process.env['RELAY_DB_PATH'] = ':memory:';
    tmpDir = mkdtempSync(join(tmpdir(), 'relay-rhl-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['RELAY_RUN_HISTORY_LAYERS'];
    delete process.env['RELAY_SESSION_ID'];
    delete process.env['RELAY_SESSION_WINDOW_MS'];
  });

  test('RELAY_RUN_HISTORY_LAYERS not set => load() returns null', async () => {
    delete process.env['RELAY_RUN_HISTORY_LAYERS'];
    const provider = createRunHistoryLayerProvider();
    const result = await provider.load({ workdir: '/some/dir' });
    assert.strictEqual(result, null);
  });

  test('no runs for workdir => returns null', async () => {
    process.env['RELAY_RUN_HISTORY_LAYERS'] = '1';
    getRunStore().create(makeRun('/other-dir'));
    const provider = createRunHistoryLayerProvider();
    const result = await provider.load({ workdir: '/my-project' });
    assert.strictEqual(result, null);
  });

  test('run exists for workdir => returns layer with excerpt in content', async () => {
    process.env['RELAY_RUN_HISTORY_LAYERS'] = '1';
    getRunStore().create(makeRun(tmpDir, { task_excerpt: 'fix auth bug' }));
    const provider = createRunHistoryLayerProvider();
    const result = await provider.load({ workdir: tmpDir });
    assert.ok(result !== null, 'should return a layer');
    assert.strictEqual(result.id, 'run_history');
    assert.ok(result.content.includes('fix auth bug'));
  });

  test('runs from different workdir not included in content', async () => {
    process.env['RELAY_RUN_HISTORY_LAYERS'] = '1';
    getRunStore().create(makeRun(tmpDir, { task_excerpt: 'correct task' }));
    getRunStore().create(makeRun('/other-project', { task_excerpt: 'wrong task' }));
    const provider = createRunHistoryLayerProvider();
    const result = await provider.load({ workdir: tmpDir });
    assert.ok(result !== null);
    assert.ok(result.content.includes('correct task'));
    assert.ok(!result.content.includes('wrong task'));
  });

  test('only MAX_DISPLAY_RUNS=5 runs shown when 6 inserted', async () => {
    process.env['RELAY_RUN_HISTORY_LAYERS'] = '1';
    for (let i = 1; i <= 6; i++) {
      getRunStore().create(makeRun(tmpDir, { task_excerpt: `task-${i}` }));
    }
    const provider = createRunHistoryLayerProvider();
    const result = await provider.load({ workdir: tmpDir });
    assert.ok(result !== null);
    // count "Run " occurrences — each formatted line starts with "Run <shortId>:"
    const matches = result.content.match(/^Run /gm) ?? [];
    assert.strictEqual(matches.length, 5);
  });

  test('RELAY_SESSION_ID set: run older than session window is excluded', async () => {
    process.env['RELAY_RUN_HISTORY_LAYERS'] = '1';
    process.env['RELAY_SESSION_ID'] = 'sess-abc';
    process.env['RELAY_SESSION_WINDOW_MS'] = '60000';
    const now = Date.now();
    // old run: 2 minutes ago, outside 60s window
    getRunStore().create(makeRun(tmpDir, { task_excerpt: 'old-task', queued_at: now - 120000 }));
    // recent run: now, inside window
    getRunStore().create(makeRun(tmpDir, { task_excerpt: 'recent-task', queued_at: now }));
    const provider = createRunHistoryLayerProvider();
    const result = await provider.load({ workdir: tmpDir });
    assert.ok(result !== null);
    assert.ok(result.content.includes('recent-task'));
    assert.ok(!result.content.includes('old-task'));
    delete process.env['RELAY_SESSION_ID'];
    delete process.env['RELAY_SESSION_WINDOW_MS'];
  });
});

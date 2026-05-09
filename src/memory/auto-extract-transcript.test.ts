process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRecentTranscriptWindow,
  DEFAULT_WINDOW_BYTES,
} from './auto-extract-transcript.js';

describe('loadRecentTranscriptWindow', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-transcript-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('missing file → empty window (does not throw on stat)', () => {
    const path = join(dir, 'nope.jsonl');
    const win = loadRecentTranscriptWindow(path, 1024);
    assert.strictEqual(win.jsonl, '');
    assert.strictEqual(win.turnsRead, 0);
    assert.strictEqual(win.bytes, 0);
  });

  test('empty file → empty window', async () => {
    const path = join(dir, 'empty.jsonl');
    await writeFile(path, '', 'utf8');
    const win = loadRecentTranscriptWindow(path, 1024);
    assert.strictEqual(win.turnsRead, 0);
    assert.strictEqual(win.bytes, 0);
  });

  test('small file under budget → all turns returned in chronological order', async () => {
    const path = join(dir, 'small.jsonl');
    const lines = [
      JSON.stringify({ role: 'user', text: 'hello' }),
      JSON.stringify({ role: 'assistant', text: 'hi' }),
      JSON.stringify({ role: 'user', text: 'bye' }),
    ];
    await writeFile(path, lines.join('\n') + '\n', 'utf8');

    const win = loadRecentTranscriptWindow(path, 4096);
    assert.strictEqual(win.turnsRead, 3);
    const out = win.jsonl.split('\n');
    assert.strictEqual(out.length, 3);
    // Chronological order preserved
    assert.match(out[0]!, /"hello"/);
    assert.match(out[1]!, /"hi"/);
    assert.match(out[2]!, /"bye"/);
  });

  test('budget cap → only the most recent turns', async () => {
    const path = join(dir, 'big.jsonl');
    // Each line ~50 bytes; write 100 of them.
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({ idx: i, text: `turn-${i.toString().padStart(3, '0')}` }));
    }
    await writeFile(path, lines.join('\n') + '\n', 'utf8');

    // Budget that fits ~5 lines.
    const win = loadRecentTranscriptWindow(path, 250);
    assert.ok(win.turnsRead > 0, 'must read at least one turn');
    assert.ok(win.turnsRead < 100, 'must not read all turns');
    assert.ok(win.bytes <= 250 + 60, 'bytes must be within budget + one line slack');
    // The LAST line in the output must be the LAST line of the file.
    const out = win.jsonl.split('\n');
    assert.match(out[out.length - 1]!, /"turn-099"/);
  });

  test('truncates oversized tool result body inline (toolUseResult.stdout)', async () => {
    const path = join(dir, 'tool.jsonl');
    const huge = 'x'.repeat(8 * 1024); // 8 KB > 4 KB cap
    const line = JSON.stringify({
      type: 'tool_result',
      toolUseResult: { stdout: huge },
    });
    await writeFile(path, line + '\n', 'utf8');

    const win = loadRecentTranscriptWindow(path, 32 * 1024);
    assert.strictEqual(win.turnsRead, 1);
    assert.match(win.jsonl, /\[truncated tool result, 8192 bytes\]/);
    // The original payload must NOT appear in the output.
    assert.ok(!win.jsonl.includes('xxxxxxxxxxxxxxxx'), 'huge body must be replaced, not just shortened');
  });

  test('truncates oversized text inside content array (message.content[].text)', async () => {
    const path = join(dir, 'msg.jsonl');
    const huge = 'A'.repeat(5000);
    const line = JSON.stringify({
      message: { content: [{ type: 'text', text: huge }] },
    });
    await writeFile(path, line + '\n', 'utf8');

    const win = loadRecentTranscriptWindow(path, 32 * 1024);
    assert.match(win.jsonl, /\[truncated tool result, 5000 bytes\]/);
    assert.ok(!win.jsonl.includes('AAAAAAAAAAAAAAAA'), 'huge text must be replaced');
  });

  test('non-JSON lines pass through untouched (within budget)', async () => {
    const path = join(dir, 'mixed.jsonl');
    const lines = [
      'not json at all',
      JSON.stringify({ role: 'user', text: 'hi' }),
      '{ also not json',
    ];
    await writeFile(path, lines.join('\n') + '\n', 'utf8');

    const win = loadRecentTranscriptWindow(path, 4096);
    assert.strictEqual(win.turnsRead, 3);
    assert.match(win.jsonl, /not json at all/);
    assert.match(win.jsonl, /also not json/);
  });

  test('maxBytes <= 0 → empty window', () => {
    const path = join(dir, 'never-read.jsonl');
    const win = loadRecentTranscriptWindow(path, 0);
    assert.strictEqual(win.turnsRead, 0);
    assert.strictEqual(win.bytes, 0);
  });

  test('DEFAULT_WINDOW_BYTES is 32 KB', () => {
    assert.strictEqual(DEFAULT_WINDOW_BYTES, 32 * 1024);
  });

  test('always returns at least the last line even if it exceeds budget', async () => {
    const path = join(dir, 'one-big-line.jsonl');
    // One line larger than the budget.
    const big = JSON.stringify({ text: 'z'.repeat(2000) });
    await writeFile(path, big + '\n', 'utf8');

    const win = loadRecentTranscriptWindow(path, 100);
    assert.strictEqual(win.turnsRead, 1, 'must keep the trailing line even if oversized');
    assert.ok(win.bytes > 100, 'returned bytes can exceed budget for a single trailing line');
  });
});

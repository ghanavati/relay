process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeMemoryToRulesCommand } from './cmd-memory-ops.js';
import { MemoryStore } from '../memory/memory-store.js';
import { getDb } from '../runtime/store/db.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(cwd: string): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd, stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

describe('executeMemoryToRulesCommand — dedup on repeat invocations', () => {
  let tmp: string;

  beforeEach(async () => {
    // Isolate from other test files using shared :memory: DB
    getDb().prepare('DELETE FROM memories').run();
    tmp = await mkdtemp(join(tmpdir(), 'relay-to-rules-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('first call appends entry, returns 0', async () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'always run npm test before commit',
      memory_type: 'lesson',
    });

    const cap = makeIO(tmp);
    const rulesFile = 'CLAUDE.md';
    const code = await executeMemoryToRulesCommand(
      { memoryId: id, rulesFile, json: false },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);
    const fileContent = await readFile(join(tmp, rulesFile), 'utf8');
    assert.match(fileContent, /## Promoted Memory Rules/);
    assert.match(fileContent, /\[lesson\] always run npm test before commit/);
    // Output indicates appended (not "already present")
    const out = cap.stdout.join('');
    assert.match(out, /Appended to/);
  });

  test('second call with SAME memory does NOT duplicate, output says "already present"', async () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'never use force push to main',
      memory_type: 'lesson',
    });

    const rulesFile = 'CLAUDE.md';
    // First call
    const cap1 = makeIO(tmp);
    const code1 = await executeMemoryToRulesCommand(
      { memoryId: id, rulesFile, json: false },
      cap1.io,
      tmp
    );
    assert.strictEqual(code1, 0);

    // Second call — should be idempotent
    const cap2 = makeIO(tmp);
    const code2 = await executeMemoryToRulesCommand(
      { memoryId: id, rulesFile, json: false },
      cap2.io,
      tmp
    );
    assert.strictEqual(code2, 0);

    const fileContent = await readFile(join(tmp, rulesFile), 'utf8');
    // Count occurrences of the entry — must be exactly 1
    const entryRe = /\[lesson\] never use force push to main/g;
    const matches = fileContent.match(entryRe) ?? [];
    assert.strictEqual(matches.length, 1, 'entry must not be duplicated on repeat invocation');

    // Output says "already present"
    const out = cap2.stdout.join('');
    assert.match(out, /Already present|already present/);
  });

  test('JSON mode reports skipped: already present on second call', async () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'avoid sync fs in hot paths',
      memory_type: 'lesson',
    });
    const rulesFile = 'CLAUDE.md';
    const cap1 = makeIO(tmp);
    await executeMemoryToRulesCommand({ memoryId: id, rulesFile, json: true }, cap1.io, tmp);

    const cap2 = makeIO(tmp);
    const code2 = await executeMemoryToRulesCommand(
      { memoryId: id, rulesFile, json: true },
      cap2.io,
      tmp
    );
    assert.strictEqual(code2, 0);
    const out = cap2.stdout.join('').trim();
    const parsed = JSON.parse(out) as { promoted: string; rules_file: string; skipped?: string };
    assert.strictEqual(parsed.promoted, id);
    assert.strictEqual(parsed.skipped, 'already present');
  });

  test('new memory + existing section appends inside section', async () => {
    const store = new MemoryStore();
    const id1 = store.remember({
      content: 'first lesson learned',
      memory_type: 'lesson',
    });
    const id2 = store.remember({
      content: 'second lesson learned',
      memory_type: 'lesson',
    });

    const rulesFile = 'CLAUDE.md';
    // Pre-write a file with an existing section + tail content
    await writeFile(
      join(tmp, rulesFile),
      'Header\n\n## Promoted Memory Rules\n\n- [lesson] preexisting entry\n\n## Other Section\n\nfollow-up content\n',
      'utf8'
    );

    // Add memory id1 — should land inside existing section, before the tail
    const cap1 = makeIO(tmp);
    const code1 = await executeMemoryToRulesCommand(
      { memoryId: id1, rulesFile, json: false },
      cap1.io,
      tmp
    );
    assert.strictEqual(code1, 0);

    let fileContent = await readFile(join(tmp, rulesFile), 'utf8');
    // The section header still exists
    assert.match(fileContent, /## Promoted Memory Rules/);
    // The new entry is after the preexisting one and BEFORE "## Other Section"
    const newEntryIdx = fileContent.indexOf('first lesson learned');
    const otherSectionIdx = fileContent.indexOf('## Other Section');
    assert.ok(newEntryIdx > 0, 'new entry must be present');
    assert.ok(otherSectionIdx > 0, 'tail section must remain');
    assert.ok(newEntryIdx < otherSectionIdx, 'new entry must land before the tail section');

    // Add second new memory — same section, both entries present
    const cap2 = makeIO(tmp);
    const code2 = await executeMemoryToRulesCommand(
      { memoryId: id2, rulesFile, json: false },
      cap2.io,
      tmp
    );
    assert.strictEqual(code2, 0);
    fileContent = await readFile(join(tmp, rulesFile), 'utf8');
    assert.match(fileContent, /first lesson learned/);
    assert.match(fileContent, /second lesson learned/);
  });

  test('new memory + no section creates section + entry', async () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'fresh rule for new file',
      memory_type: 'decision',
    });

    const rulesFile = 'NEW-RULES.md';
    // No file exists yet
    const cap = makeIO(tmp);
    const code = await executeMemoryToRulesCommand(
      { memoryId: id, rulesFile, json: false },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);
    const fileContent = await readFile(join(tmp, rulesFile), 'utf8');
    assert.match(fileContent, /## Promoted Memory Rules/);
    assert.match(fileContent, /\[decision\] fresh rule for new file/);
  });

  test('new memory + existing file without section creates the section at end', async () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'append to existing file',
      memory_type: 'fact',
    });

    const rulesFile = 'CLAUDE.md';
    await writeFile(join(tmp, rulesFile), '# Existing content\n\nNo section yet.\n', 'utf8');

    const cap = makeIO(tmp);
    const code = await executeMemoryToRulesCommand(
      { memoryId: id, rulesFile, json: false },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);
    const fileContent = await readFile(join(tmp, rulesFile), 'utf8');
    // Original content preserved
    assert.match(fileContent, /Existing content/);
    assert.match(fileContent, /No section yet\./);
    // Section + entry appended
    assert.match(fileContent, /## Promoted Memory Rules/);
    assert.match(fileContent, /\[fact\] append to existing file/);
  });

  test('memory not found → returns 1 with error', async () => {
    const cap = makeIO(tmp);
    const code = await executeMemoryToRulesCommand(
      { memoryId: 'nonexistent-memory-id', rulesFile: 'CLAUDE.md', json: false },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 1);
    const err = cap.stderr.join('');
    assert.match(err, /not found/);
  });

  test('memory not found in JSON mode → exits 1 with error JSON', async () => {
    const cap = makeIO(tmp);
    const code = await executeMemoryToRulesCommand(
      { memoryId: 'missing-id', rulesFile: 'CLAUDE.md', json: true },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 1);
    const out = cap.stdout.join('').trim();
    const parsed = JSON.parse(out) as { error: string; memory_id: string };
    assert.strictEqual(parsed.error, 'not_found');
    assert.strictEqual(parsed.memory_id, 'missing-id');
  });

  test('rules-file in nested subdir is created via mkdir recursive', async () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'rule to nested dir',
      memory_type: 'lesson',
    });

    const rulesFile = join('docs', 'rules', 'NESTED.md');
    const cap = makeIO(tmp);
    const code = await executeMemoryToRulesCommand(
      { memoryId: id, rulesFile, json: false },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);
    const fileContent = await readFile(join(tmp, rulesFile), 'utf8');
    assert.match(fileContent, /\[lesson\] rule to nested dir/);
  });
});

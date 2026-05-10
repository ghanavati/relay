process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeExportCommand } from './cmd-export.js';
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

interface SeededIds {
  readonly humanFact: string;
  readonly humanLessonPinned: string;
  readonly autoExtractLesson: string;
  readonly privateDecision: string;
  readonly unverifiedAuto: string;
}

/**
 * Seed five mixed memories. Two should pass --safe filter, three should be excluded.
 *
 * Survivors (--safe):
 *   - humanFact: human-source provisional, no excluded tags
 *   - humanLessonPinned: human-source pinned (trusted), no excluded tags
 *
 * Excluded:
 *   - autoExtractLesson: tag includes "auto-extract"
 *   - privateDecision: tag includes "private"
 *   - unverifiedAuto: trust_level = 'unverified' (auto-run-recorder, no successes, not pinned)
 */
async function seedMemories(workdir: string): Promise<SeededIds> {
  const store = new MemoryStore();

  const humanFact = store.remember({
    content: 'Project uses better-sqlite3 for storage',
    memory_type: 'fact',
    tags: ['storage', 'sqlite'],
    workdir,
    memory_source: 'human',
  });
  // Bump success_recall_count so trust_level becomes 'provisional' / 'trusted'
  store.markRecallSuccess([humanFact]);

  const humanLessonPinned = store.remember({
    content: 'Always run npm test before committing',
    memory_type: 'lesson',
    tags: ['ci', 'discipline'],
    pinned: true,
    workdir,
    memory_source: 'human',
  });

  const autoExtractLesson = store.remember({
    content: 'Auto-extracted: user dislikes verbose comments',
    memory_type: 'lesson',
    tags: ['auto-extract', 'preference'],
    workdir,
    memory_source: 'auto-run-recorder',
  });
  // Mark as a successful recall so trust_level isn't 'unverified' — proves the
  // exclusion is driven by the tag, not the trust filter.
  store.markRecallSuccess([autoExtractLesson]);

  const privateDecision = store.remember({
    content: 'Decided to use AGPL license',
    memory_type: 'decision',
    tags: ['private', 'legal'],
    workdir,
    memory_source: 'human',
  });
  store.markRecallSuccess([privateDecision]);

  const unverifiedAuto = store.remember({
    content: 'Auto-suggested: rename foo to bar',
    memory_type: 'fact',
    tags: ['suggestion'],
    workdir,
    memory_source: 'auto-run-recorder',
  });
  // Note: NOT markRecallSuccess — leaves success_recall_count at 0,
  // memory_source 'auto-run-recorder', not pinned → trust_level computes 'unverified'.

  // Sanity: confirm the unverified entry really has the trust_level we expect.
  // If a future migration changes the default, this test should fail loudly.
  const row = getDb().prepare('SELECT trust_level FROM memories WHERE memory_id = ?').get(unverifiedAuto) as { trust_level: string };
  assert.strictEqual(row.trust_level, 'unverified', 'seed for unverified-trust path is wrong');

  return { humanFact, humanLessonPinned, autoExtractLesson, privateDecision, unverifiedAuto };
}

describe('executeExportCommand — --safe filtering', () => {
  let tmp: string;

  beforeEach(async () => {
    getDb().prepare('DELETE FROM memories').run();
    tmp = await mkdtemp(join(tmpdir(), 'relay-export-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('JSON export with --safe excludes auto-extract, private, and unverified entries', async () => {
    const seeded = await seedMemories(tmp);
    const cap = makeIO(tmp);
    const code = await executeExportCommand(
      { safe: true, workdir: tmp, format: 'json', out: undefined, json: false },
      cap.io
    );
    assert.strictEqual(code, 0);

    const out = cap.stdout.join('');
    const parsed = JSON.parse(out) as {
      version: string;
      exported_at: number;
      workdir: string;
      memories: Array<{ memory_id: string; memory_type: string; tags: string[]; trust_level: string }>;
    };

    assert.strictEqual(parsed.version, '1.0');
    assert.strictEqual(parsed.workdir, tmp);
    assert.ok(typeof parsed.exported_at === 'number');
    assert.ok(parsed.exported_at > 0);

    const ids = parsed.memories.map(m => m.memory_id).sort();
    const expected = [seeded.humanFact, seeded.humanLessonPinned].sort();
    assert.deepStrictEqual(ids, expected, `expected exactly the two survivors, got: ${JSON.stringify(parsed.memories.map(m => ({ id: m.memory_id, tags: m.tags, trust: m.trust_level })))}`);

    // Excluded ids must NOT appear
    const idSet = new Set(parsed.memories.map(m => m.memory_id));
    assert.ok(!idSet.has(seeded.autoExtractLesson), 'auto-extract entry leaked through --safe');
    assert.ok(!idSet.has(seeded.privateDecision), 'private entry leaked through --safe');
    assert.ok(!idSet.has(seeded.unverifiedAuto), 'unverified entry leaked through --safe');

    // No exported memory carries the excluded tags or unverified trust
    for (const m of parsed.memories) {
      assert.ok(!m.tags.includes('auto-extract'), `auto-extract tag survived for ${m.memory_id}`);
      assert.ok(!m.tags.includes('private'), `private tag survived for ${m.memory_id}`);
      assert.notStrictEqual(m.trust_level, 'unverified', `unverified trust survived for ${m.memory_id}`);
    }
  });

  test('JSON export to --out file writes payload and reports count', async () => {
    await seedMemories(tmp);
    const outFile = join(tmp, 'export.json');
    const cap = makeIO(tmp);
    const code = await executeExportCommand(
      { safe: true, workdir: tmp, format: 'json', out: outFile, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);

    const summary = JSON.parse(cap.stdout.join('').trim()) as { ok: boolean; count: number; out: string; format: string };
    assert.strictEqual(summary.ok, true);
    assert.strictEqual(summary.count, 2);
    assert.strictEqual(summary.out, outFile);
    assert.strictEqual(summary.format, 'json');

    const fileContent = await readFile(outFile, 'utf8');
    const fromDisk = JSON.parse(fileContent) as { memories: unknown[] };
    assert.strictEqual(fromDisk.memories.length, 2);
  });

  test('Markdown export groups by memory_type and lists survivors', async () => {
    const seeded = await seedMemories(tmp);
    const cap = makeIO(tmp);
    const code = await executeExportCommand(
      { safe: true, workdir: tmp, format: 'md', out: undefined, json: false },
      cap.io
    );
    assert.strictEqual(code, 0);

    const out = cap.stdout.join('');
    // Header block
    assert.match(out, /^# Relay memory export/m);
    assert.match(out, /- exported_at: /);
    assert.match(out, /- workdir: /);
    assert.match(out, /- count: 2/);
    assert.match(out, /- version: 1\.0/);

    // Two type sections present (fact, lesson)
    assert.match(out, /^## fact$/m, 'fact group header missing');
    assert.match(out, /^## lesson$/m, 'lesson group header missing');

    // Surviving content present
    assert.match(out, /Project uses better-sqlite3 for storage/);
    assert.match(out, /Always run npm test before committing/);

    // Excluded content absent
    assert.ok(!out.includes('Auto-extracted: user dislikes verbose comments'), 'auto-extract content leaked into markdown');
    assert.ok(!out.includes('Decided to use AGPL license'), 'private content leaked into markdown');
    assert.ok(!out.includes('Auto-suggested: rename foo to bar'), 'unverified content leaked into markdown');

    // Pinned suffix appears for the pinned lesson
    assert.match(out, /Always run npm test before committing.*\(pinned\)/);

    // Excluded memory_type sections (decision was private only, no decisions remain) absent
    assert.ok(!out.includes('## decision'), 'decision section should be absent (only entry was private)');

    // Sanity: ensure the seeded ids weren't accidentally surfaced as bullets
    assert.ok(!out.includes(seeded.autoExtractLesson));
    assert.ok(!out.includes(seeded.privateDecision));
    assert.ok(!out.includes(seeded.unverifiedAuto));
  });

  test('HTML export produces valid HTML5 with header, table, and escaped content', async () => {
    const seeded = await seedMemories(tmp);
    const cap = makeIO(tmp);
    const code = await executeExportCommand(
      { safe: true, workdir: tmp, format: 'html', out: undefined, json: false },
      cap.io
    );
    assert.strictEqual(code, 0);

    const out = cap.stdout.join('');

    // HTML5 doctype + structural elements
    assert.match(out, /^<!DOCTYPE html>/, 'missing HTML5 doctype');
    assert.match(out, /<html lang="en">/, 'missing <html> root');
    assert.match(out, /<head>[\s\S]*<\/head>/, 'missing <head>');
    assert.match(out, /<body>[\s\S]*<\/body>/, 'missing <body>');
    assert.match(out, /<table>/, 'expected at least one <table>');
    assert.match(out, /<\/html>\s*$/, 'missing closing </html>');

    // Self-contained — inline CSS, no external assets
    assert.match(out, /<style>[\s\S]+<\/style>/, 'inline <style> block missing');
    assert.ok(!/<link[^>]+rel=/i.test(out), 'external <link rel> reference found');
    assert.ok(!/<script/i.test(out), 'unexpected <script> tag in static export');

    // Header has workdir, count, generated date, version
    assert.match(out, /<h1>Relay memory export<\/h1>/);
    assert.match(out, /<dt>workdir<\/dt><dd>/);
    assert.match(out, /<dt>count<\/dt><dd>2<\/dd>/);
    assert.match(out, /<dt>generated<\/dt><dd>\d{4}-\d{2}-\d{2}T/);
    assert.match(out, /<dt>version<\/dt><dd>1\.0<\/dd>/);

    // Surviving content present
    assert.match(out, /Project uses better-sqlite3 for storage/);
    assert.match(out, /Always run npm test before committing/);

    // Excluded content absent
    assert.ok(!out.includes('Auto-extracted: user dislikes verbose comments'), 'auto-extract content leaked into html');
    assert.ok(!out.includes('Decided to use AGPL license'), 'private content leaked into html');
    assert.ok(!out.includes('Auto-suggested: rename foo to bar'), 'unverified content leaked into html');
    assert.ok(!out.includes(seeded.autoExtractLesson));
    assert.ok(!out.includes(seeded.privateDecision));
    assert.ok(!out.includes(seeded.unverifiedAuto));
  });

  test('HTML export escapes XSS payloads in user content and tags', async () => {
    const store = new MemoryStore();
    store.remember({
      content: '<script>alert("xss")</script> & "quoted" \'single\'',
      memory_type: 'fact',
      tags: ['<img src=x>', 'safe'],
      workdir: tmp,
      memory_source: 'human',
    });
    const cap = makeIO(tmp);
    const code = await executeExportCommand(
      { safe: false, workdir: tmp, format: 'html', out: undefined, json: false },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');

    // Raw payload must not appear in unescaped form
    assert.ok(!/<script>alert/.test(out), 'raw <script> payload leaked unescaped');
    assert.ok(!/<img src=x>/.test(out), 'raw <img> tag in tag content leaked unescaped');

    // Escaped form must appear
    assert.match(out, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
    assert.match(out, /&lt;img src=x&gt;/);
    assert.match(out, /&amp;/);
    assert.match(out, /&#39;/);
  });

  test('HTML export to --out file writes a valid HTML document', async () => {
    await seedMemories(tmp);
    const outFile = join(tmp, 'export.html');
    const cap = makeIO(tmp);
    const code = await executeExportCommand(
      { safe: true, workdir: tmp, format: 'html', out: outFile, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);

    const summary = JSON.parse(cap.stdout.join('').trim()) as { ok: boolean; count: number; out: string; format: string };
    assert.strictEqual(summary.ok, true);
    assert.strictEqual(summary.count, 2);
    assert.strictEqual(summary.format, 'html');

    const fileContent = await readFile(outFile, 'utf8');
    assert.match(fileContent, /^<!DOCTYPE html>/);
    assert.match(fileContent, /<body>/);
    assert.match(fileContent, /<table>/);
  });

  test('HTML export on empty store still produces a valid document with a table', async () => {
    const cap = makeIO(tmp);
    const code = await executeExportCommand(
      { safe: true, workdir: tmp, format: 'html', out: undefined, json: false },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /^<!DOCTYPE html>/);
    assert.match(out, /<body>/);
    assert.match(out, /<table>/);
    assert.match(out, /<dt>count<\/dt><dd>0<\/dd>/);
  });

  test('Empty store returns valid JSON with empty memories array', async () => {
    // No seeds — DB is clean per beforeEach
    const cap = makeIO(tmp);
    const code = await executeExportCommand(
      { safe: true, workdir: tmp, format: 'json', out: undefined, json: false },
      cap.io
    );
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(cap.stdout.join('')) as { memories: unknown[]; version: string };
    assert.strictEqual(parsed.memories.length, 0);
    assert.strictEqual(parsed.version, '1.0');
  });
});

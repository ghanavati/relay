process.env['RELAY_DB_PATH'] = ':memory:';

/**
 * T42 — End-to-end integration tests for the full auto-extract pipeline.
 *
 * Drives `executeMemoryAutoExtractCommand` from a synthetic CC SessionEnd
 * payload through every step of the pipeline (consent → transcript →
 * redaction → extraction → schema cleanup → optional Berry → write) by
 * injecting deterministic dependencies via `AutoExtractDeps`. No network,
 * no LM Studio, no Berry, no real fetch.
 *
 * After the happy-path runs we assert the persisted memory rows directly
 * against SQLite to prove the contract: `memory_source='auto-run-recorder'`,
 * the `auto-extract` tag is present, `expires_at` is roughly 30 days out.
 *
 * Wider coverage than `cmd-memory-auto-extract.test.ts`: that test exercises
 * the early-exit branches (bad payload, no consent, missing transcript, real
 * LM Studio unreachable). This file exercises the deeper stages by driving
 * the dep seam — the only place we can deterministically test the schema /
 * Berry / write paths in CI.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  executeMemoryAutoExtractCommand,
  type AutoExtractDeps,
} from './cmd-memory-auto-extract.js';
import { handleRemember } from '../tools/remember.js';
import { getDb } from '../runtime/store/db.js';
import type { CliIO } from './commands.js';
import type { ConsentConfig } from '../memory/auto-extract-consent.js';
import type { TranscriptWindow } from '../memory/auto-extract-transcript.js';
import type {
  ExtractionOptions,
  ExtractionResult,
} from '../memory/auto-extract-runner.js';
import type {
  CleanupResult,
  ExtractedLessonT,
} from '../memory/auto-extract-schema.js';
import type {
  BerryCheckResult,
  CheckLessonOptions,
} from '../memory/auto-extract-berry.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

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

function makePayload(opts: { sessionId: string; cwd: string; transcriptPath: string }): string {
  return JSON.stringify({
    session_id: opts.sessionId,
    transcript_path: opts.transcriptPath,
    cwd: opts.cwd,
    hook_event_name: 'SessionEnd',
  });
}

function consentEnabled(): ConsentConfig {
  return Object.freeze({
    enabled: true,
    allow_remote: false,
    max_bytes: 32_768,
    min_confidence: 0.6,
    extra_redaction_patterns: [],
  });
}

function consentDisabled(): ConsentConfig {
  return Object.freeze({
    enabled: false,
    allow_remote: false,
    max_bytes: 32_768,
    min_confidence: 0.6,
    extra_redaction_patterns: [],
  });
}

function fakeWindow(): TranscriptWindow {
  return Object.freeze({
    jsonl: JSON.stringify({ role: 'user', text: 'edit cmd-init.ts' }) + '\n',
    turnsRead: 2,
    bytes: 64,
  });
}

function happyExtraction(): ExtractionResult {
  return Object.freeze({
    status: 'ok',
    rawOutput: JSON.stringify({
      lessons: [
        {
          content: 'always check existing exports before refactoring cmd-doctor.ts',
          memory_type: 'lesson',
          confidence: 0.8,
        },
      ],
    }),
    durationMs: 12,
  });
}

function makeLesson(content: string, confidence: number): ExtractedLessonT {
  return Object.freeze({ content, memory_type: 'lesson', confidence });
}

/** Replace process.stdin with an in-memory Readable for one async call, then restore. */
async function withStdin<T>(payload: string, fn: () => Promise<T>): Promise<T> {
  const original = process.stdin;
  const stream = Readable.from([Buffer.from(payload, 'utf8')]);
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', { value: original, configurable: true });
  }
}

interface MemoryRow {
  memory_id: string;
  memory_source: string;
  tags_json: string;
  expires_at: number | null;
  content: string;
}

function readMemories(workdir: string): MemoryRow[] {
  return getDb()
    .prepare(
      'SELECT memory_id, memory_source, tags_json, expires_at, content FROM memories WHERE workdir = ?'
    )
    .all(workdir) as MemoryRow[];
}

function clearMemories(): void {
  getDb().prepare('DELETE FROM memories').run();
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('executeMemoryAutoExtractCommand — full E2E pipeline (deps-injected)', () => {
  let tmp: string;
  let projectCwd: string;
  let transcriptPath: string;
  let auditPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-auto-extract-e2e-'));
    projectCwd = join(tmp, 'project');
    await mkdir(projectCwd, { recursive: true });
    transcriptPath = join(projectCwd, 'transcript.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ role: 'user', text: 'edit cmd-init.ts' }),
        JSON.stringify({ role: 'assistant', text: 'edited' }),
      ].join('\n') + '\n',
      'utf8'
    );
    // T2: tests use the unified ndjson filename even when redirected via deps.
    // The on-disk format is identical (wrapped LogEntry ndjson lines), so this
    // path could be anything — using `relay.ndjson` keeps it consistent with
    // production.
    auditPath = join(tmp, 'relay.ndjson');
    clearMemories();
  });

  afterEach(async () => {
    clearMemories();
    await rm(tmp, { recursive: true, force: true });
  });

  test('1. happy path → 1 memory written with correct source/tag/TTL, status ok', async () => {
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (_opts: ExtractionOptions) => happyExtraction(),
      // real cleanupAndValidate runs against the happyExtraction.rawOutput
      checkBerry: async (_opts: CheckLessonOptions): Promise<BerryCheckResult> =>
        ({ ok: 'pass' }),
      remember: handleRemember,
      auditPath,
      now: () => 1_700_000_000_000,
      discoverModel: async (): Promise<string | null> => 'qwen/qwen3-coder-next',
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-happy', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as {
      status: string;
      lessons_written: number;
    };
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(out.lessons_written, 1);

    const rows = readMemories(projectCwd);
    assert.strictEqual(rows.length, 1, 'exactly one memory row for the workdir');
    const [row] = rows;
    assert.ok(row);
    assert.strictEqual(row.memory_source, 'auto-run-recorder');

    const tags = JSON.parse(row.tags_json) as string[];
    assert.ok(tags.includes('auto-extract'), `tags should include auto-extract, got ${row.tags_json}`);
    assert.ok(tags.includes('auto'), 'tags should include auto');
    assert.ok(
      tags.some((t) => t.startsWith('session:')),
      'tags should include session:<id> entry'
    );

    // expires_at should be ~30 days from row insertion. The store uses real
    // Date.now() (not deps.now), so test against a coarse window.
    assert.ok(typeof row.expires_at === 'number', 'expires_at must be set');
    const expectedTtl = 30 * 24 * 60 * 60 * 1000;
    const drift = Math.abs((row.expires_at as number) - (Date.now() + expectedTtl));
    assert.ok(
      drift < 60 * 1000,
      `expires_at should be ~30d out (drift=${drift}ms exceeded 60s tolerance)`
    );
  });

  test('2. no consent file → status skipped:no-consent, 0 written', async () => {
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: false, reason: 'no-file' }),
      // these should never be called once consent fails — wire as throwers to prove that
      loadTranscript: () => {
        throw new Error('loadTranscript should not run without consent');
      },
      extractLessons: async () => {
        throw new Error('extractLessons should not run without consent');
      },
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => 'qwen/qwen3-coder-next',
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-no-consent', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string };
    assert.strictEqual(out.status, 'skipped:no-consent');
    assert.strictEqual(readMemories(projectCwd).length, 0);
  });

  test('3. consent enabled:false → status skipped:disabled, 0 written', async () => {
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentDisabled() }),
      loadTranscript: () => {
        throw new Error('loadTranscript should not run when consent.enabled=false');
      },
      extractLessons: async () => {
        throw new Error('extractLessons should not run when consent.enabled=false');
      },
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => 'qwen/qwen3-coder-next',
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-disabled', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string };
    assert.strictEqual(out.status, 'skipped:disabled');
    assert.strictEqual(readMemories(projectCwd).length, 0);
  });

  test('4. extractLessons returns error:llm-down → status error:llm-down, 0 written, no exception', async () => {
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (_opts: ExtractionOptions) => ({
        status: 'error:llm-down',
        durationMs: 5,
        note: 'connection refused at 127.0.0.1:1',
      }),
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => 'qwen/qwen3-coder-next',
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-llm-down', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0, 'hooks must never block — exit 0 even on LLM failure');
    const out = JSON.parse(cap.stdout.join('').trim()) as {
      status: string;
      lessons_written?: number;
    };
    assert.strictEqual(out.status, 'error:llm-down');
    assert.strictEqual(readMemories(projectCwd).length, 0);
  });

  test('5. cleanupAndValidate returns parse-error → status error:parse, 0 written', async () => {
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (_opts: ExtractionOptions) => ({
        status: 'ok',
        rawOutput: '{not valid json',
        durationMs: 8,
      }),
      cleanupAndValidate: (_raw: string, _min: number): CleanupResult => ({
        ok: false,
        reason: 'parse-error',
        detail: 'unterminated string at column 14',
      }),
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => 'qwen/qwen3-coder-next',
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-parse', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string };
    assert.strictEqual(out.status, 'error:parse');
    assert.strictEqual(readMemories(projectCwd).length, 0);
  });

  test('6. all lessons below min_confidence → status skipped:low-confidence, 0 written', async () => {
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (_opts: ExtractionOptions) => ({
        status: 'ok',
        rawOutput: JSON.stringify({
          lessons: [
            { content: 'lesson under threshold #1', memory_type: 'lesson', confidence: 0.4 },
            { content: 'lesson under threshold #2', memory_type: 'lesson', confidence: 0.3 },
          ],
        }),
        durationMs: 9,
      }),
      // Bypass real schema — return CleanupFail with low-confidence so the
      // pipeline takes the dedicated branch.
      cleanupAndValidate: (_raw: string, _min: number): CleanupResult => ({
        ok: false,
        reason: 'low-confidence',
        detail: 'all 2 lessons below minConfidence=0.6',
      }),
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => 'qwen/qwen3-coder-next',
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-lowconf', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string };
    assert.strictEqual(out.status, 'skipped:low-confidence');
    assert.strictEqual(readMemories(projectCwd).length, 0);
  });

  test('7a. Berry flags single lesson → status error:berry-flagged, 0 written', async () => {
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (_opts: ExtractionOptions) => happyExtraction(),
      // Force every lesson to be flagged → no survivors → error:berry-flagged
      checkBerry: async (_opts: CheckLessonOptions): Promise<BerryCheckResult> =>
        ({ ok: 'flagged', details: { reason: 'unsupported' } }),
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => 'qwen/qwen3-coder-next',
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-berry-fail', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as {
      status: string;
      lessons_written?: number;
    };
    assert.strictEqual(out.status, 'error:berry-flagged');
    assert.strictEqual(readMemories(projectCwd).length, 0);
  });

  test('7b. Berry flags one of two lessons → status partial:berry-flag, 1 of 2 written', async () => {
    // Custom cleanupAndValidate that returns TWO lessons; checkBerry flags
    // the first one only. The pipeline should write exactly one memory and
    // emit `partial:berry-flag`.
    const goodLesson = makeLesson('always run npm typecheck before commit', 0.85);
    const flaggedLesson = makeLesson('relay was authored by a bot in 1999', 0.85);
    const flagFirst = new Set<string>([flaggedLesson.content]);

    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (_opts: ExtractionOptions) => ({
        status: 'ok',
        rawOutput: JSON.stringify({
          lessons: [flaggedLesson, goodLesson],
        }),
        durationMs: 11,
      }),
      cleanupAndValidate: (_raw: string, _min: number): CleanupResult => ({
        ok: true,
        lessons: [flaggedLesson, goodLesson],
      }),
      checkBerry: async (opts: CheckLessonOptions): Promise<BerryCheckResult> =>
        flagFirst.has(opts.lessonContent)
          ? { ok: 'flagged', details: { reason: 'unsupported' } }
          : { ok: 'pass' },
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => 'qwen/qwen3-coder-next',
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-berry-partial', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as {
      status: string;
      lessons_written: number;
    };
    assert.strictEqual(out.status, 'partial:berry-flag');
    assert.strictEqual(out.lessons_written, 1);

    const rows = readMemories(projectCwd);
    assert.strictEqual(rows.length, 1, 'exactly one survivor written');
    const [row] = rows;
    assert.ok(row);
    assert.strictEqual(row.memory_source, 'auto-run-recorder');
    assert.strictEqual(row.content, goodLesson.content, 'flagged lesson must be skipped');
    const tags = JSON.parse(row.tags_json) as string[];
    assert.ok(tags.includes('auto-extract'));
  });

  test('8. cleanupAndValidate returns schema-error → status error:schema, 0 written', async () => {
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (_opts: ExtractionOptions) => ({
        status: 'ok',
        rawOutput: JSON.stringify({ lessons: [{ wrong: 'shape' }] }),
        durationMs: 7,
      }),
      cleanupAndValidate: (_raw: string, _min: number): CleanupResult => ({
        ok: false,
        reason: 'schema-error',
        detail: 'lessons[0].content: required',
      }),
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => 'qwen/qwen3-coder-next',
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-schema', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string };
    assert.strictEqual(out.status, 'error:schema');
    assert.strictEqual(readMemories(projectCwd).length, 0);
  });

  test('9. transcript window has 0 turns → status skipped:empty-window, 0 written', async () => {
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      // Empty window — turnsRead === 0 triggers the skipped:empty-window branch
      loadTranscript: () => Object.freeze({ jsonl: '', turnsRead: 0, bytes: 0 }),
      // Anything past empty-window check should NEVER run — wire as throwers
      redact: () => {
        throw new Error('redact should not run on empty window');
      },
      extractLessons: async () => {
        throw new Error('extractLessons should not run on empty window');
      },
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => 'qwen/qwen3-coder-next',
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-empty', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string };
    assert.strictEqual(out.status, 'skipped:empty-window');
    assert.strictEqual(readMemories(projectCwd).length, 0);
  });

<<<<<<< HEAD
  // ── T3 + T10 (error-handling improvements) ───────────────────────────────

  test('10. T3 — uncaught exception inside pipeline → status error:uncaught + exit 0 (hook never blocks)', async () => {
    // loadConsent throws synchronously inside an async fn — this surfaces as a
    // rejected promise the pipeline never explicitly catches. The top-level
    // try/catch in executeMemoryAutoExtractCommand must swallow it, write
    // `error:uncaught` to the audit log, and return 0.
    const deps: AutoExtractDeps = {
      loadConsent: async () => {
        throw new Error('boom — synthetic uncaught failure');
      },
      remember: handleRemember,
      auditPath,
=======
  // ── T9: model resolution ──────────────────────────────────────────────────

  test('T9: discoverModel returns null + no env + no consent.model → error:no-model', async () => {
    let extractCalled = false;
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (_opts: ExtractionOptions) => {
        extractCalled = true;
        return happyExtraction();
      },
      remember: handleRemember,
      auditPath,
      // Auto-discovery returns nothing — no IDLE model loaded.
      discoverModel: async (): Promise<string | null> => null,
      env: {} as NodeJS.ProcessEnv,
>>>>>>> 4d0c14a (feat(auto-extract): endpoint validation + dynamic model selection)
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
<<<<<<< HEAD
      makePayload({ sessionId: 'sess-uncaught', cwd: projectCwd, transcriptPath }),
=======
      makePayload({ sessionId: 'sess-no-model', cwd: projectCwd, transcriptPath }),
>>>>>>> 4d0c14a (feat(auto-extract): endpoint validation + dynamic model selection)
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

<<<<<<< HEAD
    assert.strictEqual(code, 0, 'hooks must never block — uncaught exception still exits 0');
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string; error?: string };
    assert.strictEqual(out.status, 'error:uncaught');
    assert.match(out.error ?? '', /boom/);
    assert.strictEqual(readMemories(projectCwd).length, 0);

    // Audit log row recorded.
    const { readFile } = await import('node:fs/promises');
    const audit = await readFile(auditPath, 'utf8');
    assert.match(audit, /error:uncaught/);
  });

  test('11. T10 — partial write (1 of 2 lessons throws in remember) → status partial:write with counts', async () => {
    const goodLesson = makeLesson('always run npm typecheck before commit', 0.85);
    const badLesson = makeLesson('this remember call will throw', 0.85);

    // Custom remember that throws for one specific lesson, succeeds for the
    // other. We forward to handleRemember on the success path so the real DB
    // row is written and we can assert against it.
    const remember: typeof handleRemember = (input, source) => {
      if (input.content === badLesson.content) {
        throw new Error('synthetic remember failure');
      }
      return handleRemember(input, source);
    };

    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (_opts: ExtractionOptions) => ({
        status: 'ok',
        rawOutput: JSON.stringify({ lessons: [badLesson, goodLesson] }),
        durationMs: 4,
      }),
      cleanupAndValidate: (_raw: string, _min: number): CleanupResult => ({
        ok: true,
        lessons: [badLesson, goodLesson],
      }),
      checkBerry: async (_opts: CheckLessonOptions): Promise<BerryCheckResult> =>
        ({ ok: 'pass' }),
      remember,
      auditPath,
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-partial-write', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as {
      status: string;
      lessons_written: number;
      lessons_failed: number;
      error?: string;
    };
    assert.strictEqual(out.status, 'partial:write');
    assert.strictEqual(out.lessons_written, 1);
    assert.strictEqual(out.lessons_failed, 1);
    assert.match(out.error ?? '', /synthetic remember failure/);

    // Only the good lesson was actually persisted.
    const rows = readMemories(projectCwd);
    assert.strictEqual(rows.length, 1, 'exactly one row written despite partial failure');
    const [row] = rows;
    assert.ok(row);
    assert.strictEqual(row.content, goodLesson.content);
  });

  test('12. T10 — all lessons throw in remember → status error:write-all-failed, 0 written', async () => {
    const remember: typeof handleRemember = () => {
      throw new Error('every remember fails');
    };

    const lessonA = makeLesson('lesson A', 0.8);
    const lessonB = makeLesson('lesson B', 0.8);

=======
    assert.strictEqual(code, 0, 'hooks must never block — exit 0 even when no model');
    const out = JSON.parse(cap.stdout.join('').trim()) as {
      status: string;
      error?: string;
    };
    assert.strictEqual(out.status, 'error:no-model');
    // Error message must be actionable
    assert.match(out.error ?? '', /RELAY_AUTO_EXTRACT_MODEL/);
    assert.match(out.error ?? '', /lms ps/);
    assert.strictEqual(extractCalled, false, 'extractLessons must not run without a resolved model');
    assert.strictEqual(readMemories(projectCwd).length, 0);
  });

  test('T9: discoverModel returns idle id → that id is passed to extractLessons', async () => {
    let observedModel: string | undefined;
>>>>>>> 4d0c14a (feat(auto-extract): endpoint validation + dynamic model selection)
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
<<<<<<< HEAD
      extractLessons: async (_opts: ExtractionOptions) => ({
        status: 'ok',
        rawOutput: JSON.stringify({ lessons: [lessonA, lessonB] }),
        durationMs: 3,
      }),
      cleanupAndValidate: (_raw: string, _min: number): CleanupResult => ({
        ok: true,
        lessons: [lessonA, lessonB],
      }),
      checkBerry: async (_opts: CheckLessonOptions): Promise<BerryCheckResult> =>
        ({ ok: 'pass' }),
      remember,
      auditPath,
=======
      extractLessons: async (opts: ExtractionOptions) => {
        observedModel = opts.model;
        return happyExtraction();
      },
      checkBerry: async (_opts: CheckLessonOptions): Promise<BerryCheckResult> => ({ ok: 'pass' }),
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => 'discovered/local-llm',
      env: {} as NodeJS.ProcessEnv,
>>>>>>> 4d0c14a (feat(auto-extract): endpoint validation + dynamic model selection)
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
<<<<<<< HEAD
      makePayload({ sessionId: 'sess-all-fail', cwd: projectCwd, transcriptPath }),
=======
      makePayload({ sessionId: 'sess-discover', cwd: projectCwd, transcriptPath }),
>>>>>>> 4d0c14a (feat(auto-extract): endpoint validation + dynamic model selection)
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
<<<<<<< HEAD
    const out = JSON.parse(cap.stdout.join('').trim()) as {
      status: string;
      lessons_written: number;
      lessons_failed: number;
    };
    assert.strictEqual(out.status, 'error:write-all-failed');
    assert.strictEqual(out.lessons_written, 0);
    assert.strictEqual(out.lessons_failed, 2);
    assert.strictEqual(readMemories(projectCwd).length, 0);
=======
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string; model?: string };
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(observedModel, 'discovered/local-llm');
    assert.strictEqual(out.model, 'discovered/local-llm');
  });

  test('T9: env var overrides consent.model and discoverModel (priority order)', async () => {
    let observedModel: string | undefined;
    let discoverCalled = false;
    const consentWithModel: ConsentConfig = Object.freeze({
      enabled: true,
      allow_remote: false,
      max_bytes: 32_768,
      min_confidence: 0.6,
      extra_redaction_patterns: [],
      model: 'consent/model-id',
    });
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentWithModel }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (opts: ExtractionOptions) => {
        observedModel = opts.model;
        return happyExtraction();
      },
      checkBerry: async (_opts: CheckLessonOptions): Promise<BerryCheckResult> => ({ ok: 'pass' }),
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => {
        discoverCalled = true;
        return 'discovered/should-not-win';
      },
      env: { RELAY_AUTO_EXTRACT_MODEL: 'env/wins' } as NodeJS.ProcessEnv,
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-env-wins', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string };
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(observedModel, 'env/wins', 'env var must beat consent.model and discovery');
    assert.strictEqual(discoverCalled, false, 'discoverModel must not run when env wins');
  });

  test('T9: consent.model used when env unset, beats discoverModel', async () => {
    let observedModel: string | undefined;
    let discoverCalled = false;
    const consentWithModel: ConsentConfig = Object.freeze({
      enabled: true,
      allow_remote: false,
      max_bytes: 32_768,
      min_confidence: 0.6,
      extra_redaction_patterns: [],
      model: 'consent/pinned-model',
    });
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentWithModel }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (opts: ExtractionOptions) => {
        observedModel = opts.model;
        return happyExtraction();
      },
      checkBerry: async (_opts: CheckLessonOptions): Promise<BerryCheckResult> => ({ ok: 'pass' }),
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => {
        discoverCalled = true;
        return 'discovered/should-not-win';
      },
      env: {} as NodeJS.ProcessEnv,
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-consent-model', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string };
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(observedModel, 'consent/pinned-model');
    assert.strictEqual(discoverCalled, false, 'discoverModel must not run when consent.model is set');
  });

  // ── T4: endpoint validation (deps-injected) ───────────────────────────────

  test('T4: localhost variants pass — 127.0.0.1, ::1, localhost', async () => {
    // The pure-function unit-tests below are the comprehensive guarantee;
    // this E2E test proves the wiring uses the helper correctly by setting
    // a localhost env URL and confirming the request reaches extractLessons.
    let observedModel: string | undefined;
    const deps: AutoExtractDeps = {
      loadConsent: async () => ({ ok: true, consent: consentEnabled() }),
      loadTranscript: () => fakeWindow(),
      redact: (s) => s,
      extractLessons: async (opts: ExtractionOptions) => {
        observedModel = opts.model;
        return happyExtraction();
      },
      checkBerry: async (_opts: CheckLessonOptions): Promise<BerryCheckResult> => ({ ok: 'pass' }),
      remember: handleRemember,
      auditPath,
      discoverModel: async (): Promise<string | null> => 'qwen/qwen3-coder-next',
      env: { RELAY_AUTO_EXTRACT_ENDPOINT: 'http://[::1]:1234' } as NodeJS.ProcessEnv,
    };

    const cap = makeIO(projectCwd);
    const code = await withStdin(
      makePayload({ sessionId: 'sess-ipv6-local', cwd: projectCwd, transcriptPath }),
      () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io,
          deps
        )
    );

    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string };
    assert.strictEqual(out.status, 'ok', `IPv6 ::1 must be treated as local, got ${out.status}`);
    assert.strictEqual(observedModel, 'qwen/qwen3-coder-next');
  });
});

// ── Pure-function unit tests for T4 / T9 helpers ─────────────────────────────

import { isLocalEndpoint, parseLmsPsOutput } from './cmd-memory-auto-extract.js';

describe('isLocalEndpoint (T4)', () => {
  test('matches 127.0.0.1, ::1, localhost — case insensitive on host', () => {
    assert.strictEqual(isLocalEndpoint('http://127.0.0.1:1234'), true);
    assert.strictEqual(isLocalEndpoint('http://localhost:1234'), true);
    assert.strictEqual(isLocalEndpoint('http://LOCALHOST:1234'), true);
    assert.strictEqual(isLocalEndpoint('http://[::1]:1234'), true);
    assert.strictEqual(isLocalEndpoint('https://localhost'), true);
  });

  test('rejects every non-localhost host', () => {
    assert.strictEqual(isLocalEndpoint('http://10.0.0.1:1234'), false);
    assert.strictEqual(isLocalEndpoint('https://api.openai.com'), false);
    assert.strictEqual(isLocalEndpoint('http://192.168.1.50:8080'), false);
    assert.strictEqual(isLocalEndpoint('http://example.com'), false);
    // Subdomain of localhost is NOT localhost
    assert.strictEqual(isLocalEndpoint('http://evil.localhost'), false);
  });

  test('unparseable URL → false (fail-closed)', () => {
    assert.strictEqual(isLocalEndpoint('not-a-url'), false);
    assert.strictEqual(isLocalEndpoint(''), false);
    assert.strictEqual(isLocalEndpoint('::1'), false);
  });
});

describe('parseLmsPsOutput (T9)', () => {
  test('returns first IDLE model identifier from `lms ps --json`', () => {
    const stdout = JSON.stringify([
      { identifier: 'qwen/qwen3-coder-next', state: 'idle' },
      { identifier: 'other/loaded', state: 'busy' },
    ]);
    assert.strictEqual(parseLmsPsOutput(stdout), 'qwen/qwen3-coder-next');
  });

  test('skips non-idle entries, returns first idle', () => {
    const stdout = JSON.stringify([
      { identifier: 'busy/one', state: 'busy' },
      { identifier: 'loading/two', state: 'loading' },
      { identifier: 'idle/three', state: 'idle' },
      { identifier: 'idle/four', state: 'idle' },
    ]);
    assert.strictEqual(parseLmsPsOutput(stdout), 'idle/three');
  });

  test('falls back to modelKey when identifier missing', () => {
    const stdout = JSON.stringify([{ modelKey: 'fallback-key', state: 'idle' }]);
    assert.strictEqual(parseLmsPsOutput(stdout), 'fallback-key');
  });

  test('empty array → null', () => {
    assert.strictEqual(parseLmsPsOutput('[]'), null);
  });

  test('invalid JSON → null', () => {
    assert.strictEqual(parseLmsPsOutput('not-json'), null);
    assert.strictEqual(parseLmsPsOutput(''), null);
  });

  test('non-array JSON → null', () => {
    assert.strictEqual(parseLmsPsOutput('{"foo":"bar"}'), null);
  });

  test('case-insensitive state matching', () => {
    const stdout = JSON.stringify([{ identifier: 'idle/one', state: 'IDLE' }]);
    assert.strictEqual(parseLmsPsOutput(stdout), 'idle/one');
>>>>>>> 4d0c14a (feat(auto-extract): endpoint validation + dynamic model selection)
  });
});

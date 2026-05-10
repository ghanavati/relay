/**
 * `relay memory auto-extract --from-stdin` — wired to Claude Code's SessionEnd hook.
 *
 * Pipeline (T16 — full E2E):
 *   1. Parse + validate the SessionEnd hook payload (Zod).
 *   2. Verify per-workdir consent (T13 — `<cwd>/.relay/auto-extract.json`).
 *   3. Block remote providers when `consent.allow_remote === false` (v1 = local only).
 *   4. Load the trailing transcript window (T9).
 *   5. Apply extended PII / secret redaction (T12) before sending to any LLM.
 *   6. Call the LM Studio extraction runner (T10).
 *   7. Validate + clean the LLM output through the Zod schema (T11).
 *   8. Optionally cross-check each lesson with Berry (T15). When
 *      `RELAY_AUTO_EXTRACT_REQUIRE_BERRY=1` is set, an "unavailable" verdict is
 *      treated as a failure (the lesson is skipped). Without that flag, only
 *      explicitly "flagged" verdicts skip the lesson.
 *   9. For every surviving lesson, write through the internal `handleRemember`
 *      API with `memory_source='auto-run-recorder'` and the `auto-extract` tag
 *      so the trust-tier fence (T14) prevents auto-pinning.
 *  10. Append a single ndjson line to the unified `~/.relay/relay.ndjson` log
 *      (via the centralized `appendLog` helper) with the final outcome wrapped
 *      as a `{ event: 'extract.*', ok, cwd, meta: AuditEntry }` LogEntry.
 *      Tests may inject `deps.auditPath` to redirect writes; when set, that
 *      path receives the same wrapped LogEntry ndjson lines (so doctor /
 *      tail / observability tools read a single stream).
 *
 * The hook is wired into CC's SessionEnd event. CC discards the exit code and
 * stderr, so this command never throws — every failure path is caught, logged,
 * and exits 0.
 */

import type { CliIO } from './commands.js';
import { mkdir, appendFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { appendLog, type LogEvent } from '../runtime/relay-log.js';

import { loadConsent, type ConsentConfig } from '../memory/auto-extract-consent.js';
import {
  loadRecentTranscriptWindow,
  DEFAULT_WINDOW_BYTES,
  type TranscriptWindow,
} from '../memory/auto-extract-transcript.js';
import { redactSecretsAndPII } from '../security/redaction-pii.js';
import {
  extractLessonsViaLmStudio,
  type ExtractionOptions,
  type ExtractionResult,
} from '../memory/auto-extract-runner.js';
import {
  cleanupAndValidate,
  type CleanupResult,
  type ExtractedLessonT,
} from '../memory/auto-extract-schema.js';
import {
  checkLessonViaBerry,
  type BerryCheckResult,
  type CheckLessonOptions,
} from '../memory/auto-extract-berry.js';
import { handleRemember } from '../tools/remember.js';

// ── Hook payload schema ──────────────────────────────────────────────────────

const HookPayloadSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
  hook_event_name: z.string().min(1).optional(),
});
type HookPayload = z.infer<typeof HookPayloadSchema>;

// ── Status enum (extended per T16 spec) ──────────────────────────────────────

export type AutoExtractStatus =
  | 'ok'
  | 'skipped:disabled'
  | 'skipped:no-consent'
  | 'skipped:bad-payload'
  | 'skipped:no-transcript'
  | 'skipped:empty-window'
  | 'skipped:no-llm'
  | 'skipped:rate-limit'
  | 'skipped:low-confidence'
  | 'error:llm-down'
  | 'error:llm-timeout'
  | 'error:parse'
  | 'error:schema'
  | 'error:berry-flagged'
  | 'error:write'
  | 'partial:berry-flag';

// ── Audit log shape ──────────────────────────────────────────────────────────

interface AuditEntry {
  readonly ts: string;
  readonly session_id: string | null;
  readonly cwd: string | null;
  readonly status: AutoExtractStatus;
  readonly provider?: string;
  readonly model?: string;
  readonly turns_read?: number;
  readonly transcript_bytes?: number;
  readonly redaction_hits?: number;
  readonly lessons_written?: number;
  readonly duration_ms?: number;
  readonly error?: string;
  readonly note?: string;
}

// ── Public command interface ─────────────────────────────────────────────────

export interface AutoExtractArgs {
  readonly fromStdin: boolean;
  readonly maxBytes: number | undefined;
  readonly json: boolean;
}

/**
 * Dependency-injection seam — every external service used by the pipeline is
 * injectable so the test suite can drive end-to-end paths without touching the
 * network. Defaults wire the real implementations.
 */
export interface AutoExtractDeps {
  readonly readStdin?: () => Promise<string>;
  readonly loadConsent?: (workdir: string) => Promise<ConsentLoadResultLike>;
  readonly loadTranscript?: (path: string, maxBytes: number) => TranscriptWindow;
  readonly redact?: (text: string) => string;
  readonly extractLessons?: (opts: ExtractionOptions) => Promise<ExtractionResult>;
  readonly cleanupAndValidate?: (raw: string, minConfidence: number) => CleanupResult;
  readonly checkBerry?: (opts: CheckLessonOptions) => Promise<BerryCheckResult>;
  readonly remember?: typeof handleRemember;
  readonly now?: () => number;
  readonly auditPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

type ConsentLoadResultLike =
  | { ok: true; consent: ConsentConfig }
  | { ok: false; reason: string; detail?: string };

const DEFAULT_ENDPOINT = 'http://localhost:1234';
const DEFAULT_MODEL = 'qwen/qwen3-coder-next';
const DEFAULT_TIMEOUT_MS = 25_000;
const TTL_HOURS_30_DAYS = 30 * 24;

export async function executeMemoryAutoExtractCommand(
  args: AutoExtractArgs,
  io: CliIO,
  deps: AutoExtractDeps = {}
): Promise<number> {
  if (!args.fromStdin) {
    io.stderr('relay memory auto-extract requires --from-stdin (CC SessionEnd hook is the only caller)\n');
    return 2;
  }

  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const audit = (entry: AuditEntry): Promise<void> => appendAudit(entry, deps.auditPath);

  // 1. stdin → payload
  const payload = await readPayload(args, io, deps, audit);
  if (!payload.ok) return 0;

  // 2. consent
  const consentResult = await (deps.loadConsent ?? loadConsent)(payload.value.cwd);
  if (!consentResult.ok) {
    const status: AutoExtractStatus =
      consentResult.reason === 'no-file' ? 'skipped:no-consent' : 'skipped:no-consent';
    await emit(io, args, status, audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status,
      duration_ms: now() - startedAt,
      ...(consentResult.detail ? { error: consentResult.detail } : {}),
    });
    return 0;
  }

  const consent = consentResult.consent;
  if (consent.enabled === false) {
    await emit(io, args, 'skipped:disabled', audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status: 'skipped:disabled',
      duration_ms: now() - startedAt,
    });
    return 0;
  }

  // 3. provider gating — v1 supports lmstudio only. allow_remote=false blocks anything else.
  const provider = String(env['RELAY_AUTO_EXTRACT_PROVIDER'] ?? 'lmstudio');
  if (provider !== 'lmstudio' && consent.allow_remote === false) {
    await emit(io, args, 'skipped:no-llm', audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status: 'skipped:no-llm',
      provider,
      duration_ms: now() - startedAt,
      error: `provider '${provider}' is remote and consent.allow_remote=false`,
    });
    return 0;
  }
  if (provider !== 'lmstudio') {
    // Even with allow_remote=true, only lmstudio is implemented in v1.
    await emit(io, args, 'skipped:no-llm', audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status: 'skipped:no-llm',
      provider,
      duration_ms: now() - startedAt,
      error: `provider '${provider}' not supported in v1 (only lmstudio)`,
    });
    return 0;
  }

  // 4. transcript exists?
  if (!existsSync(payload.value.transcript_path)) {
    await emit(io, args, 'skipped:no-transcript', audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status: 'skipped:no-transcript',
      provider,
      duration_ms: now() - startedAt,
      error: payload.value.transcript_path,
    });
    return 0;
  }

  // 5. load trailing window
  const window = (deps.loadTranscript ?? loadRecentTranscriptWindow)(
    payload.value.transcript_path,
    args.maxBytes ?? consent.max_bytes ?? DEFAULT_WINDOW_BYTES
  );
  if (window.turnsRead === 0) {
    await emit(io, args, 'skipped:empty-window', audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status: 'skipped:empty-window',
      provider,
      turns_read: 0,
      transcript_bytes: 0,
      duration_ms: now() - startedAt,
    });
    return 0;
  }

  // 6. PII / secret redaction
  const redact = deps.redact ?? redactSecretsAndPII;
  const redactedTranscript = redact(window.jsonl);
  const redactionHits = countRedactionHits(window.jsonl, redactedTranscript);

  // 7. LM Studio extraction
  const endpoint = String(env['RELAY_AUTO_EXTRACT_ENDPOINT'] ?? DEFAULT_ENDPOINT);
  const model = String(env['RELAY_AUTO_EXTRACT_MODEL'] ?? DEFAULT_MODEL);
  const timeoutMs = parsePositiveInt(env['RELAY_AUTO_EXTRACT_TIMEOUT_MS']) ?? DEFAULT_TIMEOUT_MS;

  const extract = deps.extractLessons ?? extractLessonsViaLmStudio;
  const extraction = await extract({
    transcript: redactedTranscript,
    endpoint,
    model,
    timeoutMs,
  });

  if (extraction.status !== 'ok' || !extraction.rawOutput) {
    const status: AutoExtractStatus =
      extraction.status === 'error:timeout'
        ? 'error:llm-timeout'
        : extraction.status === 'error:llm-down'
          ? 'error:llm-down'
          : extraction.status === 'error:parse' || extraction.status === 'error:empty'
            ? 'error:parse'
            : 'error:llm-down';
    await emit(io, args, status, audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status,
      provider,
      model,
      turns_read: window.turnsRead,
      transcript_bytes: window.bytes,
      redaction_hits: redactionHits,
      duration_ms: now() - startedAt,
      ...(extraction.note ? { error: extraction.note } : {}),
    });
    return 0;
  }

  // 8. schema cleanup + validation
  const cleanup = (deps.cleanupAndValidate ?? cleanupAndValidate)(
    extraction.rawOutput,
    consent.min_confidence
  );
  if (!cleanup.ok) {
    const status: AutoExtractStatus =
      cleanup.reason === 'parse-error'
        ? 'error:parse'
        : cleanup.reason === 'low-confidence'
          ? 'skipped:low-confidence'
          : 'error:schema';
    await emit(io, args, status, audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status,
      provider,
      model,
      turns_read: window.turnsRead,
      transcript_bytes: window.bytes,
      redaction_hits: redactionHits,
      duration_ms: now() - startedAt,
      ...(cleanup.detail ? { error: cleanup.detail } : {}),
    });
    return 0;
  }

  // 9. optional Berry hallucination check (per lesson)
  const requireBerry = env['RELAY_AUTO_EXTRACT_REQUIRE_BERRY'] === '1';
  const berryCheck = deps.checkBerry ?? checkLessonViaBerry;
  const transcriptSpans = [
    { source: `transcript:${payload.value.session_id}`, text: redactedTranscript },
  ];

  const survivors: ExtractedLessonT[] = [];
  let anyFlagged = false;
  for (const lesson of cleanup.lessons) {
    let outcome: BerryCheckResult;
    try {
      outcome = await berryCheck({
        lessonContent: lesson.content,
        transcriptSpans,
      });
    } catch (err) {
      // Defensive: berry helper itself should not throw, but never crash.
      outcome = { ok: 'unavailable', details: { error: (err as Error).message } };
    }
    if (outcome.ok === 'flagged') {
      anyFlagged = true;
      continue;
    }
    if (outcome.ok === 'unavailable' && requireBerry) {
      anyFlagged = true;
      continue;
    }
    survivors.push(lesson);
  }

  if (survivors.length === 0) {
    const status: AutoExtractStatus = anyFlagged ? 'error:berry-flagged' : 'skipped:low-confidence';
    await emit(io, args, status, audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status,
      provider,
      model,
      turns_read: window.turnsRead,
      transcript_bytes: window.bytes,
      redaction_hits: redactionHits,
      lessons_written: 0,
      duration_ms: now() - startedAt,
    });
    return 0;
  }

  // 10. write surviving lessons through internal handleRemember
  const remember = deps.remember ?? handleRemember;
  let written = 0;
  let writeError: string | undefined;
  for (const lesson of survivors) {
    try {
      remember(
        {
          content: lesson.content,
          memory_type: lesson.memory_type,
          tags: [
            'auto',
            'auto-extract',
            `session:${payload.value.session_id}`,
            `confidence:${lesson.confidence.toFixed(2)}`,
          ],
          pinned: false,
          workdir: payload.value.cwd,
          expires_in_hours: TTL_HOURS_30_DAYS,
          source_run_id: `auto-extract:${payload.value.session_id}`,
        },
        'auto-run-recorder'
      );
      written += 1;
    } catch (err) {
      writeError = (err as Error).message;
      break;
    }
  }

  if (writeError !== undefined && written === 0) {
    await emit(io, args, 'error:write', audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status: 'error:write',
      provider,
      model,
      turns_read: window.turnsRead,
      transcript_bytes: window.bytes,
      redaction_hits: redactionHits,
      lessons_written: 0,
      duration_ms: now() - startedAt,
      error: writeError,
    });
    return 0;
  }

  const finalStatus: AutoExtractStatus = anyFlagged ? 'partial:berry-flag' : 'ok';
  await emit(io, args, finalStatus, audit, {
    ts: new Date().toISOString(),
    session_id: payload.value.session_id,
    cwd: payload.value.cwd,
    status: finalStatus,
    provider,
    model,
    turns_read: window.turnsRead,
    transcript_bytes: window.bytes,
    redaction_hits: redactionHits,
    lessons_written: written,
    duration_ms: now() - startedAt,
    ...(writeError ? { error: writeError } : {}),
  });
  return 0;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface PayloadOk { readonly ok: true; readonly value: HookPayload; }
interface PayloadErr { readonly ok: false; }

async function readPayload(
  args: AutoExtractArgs,
  io: CliIO,
  deps: AutoExtractDeps,
  audit: (entry: AuditEntry) => Promise<void>
): Promise<PayloadOk | PayloadErr> {
  const reader = deps.readStdin ?? readAllStdin;
  let raw: string;
  try {
    raw = await reader();
  } catch (err) {
    await audit({
      ts: new Date().toISOString(),
      session_id: null,
      cwd: null,
      status: 'skipped:bad-payload',
      error: `stdin read failed: ${(err as Error).message}`,
    });
    if (args.json) io.stdout(JSON.stringify({ status: 'skipped:bad-payload', error: 'stdin read failed' }) + '\n');
    return { ok: false };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const value = HookPayloadSchema.parse(parsed);
    return { ok: true, value };
  } catch (err) {
    await audit({
      ts: new Date().toISOString(),
      session_id: null,
      cwd: null,
      status: 'skipped:bad-payload',
      error: (err as Error).message,
    });
    if (args.json) io.stdout(JSON.stringify({ status: 'skipped:bad-payload', error: (err as Error).message }) + '\n');
    else io.stderr(`auto-extract: bad stdin payload: ${(err as Error).message}\n`);
    return { ok: false };
  }
}

async function emit(
  io: CliIO,
  args: AutoExtractArgs,
  status: AutoExtractStatus,
  audit: (entry: AuditEntry) => Promise<void>,
  entry: AuditEntry
): Promise<void> {
  await audit(entry);
  if (args.json) {
    io.stdout(JSON.stringify({ ...entry, status }) + '\n');
  }
}

/** Drain process.stdin into a string. CC pipes the hook payload as a single short blob. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Map an auto-extract status to one of the unified `extract.*` LogEvents that
 * the centralized logger declares. Doctor / tail consumers filter on these.
 *
 * The detailed status string (e.g. `skipped:no-consent`, `error:berry-flagged`)
 * is preserved on the wrapped LogEntry's `meta.status` field so observability
 * tools see the full taxonomy without us having to grow the LogEvent enum.
 */
function statusToLogEvent(status: AutoExtractStatus): LogEvent {
  if (status === 'ok') return 'extract.write';
  if (status === 'partial:berry-flag') return 'extract.write';
  if (status.startsWith('skipped:')) return 'extract.skip';
  if (status.startsWith('error:')) return 'extract.error';
  // bad-payload, no-llm, etc. fall through here — treat as skip rather than
  // error since the pipeline did not actually fail to produce output.
  return 'extract.skip';
}

/**
 * Append a single audit entry to the unified relay log. When `overridePath`
 * is provided (test injection), writes the same wrapped LogEntry shape to
 * that file directly — this keeps the on-disk format identical between
 * `~/.relay/relay.ndjson` and any test sandbox path, so consumers like
 * `relay memory tail` and `relay doctor` can read either without branching.
 */
async function appendAudit(entry: AuditEntry, overridePath?: string): Promise<void> {
  const event = statusToLogEvent(entry.status);
  const ok = entry.status === 'ok';
  const wrapped = {
    ts: Date.now(),
    event,
    ok,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    meta: entry,
  };
  if (overridePath !== undefined) {
    try {
      await mkdir(dirname(overridePath), { recursive: true });
      await appendFile(overridePath, JSON.stringify(wrapped) + '\n', 'utf8');
    } catch (err) {
      process.stderr.write(`auto-extract: audit-log write failed: ${(err as Error).message}\n`);
    }
    return;
  }
  try {
    await appendLog({
      event,
      ok,
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      // LogEntry.meta is typed `Record<string, unknown>` — AuditEntry is a
      // strictly-typed interface, so we widen via spread (no runtime cost).
      meta: { ...entry } as Record<string, unknown>,
    });
  } catch (err) {
    process.stderr.write(`auto-extract: audit-log write failed: ${(err as Error).message}\n`);
  }
}

/**
 * Estimate redaction "hits" by counting `[REDACTED:` markers introduced by the
 * pipeline. Cheap and good enough for an audit log signal.
 */
function countRedactionHits(before: string, after: string): number {
  const beforeCount = (before.match(/\[REDACTED:/g) ?? []).length;
  const afterCount = (after.match(/\[REDACTED:/g) ?? []).length;
  return Math.max(0, afterCount - beforeCount);
}

function parsePositiveInt(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

// Keep the imports above marked as used for downstream type references.
void readFile;
void stat;

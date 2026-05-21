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
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
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
import { MemoryStore } from '../memory/memory-store.js';

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
  | 'skipped:project-disabled'
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
  | 'error:write-all-failed'
  | 'error:uncaught'
  | 'error:remote-llm-blocked'
  | 'error:no-model'
  | 'partial:berry-flag'
  | 'partial:write';

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
  readonly lessons_failed?: number;
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
  /**
   * Phase 6 (delta extraction) — fetch existing memories for the workdir so the
   * extractor can diff against known patterns. Default constructs MemoryStore
   * and pulls top-50 candidates (~2000 token budget). Tests inject stubs.
   */
  readonly getExistingMemories?: (workdir: string) => readonly import('../memory/types.js').Memory[];
  readonly now?: () => number;
  readonly auditPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * T9 — model auto-discovery seam. Returns the first IDLE model id reported
   * by `lms ps --json`, or `null` when no idle model is available. Defaults
   * to spawning the real `lms` binary; tests inject a deterministic stub.
   */
  readonly discoverModel?: () => Promise<string | null>;
}

type ConsentLoadResultLike =
  | { ok: true; consent: ConsentConfig }
  | { ok: false; reason: string; detail?: string };

const DEFAULT_ENDPOINT = 'http://localhost:1234';
const DEFAULT_TIMEOUT_MS = 25_000;
const TTL_HOURS_30_DAYS = 30 * 24;
const LMS_DISCOVERY_TIMEOUT_MS = 4_000;
/** Hosts treated as local for T4 endpoint validation. IPv6 brackets stripped first. */
const LOCALHOST_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export async function executeMemoryAutoExtractCommand(
  args: AutoExtractArgs,
  io: CliIO,
  deps: AutoExtractDeps = {}
): Promise<number> {
  // T3 — top-level safety net. CC's SessionEnd hook discards stderr and the
  // exit code, but a thrown exception would still surface in process.uncaughtException
  // listeners and could be visible in CC logs. Catch ANY uncaught failure here,
  // write `error:uncaught` to the audit log, and return exit 0.
  try {
    return await runPipeline(args, io, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : undefined;
    try {
      await appendAudit(
        {
          ts: new Date().toISOString(),
          session_id: null,
          cwd: null,
          status: 'error:uncaught',
          error: message,
          ...(stack ? { note: stack.split('\n').slice(0, 3).join(' | ') } : {}),
        },
        deps.auditPath
      );
    } catch {
      // appendAudit already swallows its own errors, but defend against any
      // other unforeseen failure here. The hook MUST never throw.
    }
    if (args.json) {
      try {
        io.stdout(JSON.stringify({ status: 'error:uncaught', error: message }) + '\n');
      } catch {
        // io.stdout is a callback; if even that throws there's nothing we can do.
      }
    }
    return 0;
  }
}

async function runPipeline(
  args: AutoExtractArgs,
  io: CliIO,
  deps: AutoExtractDeps
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

  // 1a. project opt-out — `relay project disable` writes `.relayignore` at the
  // project root signalling that ALL Relay automation (extract/recall/hook/
  // share) must be suppressed for that workdir. Honour the marker BEFORE
  // loading the transcript or any LLM call so opted-out projects never have
  // their tool output reach the extraction model or get persisted as memory.
  //
  // This check intentionally runs ahead of consent loading so that even a
  // `consent.json` with `enabled:true` cannot override a project-level
  // opt-out — the explicit `disable` action is the stronger signal.
  if (await isProjectOptedOut(payload.value.cwd)) {
    await emit(io, args, 'skipped:project-disabled', audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status: 'skipped:project-disabled',
      duration_ms: now() - startedAt,
    });
    return 0;
  }

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
  // T5: extend the built-in patterns with the user's
  // `consent.extra_redaction_patterns`. Each entry is compiled as
  // `new RegExp(pattern, 'g')` inside a try/catch in `redactSecretsAndPII` —
  // a malformed user pattern is logged here and silently skipped so it can
  // never break the pipeline. Unified replacement for every user match is
  // `[REDACTED:USER_PATTERN]` (per-pattern `replacement` is intentionally
  // ignored to prevent the user file from smuggling structured tokens).
  const patternErrors: Array<{ name: string; error: string }> = [];
  const redactDefault = (text: string): string =>
    redactSecretsAndPII(
      text,
      consent.extra_redaction_patterns,
      (name, err) => patternErrors.push({ name, error: err.message }),
    );
  const redact = deps.redact ?? redactDefault;
  const redactedTranscript = redact(window.jsonl);
  const redactionHits = countRedactionHits(window.jsonl, redactedTranscript);

  // 7. LM Studio extraction
  const endpoint = String(env['RELAY_AUTO_EXTRACT_ENDPOINT'] ?? DEFAULT_ENDPOINT);
  const timeoutMs = parsePositiveInt(env['RELAY_AUTO_EXTRACT_TIMEOUT_MS']) ?? DEFAULT_TIMEOUT_MS;

  // T4 — endpoint host validation. Refuse non-localhost endpoints unless the
  // user has explicitly opted in via consent.allow_remote=true. This protects
  // transcripts from being shipped to a remote LLM by accident (env var typo,
  // shared shell config, malicious actor).
  if (!isLocalEndpoint(endpoint) && consent.allow_remote !== true) {
    await emit(io, args, 'error:remote-llm-blocked', audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status: 'error:remote-llm-blocked',
      provider,
      turns_read: window.turnsRead,
      transcript_bytes: window.bytes,
      redaction_hits: redactionHits,
      duration_ms: now() - startedAt,
      error:
        `endpoint '${endpoint}' is not localhost. To allow remote endpoints, ` +
        `set "allow_remote": true in <cwd>/.relay/auto-extract.json. ` +
        `Localhost hosts: 127.0.0.1, ::1, localhost.`,
    });
    return 0;
  }

  // T9 — model resolution. Order: env var → consent.model → auto-discover
  // first IDLE local model via `lms ps --json`. No hard-coded default — if
  // every layer is empty we surface error:no-model with actionable guidance.
  const modelResolution = await resolveModel(env, consent, deps);
  if (modelResolution.kind === 'none') {
    await emit(io, args, 'error:no-model', audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status: 'error:no-model',
      provider,
      turns_read: window.turnsRead,
      transcript_bytes: window.bytes,
      redaction_hits: redactionHits,
      duration_ms: now() - startedAt,
      error:
        'No extraction model configured. Resolution order: ' +
        '(1) RELAY_AUTO_EXTRACT_MODEL env var, ' +
        '(2) "model" field in <cwd>/.relay/auto-extract.json, ' +
        '(3) first IDLE model from `lms ps --json`. ' +
        'Load a model in LM Studio (e.g. `lms load <model-id>`) ' +
        'or set RELAY_AUTO_EXTRACT_MODEL=<model-id>.',
    });
    return 0;
  }
  const model = modelResolution.model;

  const extract = deps.extractLessons ?? extractLessonsViaLmStudio;
  // Phase 6 T4 — fetch existing memories to enable delta extraction. Default
  // pulls top candidates from MemoryStore for the workdir (~2000 token budget,
  // bounded by getCandidates 500-row hard cap). Failure: empty list, extractor
  // falls back to v0.1 behavior (no delta directive).
  const getExisting =
    deps.getExistingMemories ??
    ((workdir: string) => {
      try {
        const store = new MemoryStore();
        return store.getCandidates({ workdir, token_budget: 2000 });
      } catch {
        return [];
      }
    });
  const existingMemories = (() => {
    try {
      return getExisting(payload.value.cwd);
    } catch {
      return [];
    }
  })();
  const extraction = await extract({
    transcript: redactedTranscript,
    endpoint,
    model,
    timeoutMs,
    existingMemories,
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

  // 9. optional Berry hallucination check (per lesson) — see T29.
  //
  // When `RELAY_BERRY_CMD` is unset, the helper returns
  // `{ ok: 'unavailable', details: { reason: 'berry-not-configured' } }` and
  // we MUST NOT block the write — the gate is opt-in, not mandatory. We
  // record per-lesson `skipped:berry-not-configured` in the audit `note`
  // field for visibility.
  //
  // When the helper returns any *other* `unavailable` outcome (timeout,
  // spawn error), the existing `RELAY_AUTO_EXTRACT_REQUIRE_BERRY=1` policy
  // still applies — strict operators can still hard-fail on infrastructure
  // problems they care about.
  const requireBerry = env['RELAY_AUTO_EXTRACT_REQUIRE_BERRY'] === '1';
  const berryCheck = deps.checkBerry ?? checkLessonViaBerry;
  const transcriptSpans = [
    { source: `transcript:${payload.value.session_id}`, text: redactedTranscript },
  ];

  const survivors: ExtractedLessonT[] = [];
  let anyFlagged = false;
  let berrySkippedNotConfigured = 0;
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
    const reason =
      outcome.ok === 'unavailable' &&
      outcome.details &&
      typeof outcome.details === 'object' &&
      (outcome.details as { reason?: unknown }).reason === 'berry-not-configured'
        ? 'berry-not-configured'
        : undefined;

    if (outcome.ok === 'flagged') {
      anyFlagged = true;
      continue;
    }
    // Berry not configured → never blocks (per T29 spec).
    if (reason === 'berry-not-configured') {
      berrySkippedNotConfigured += 1;
      survivors.push(lesson);
      continue;
    }
    // Other unavailable outcomes (timeout, spawn error) honour REQUIRE_BERRY.
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

  // 10. write surviving lessons through internal handleRemember.
  //
  // T10 — per-lesson outcome tracking. We attempt every lesson independently
  // (no early break), then bucket the result:
  //   - all succeed                → existing `ok` (or `partial:berry-flag` if Berry flagged earlier)
  //   - some succeed, some throw   → `partial:write` with lessons_written/lessons_failed counts
  //   - all throw                  → `error:write-all-failed`
  const remember = deps.remember ?? handleRemember;
  let written = 0;
  let failed = 0;
  const writeErrors: string[] = [];
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
      failed += 1;
      writeErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // All lessons failed → error:write-all-failed (replaces the legacy `error:write`
  // bucket; we keep `error:write` in the union for backward compat with consumers
  // reading old audit logs).
  if (failed > 0 && written === 0) {
    await emit(io, args, 'error:write-all-failed', audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status: 'error:write-all-failed',
      provider,
      model,
      turns_read: window.turnsRead,
      transcript_bytes: window.bytes,
      redaction_hits: redactionHits,
      lessons_written: 0,
      lessons_failed: failed,
      duration_ms: now() - startedAt,
      error: writeErrors.join(' | '),
    });
    return 0;
  }

  // Some succeeded, some failed → partial:write (Berry flag, if any, is
  // subsumed — write-side partial takes precedence because it surfaces a
  // recoverable but non-trivial state to the operator).
  if (failed > 0) {
    await emit(io, args, 'partial:write', audit, {
      ts: new Date().toISOString(),
      session_id: payload.value.session_id,
      cwd: payload.value.cwd,
      status: 'partial:write',
      provider,
      model,
      turns_read: window.turnsRead,
      transcript_bytes: window.bytes,
      redaction_hits: redactionHits,
      lessons_written: written,
      lessons_failed: failed,
      duration_ms: now() - startedAt,
      error: writeErrors.join(' | '),
    });
    return 0;
  }

  const finalStatus: AutoExtractStatus = anyFlagged ? 'partial:berry-flag' : 'ok';
  // Build audit `note` aggregating per-lesson Berry skips + bad consent
  // patterns. Keeps the audit log honest about why some lessons may have
  // bypassed the gate.
  const noteParts: string[] = [];
  if (berrySkippedNotConfigured > 0) {
    noteParts.push(`skipped:berry-not-configured x${berrySkippedNotConfigured}`);
  }
  if (patternErrors.length > 0) {
    noteParts.push(
      `bad-user-pattern: ${patternErrors.map((p) => p.name).join(',')}`,
    );
  }
  const note = noteParts.length > 0 ? noteParts.join('; ') : undefined;

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
    ...(writeErrors.length > 0 ? { error: writeErrors.join(' | ') } : {}),
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

/**
 * Project opt-out check — returns true when `<workdir>/.relayignore` exists.
 *
 * The `.relayignore` file is written by `relay project disable` (see
 * `cmd-project.ts`) and signals that ALL Relay automation must be suppressed
 * for that workdir. The marker takes precedence over any per-feature consent
 * file — an explicit `disable` action is the stronger user signal than a
 * forgotten `consent.json` left around from earlier opt-in.
 *
 * File-local intentionally — the marker is a simple file existence check and
 * does not warrant export. Keeping it private prevents accidental coupling
 * to other modules (another agent may be editing memory-store.ts in parallel).
 */
async function isProjectOptedOut(workdir: string): Promise<boolean> {
  try {
    await stat(join(workdir, '.relayignore'));
    return true;
  } catch {
    return false;
  }
}

/**
 * T4 — return true when `endpoint` resolves to a localhost host.
 *
 * Localhost = `127.0.0.1`, `::1`, or `localhost`. Any unparseable URL is
 * treated as non-local (fail-closed). IPv6 brackets are stripped before
 * comparison so `http://[::1]:1234` matches.
 */
export function isLocalEndpoint(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  // URL.hostname keeps IPv6 brackets stripped by spec, but be defensive.
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return LOCALHOST_HOSTS.has(host);
}

type ModelResolution = { kind: 'ok'; model: string } | { kind: 'none' };

/**
 * T9 — resolve the extraction model id without a hard-coded default.
 *
 * Resolution order:
 *   1. `RELAY_AUTO_EXTRACT_MODEL` environment variable (op-level override)
 *   2. `consent.model` from `<cwd>/.relay/auto-extract.json` (project-level pin)
 *   3. First IDLE model returned by `lms ps --json` (auto-discovery)
 *
 * Returns `{ kind: 'none' }` when every layer is empty so the caller can emit
 * `error:no-model` with actionable guidance.
 */
async function resolveModel(
  env: NodeJS.ProcessEnv,
  consent: ConsentConfig,
  deps: AutoExtractDeps
): Promise<ModelResolution> {
  const fromEnv = env['RELAY_AUTO_EXTRACT_MODEL'];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return { kind: 'ok', model: fromEnv.trim() };
  }
  if (typeof consent.model === 'string' && consent.model.trim().length > 0) {
    return { kind: 'ok', model: consent.model.trim() };
  }
  const discover = deps.discoverModel ?? discoverModelViaLms;
  let discovered: string | null;
  try {
    discovered = await discover();
  } catch {
    // Defensive — discovery is best-effort, never crashes the hook.
    discovered = null;
  }
  if (typeof discovered === 'string' && discovered.length > 0) {
    return { kind: 'ok', model: discovered };
  }
  return { kind: 'none' };
}

interface LmsPsEntry {
  readonly identifier?: string;
  readonly modelKey?: string;
  readonly path?: string;
  readonly state?: string;
}

/**
 * Default model auto-discovery — shells out to `lms ps --json` and returns the
 * first model identifier whose `state` is `idle` (case-insensitive). Returns
 * `null` when the binary is missing, returns garbage, or no idle model exists.
 *
 * The output shape from `lms` is `[{ identifier, modelKey, state, ... }]`.
 * Identifiers preferred over `modelKey` since identifiers match what the
 * `/v1/chat/completions` endpoint accepts. We accept either to stay forgiving
 * against future `lms` versions.
 */
async function discoverModelViaLms(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(
      'lms',
      ['ps', '--json'],
      { encoding: 'utf-8', timeout: LMS_DISCOVERY_TIMEOUT_MS },
      (err, stdoutData) => {
        if (err) {
          resolve(null);
          return;
        }
        // encoding: 'utf-8' guarantees stdoutData is a string here.
        resolve(parseLmsPsOutput(stdoutData as string));
      }
    );
  });
}

/** Visible for unit testing. Returns the first IDLE model id or null. */
export function parseLmsPsOutput(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const raw of parsed as LmsPsEntry[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const state = typeof raw.state === 'string' ? raw.state.toLowerCase() : '';
    if (state !== 'idle') continue;
    const id =
      typeof raw.identifier === 'string' && raw.identifier.length > 0
        ? raw.identifier
        : typeof raw.modelKey === 'string' && raw.modelKey.length > 0
          ? raw.modelKey
          : null;
    if (id !== null) return id;
  }
  return null;
}

// Keep the imports above marked as used for downstream type references.
void readFile;

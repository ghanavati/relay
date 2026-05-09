/**
 * T15 — Berry hallucination check helper.
 *
 * Optional gate before auto-extracted memory is written to the store. Calls a
 * local Berry MCP endpoint (default: `http://127.0.0.1:8765/detect-hallucination`)
 * with the candidate lesson + transcript spans as evidence. If Berry is
 * unreachable or times out, returns `'unavailable'` so the caller can decide
 * (gated by `RELAY_AUTO_EXTRACT_REQUIRE_BERRY` env).
 *
 * No relay runtime imports — self-contained and pure aside from `fetch`.
 */

export type BerryCheckOutcome = 'pass' | 'flagged' | 'unavailable';

export interface BerryCheckResult {
  readonly ok: BerryCheckOutcome;
  readonly details?: unknown;
}

export interface TranscriptSpan {
  readonly source: string;
  readonly text: string;
}

export interface CheckLessonOptions {
  readonly lessonContent: string;
  readonly transcriptSpans: readonly TranscriptSpan[];
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_ENDPOINT = process.env['RELAY_BERRY_ENDPOINT']
  ?? 'http://127.0.0.1:8765/detect-hallucination';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Detect whether the auto-extracted lesson is grounded in the provided
 * transcript spans. Returns:
 *   - 'pass'        → Berry verified the claim against evidence
 *   - 'flagged'     → Berry says the claim is not supported
 *   - 'unavailable' → endpoint unreachable, timed out, or returned an unparseable shape
 */
export async function checkLessonViaBerry(
  opts: CheckLessonOptions
): Promise<BerryCheckResult> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!opts.lessonContent.trim()) {
    return { ok: 'unavailable', details: { reason: 'empty_lesson' } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        answer: opts.lessonContent,
        spans: opts.transcriptSpans.map(s => ({ source: s.source, text: s.text })),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: 'unavailable', details: { status: response.status } };
    }

    const parsed = await safeJson(response);
    if (parsed === undefined) {
      return { ok: 'unavailable', details: { reason: 'invalid_json' } };
    }

    const verdict = interpretBerryVerdict(parsed);
    return { ok: verdict, details: parsed };
  } catch (err) {
    // Network error, abort, DNS failure → caller falls back per env policy.
    return { ok: 'unavailable', details: { error: (err as Error).message } };
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Berry's MCP shape varies across versions. We accept either:
 *   { hallucinated: boolean }  → most common
 *   { ok: 'pass'|'flagged' }   → newer normalized envelope
 *   { verdict: 'supported'|'unsupported' }  → legacy
 * Anything else → 'unavailable'.
 */
function interpretBerryVerdict(payload: unknown): BerryCheckOutcome {
  if (!payload || typeof payload !== 'object') return 'unavailable';
  const obj = payload as Record<string, unknown>;

  if (typeof obj['hallucinated'] === 'boolean') {
    return obj['hallucinated'] ? 'flagged' : 'pass';
  }
  if (obj['ok'] === 'pass' || obj['ok'] === 'flagged') {
    return obj['ok'];
  }
  if (obj['verdict'] === 'supported') return 'pass';
  if (obj['verdict'] === 'unsupported') return 'flagged';
  return 'unavailable';
}

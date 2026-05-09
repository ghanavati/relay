/**
 * T11: Validation schema + JSON cleanup for LLM-extracted lessons.
 *
 * The auto-extraction runner (T9/T10) prompts a small model (qwen via LM Studio)
 * to emit JSON describing memory candidates. Models lie, hallucinate, leak
 * sentinels, and wrap output in markdown fences. This module is the single
 * boundary that decides whether an extraction result reaches the memory store.
 *
 * Reject early — bad data must NEVER touch SQLite.
 */

import { z } from 'zod';

/** Single extracted memory candidate. Fields mirror MemoryStore.upsert minus storage metadata. */
export const ExtractedLesson = z.object({
  content: z.string().min(10).max(200),
  memory_type: z.enum(['lesson', 'fact', 'decision']),
  confidence: z.number().min(0).max(1),
});

/** Top-level shape: a bounded array of candidates. Cap at 3 to avoid noisy runs. */
export const ExtractionResult = z.object({
  lessons: z.array(ExtractedLesson).max(3),
});

export type ExtractedLessonT = z.infer<typeof ExtractedLesson>;

export type CleanupOk = {
  readonly ok: true;
  readonly lessons: readonly ExtractedLessonT[];
};

export type CleanupFailReason =
  | 'parse-error'
  | 'schema-error'
  | 'low-confidence'
  | 'redaction-leak';

export type CleanupFail = {
  readonly ok: false;
  readonly reason: CleanupFailReason;
  readonly detail?: string;
};

export type CleanupResult = CleanupOk | CleanupFail;

/** Strip ```json … ``` (or plain ```) fences that qwen and similar models love to add. */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  // Match ```<lang>?\n...\n``` — capture inner body. Handles trailing whitespace.
  const fenceMatch = /^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(trimmed);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

/** Detect if any lesson smuggled in a redaction sentinel from the upstream redactor. */
function hasRedactionLeak(lessons: readonly ExtractedLessonT[]): ExtractedLessonT | null {
  for (const lesson of lessons) {
    if (lesson.content.includes('[REDACTED:')) {
      return lesson;
    }
  }
  return null;
}

/**
 * Clean and validate raw LLM output.
 *
 * Steps:
 * 1. Strip optional code fences (qwen wraps output)
 * 2. JSON.parse — catch parse errors
 * 3. Validate with ExtractionResult schema
 * 4. Reject if any lesson content contains "[REDACTED:" (LLM leaked sentinel back)
 * 5. Filter out lessons below minConfidence
 * 6. Return ok + filtered lessons OR ok=false with reason
 *
 * @param raw       LLM-emitted string, potentially fenced
 * @param minConfidence Lessons below this confidence are filtered. Default 0.6.
 */
export function cleanupAndValidate(
  raw: string,
  minConfidence: number = 0.6
): CleanupResult {
  const cleaned = stripCodeFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'parse-error', detail };
  }

  const validation = ExtractionResult.safeParse(parsed);
  if (!validation.success) {
    return {
      ok: false,
      reason: 'schema-error',
      detail: validation.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }

  const allLessons = validation.data.lessons;

  const leaked = hasRedactionLeak(allLessons);
  if (leaked !== null) {
    return {
      ok: false,
      reason: 'redaction-leak',
      detail: `lesson content contains [REDACTED:] sentinel`,
    };
  }

  const kept = allLessons.filter((lesson) => lesson.confidence >= minConfidence);
  if (kept.length === 0) {
    return {
      ok: false,
      reason: 'low-confidence',
      detail: `all ${allLessons.length} lessons below minConfidence=${minConfidence}`,
    };
  }

  // Immutability: new array, do not mutate `kept`.
  return { ok: true, lessons: [...kept] };
}

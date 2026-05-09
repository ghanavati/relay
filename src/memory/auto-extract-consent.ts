/**
 * T13 — per-workdir consent file for auto-extraction.
 *
 * File-based opt-IN. Default is opt-OUT: if `<workdir>/.relay/auto-extract.json`
 * does not exist, auto-extraction is disabled. The consent file declares what
 * the user has agreed to (remote provider use, byte caps, custom redaction).
 *
 * No mutation: every loader path returns a fresh object.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** On-disk schema for `<workdir>/.relay/auto-extract.json`. */
export const ConsentFile = z.object({
  enabled: z.boolean(),
  enabled_at: z.number().optional(),
  allow_remote: z.boolean().default(false),
  max_bytes: z.number().int().positive().default(32_768),
  min_confidence: z.number().min(0).max(1).default(0.6),
  extra_redaction_patterns: z
    .array(
      z.object({
        name: z.string().max(60),
        pattern: z.string().max(500),
        replacement: z.string().max(60),
      }),
    )
    .default([]),
});

export type ConsentConfig = z.infer<typeof ConsentFile>;

export type ConsentLoadResult =
  | { ok: true; consent: ConsentConfig }
  | {
      ok: false;
      reason: 'no-file' | 'parse-error' | 'schema-error' | 'invalid-regex';
      detail?: string;
    };

/** Path to the per-workdir consent file. Relative to the given workdir. */
export function consentFilePath(workdir: string): string {
  return join(workdir, '.relay', 'auto-extract.json');
}

/**
 * Load and validate the consent file for `workdir`.
 *
 * Returns a discriminated result so callers can distinguish "no consent" (the
 * common path — opt-out by default) from real failures (malformed JSON,
 * schema violation, invalid regex).
 *
 * Every `extra_redaction_patterns[i].pattern` is compile-tested via `new
 * RegExp` so a broken pattern cannot reach the redaction pipeline at write
 * time. The first invalid regex wins; subsequent ones are not reported.
 */
export async function loadConsent(workdir: string): Promise<ConsentLoadResult> {
  const path = consentFilePath(workdir);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'no-file' };
    return {
      ok: false,
      reason: 'parse-error',
      detail: `read failed: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: 'parse-error',
      detail: `invalid JSON: ${(err as Error).message}`,
    };
  }

  const validated = ConsentFile.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      reason: 'schema-error',
      detail: validated.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; '),
    };
  }

  const consent = validated.data;
  for (const entry of consent.extra_redaction_patterns) {
    try {
      new RegExp(entry.pattern);
    } catch (err) {
      return {
        ok: false,
        reason: 'invalid-regex',
        detail: `pattern "${entry.name}" is not a valid regex: ${(err as Error).message}`,
      };
    }
  }

  return { ok: true, consent };
}

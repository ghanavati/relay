/**
 * Transcript window loader for `relay memory auto-extract`.
 *
 * CC writes per-session transcripts as JSONL — one JSON object per line. We
 * walk backwards from EOF to grab the most recent N bytes (capped) so the
 * extractor sees only the freshest turns. Tool result bodies > 4 KB are
 * truncated inline so a single big bash output doesn't blow the budget.
 *
 * Pure module: only `readFileSync` to read the source file. No DB, no network.
 */

import { readFileSync, statSync } from 'node:fs';

export interface TranscriptWindow {
  readonly jsonl: string;
  readonly turnsRead: number;
  readonly bytes: number;
}

/** Default budget for the window (bytes). Roughly ~8K tokens at 4 char/tok. */
export const DEFAULT_WINDOW_BYTES = 32 * 1024;

/** Per-tool-result body cap. Above this, we replace with a placeholder. */
const TOOL_RESULT_BODY_CAP = 4 * 1024;

/**
 * Load the trailing window of a CC transcript file.
 *
 * Strategy: read the entire file (CC transcripts are typically <10 MB; the cost
 * of a streaming reverse reader isn't justified for v1), split into lines, walk
 * the lines from the END accumulating bytes until we hit `maxBytes`, then
 * reverse-truncate any oversized tool result bodies inline.
 *
 * Returns an empty window for missing/empty/unreadable files (defensive — the
 * caller must already have validated `path` exists if it cares).
 */
export function loadRecentTranscriptWindow(
  path: string,
  maxBytes: number = DEFAULT_WINDOW_BYTES
): TranscriptWindow {
  if (maxBytes <= 0) return { jsonl: '', turnsRead: 0, bytes: 0 };

  let raw: string;
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return { jsonl: '', turnsRead: 0, bytes: 0 };
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // Defensive: a hook-driven path may race with file deletion. Log to stderr
    // so loss is observable but never throw — the caller cannot recover and
    // the SessionEnd hook must not block CC.
    process.stderr.write(`auto-extract: cannot read transcript at ${path}: ${(err as Error).message}\n`);
    return { jsonl: '', turnsRead: 0, bytes: 0 };
  }

  // Split on \n and drop trailing empty (file ends with \n). We keep blank
  // lines in the middle as-is so byte counting matches what we emit.
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return { jsonl: '', turnsRead: 0, bytes: 0 };

  // Walk backwards, accumulating until we hit the byte cap.
  const collected: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const truncated = truncateToolResultIfLarge(line, TOOL_RESULT_BODY_CAP);
    // +1 for the join newline
    const lineBytes = Buffer.byteLength(truncated, 'utf8') + 1;
    if (bytes + lineBytes > maxBytes && collected.length > 0) break;
    collected.push(truncated);
    bytes += lineBytes;
    if (bytes >= maxBytes) break;
  }

  // We pushed in reverse order — flip back to chronological.
  collected.reverse();
  const jsonl = collected.join('\n');
  return {
    jsonl,
    turnsRead: collected.length,
    bytes: Buffer.byteLength(jsonl, 'utf8'),
  };
}

/**
 * If a JSONL line carries a tool result with a body > cap, replace the body
 * with a `[truncated tool result, NN bytes]` placeholder while preserving
 * the surrounding structure. We keep this conservative: only touch the
 * largest string fields we can find inside `tool_use_result` / `content`.
 *
 * Non-JSON lines pass through untouched.
 */
function truncateToolResultIfLarge(line: string, cap: number): string {
  if (Buffer.byteLength(line, 'utf8') <= cap) return line;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return line; }
  if (!parsed || typeof parsed !== 'object') return line;

  const obj = parsed as Record<string, unknown>;
  const result = truncateToolResultFields(obj, cap);
  if (!result.changed) {
    // No tool-result field large enough — fall back to a hard cap on the whole line.
    const original = Buffer.byteLength(line, 'utf8');
    return `{"_truncated":"oversized transcript line, ${original} bytes"}`;
  }
  return JSON.stringify(result.value);
}

interface TruncResult {
  readonly value: Record<string, unknown>;
  readonly changed: boolean;
}

/**
 * Walk a parsed JSONL object looking for known tool-result-bearing shapes and
 * truncate any string body > cap. Returns a NEW object — never mutates input.
 *
 * Recognised shapes:
 *   { toolUseResult: { stdout: "..." } }
 *   { tool_use_result: { content: [{ type: "text", text: "..." }] } }
 *   { message: { content: [{ type: "tool_result", content: "..." }] } }
 *   Top-level { content: [{ type: "tool_result", content: "..." }] }
 */
function truncateToolResultFields(obj: Record<string, unknown>, cap: number): TruncResult {
  let changed = false;
  const next: Record<string, unknown> = { ...obj };

  // Shape 1: toolUseResult.stdout / .stderr (camelCase)
  const tur = next['toolUseResult'];
  if (tur && typeof tur === 'object') {
    const turObj = { ...(tur as Record<string, unknown>) };
    for (const k of ['stdout', 'stderr', 'output', 'text']) {
      const v = turObj[k];
      if (typeof v === 'string' && Buffer.byteLength(v, 'utf8') > cap) {
        turObj[k] = placeholder(v);
        changed = true;
      }
    }
    next['toolUseResult'] = turObj;
  }

  // Shape 2: snake_case tool_use_result with content array
  const turSnake = next['tool_use_result'];
  if (turSnake && typeof turSnake === 'object') {
    const snakeObj = { ...(turSnake as Record<string, unknown>) };
    const contentRes = truncateContentArray(snakeObj['content'], cap);
    if (contentRes.changed) {
      snakeObj['content'] = contentRes.value;
      changed = true;
    }
    next['tool_use_result'] = snakeObj;
  }

  // Shape 3 / 4: message.content[] or top-level content[]
  const msg = next['message'];
  if (msg && typeof msg === 'object') {
    const msgObj = { ...(msg as Record<string, unknown>) };
    const contentRes = truncateContentArray(msgObj['content'], cap);
    if (contentRes.changed) {
      msgObj['content'] = contentRes.value;
      changed = true;
    }
    next['message'] = msgObj;
  }

  const topContent = truncateContentArray(next['content'], cap);
  if (topContent.changed) {
    next['content'] = topContent.value;
    changed = true;
  }

  return { value: next, changed };
}

/** Returns a new array with oversized text/content fields truncated. */
function truncateContentArray(value: unknown, cap: number): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { value, changed: false };
  let changed = false;
  const next = value.map(item => {
    if (!item || typeof item !== 'object') return item;
    const it = { ...(item as Record<string, unknown>) };
    for (const k of ['text', 'content']) {
      const v = it[k];
      if (typeof v === 'string' && Buffer.byteLength(v, 'utf8') > cap) {
        it[k] = placeholder(v);
        changed = true;
      }
    }
    return it;
  });
  return { value: next, changed };
}

function placeholder(s: string): string {
  return `[truncated tool result, ${Buffer.byteLength(s, 'utf8')} bytes]`;
}

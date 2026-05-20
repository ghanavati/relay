/**
 * PLAN-4 T5 — Impure boundary for semantic recall.
 *
 * Owns:
 *   - Embed the query via embedding-client (LM Studio /v1/embeddings)
 *   - Decode candidate BLOBs (3072 bytes → Float32Array(768))
 *   - Cross-model rejection (skip rows embedded with a different model)
 *   - Cosine math, clamped to [0, 1]
 *   - Stderr-loud warning on failure, deduped per (process, reason)
 *
 * Does NOT own scoring math (memory-engine.ts) or DB access (memory-store.ts).
 * Callers (cmd-memory-ops, tools/memory_search, tools/recall) call this
 * BEFORE budgetedRecall and pass the returned Map as the 4th arg.
 *
 * Engine purity invariant: memory-engine.ts imports ONLY ./types. This
 * helper lives at the impure boundary so the engine never has to import
 * embedding-client, fetch, or DB code (PITFALL 2.1 / CC.4).
 */

import { embedQuery, EXPECTED_EMBEDDING_DIM, type EmbeddingResult } from './embedding-client.js';
import type { Memory, RecallQuery } from './types.js';

/**
 * Minimal surface this helper needs from MemoryStore. Defined as an interface
 * so tests can pass a stub instead of constructing a full DB-backed store.
 */
export interface SemanticSimilaritiesStore {
  getRawEmbeddings(ids: readonly string[]): Map<string, { blob: Buffer; model: string }>;
}

export interface SemanticSimilaritiesOptions {
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

/**
 * Module-scope dedup: helper is stateless, so dedup lives here (vs MemoryStore
 * instance scope for T2). Per-process Set of warning reasons already emitted.
 */
const warnedReasons = new Set<string>();

function warnSkipped(reason: string): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  process.stderr.write(
    `RELAY: embedding skipped (LM Studio /v1/embeddings ${reason}). ` +
      `Recall falling back to word-overlap. Run 'relay doctor' to check.\n`
  );
}

/** Test-only: reset module-scope dedup state between test runs. */
export function _resetWarnedReasonsForTesting(): void {
  warnedReasons.clear();
}

/**
 * Decode a 3072-byte BLOB (768 little-endian float32) into a Float32Array
 * VIEW (no copy when the underlying buffer is 4-byte-aligned, which Node's
 * `Buffer.from(typedArray.buffer, …)` guarantees). If alignment ever fails
 * we fall back to a copy — correctness over perf.
 */
export function blobToFloat32(blob: Buffer): Float32Array {
  const byteOffset = blob.byteOffset;
  const byteLength = blob.byteLength;
  // 4-byte alignment check — `byteOffset % 4 === 0` lets us share the buffer.
  if (byteOffset % 4 === 0) {
    return new Float32Array(blob.buffer, byteOffset, byteLength / 4);
  }
  // Fallback: copy the bytes into a fresh ArrayBuffer to satisfy alignment.
  const copy = new ArrayBuffer(byteLength);
  new Uint8Array(copy).set(new Uint8Array(blob.buffer, byteOffset, byteLength));
  return new Float32Array(copy);
}

/**
 * Cosine similarity in the general case (does NOT assume inputs are unit
 * vectors). Returns 0 when either input is zero-magnitude — protects callers
 * from NaN.
 *
 * Nomic-embed-text-v1.5 outputs L2-normalized vectors per the model card, so
 * cosine ≡ dot product for nomic. We compute full cosine anyway (≈ 100µs per
 * 768-dim pair) — defensive against future model swaps and against partial
 * normalization issues observed in some HuggingFace exports.
 */
export function cosineSimNormalized(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Build the candidate-id → cosine-similarity map for `budgetedRecall`.
 *
 * Short-circuits (returns empty Map, zero embed calls, zero warnings):
 *   - query.query is empty / undefined (tags-only recall)
 *   - RELAY_EMBEDDING_MODEL is unset (feature flag off)
 *   - candidates is empty
 *
 * Failure paths (return empty Map + one deduped stderr warning):
 *   - embedQuery returns { ok: false, reason }
 *   - response vector is wrong-dim (defense-in-depth — embedding-client
 *     already enforces 768)
 *
 * Never throws. Engine falls through to word-overlap for every row when the
 * returned Map is empty (T4 guarantee).
 *
 * Cross-model rejection: candidate rows whose `embedding_model` differs from
 * the active model are silently omitted — preserves PITFALL 2.3 invariant
 * (mixing vector spaces would corrupt cosine).
 */
export async function computeSemanticSimilarities(
  store: SemanticSimilaritiesStore,
  query: RecallQuery,
  candidates: readonly Memory[],
  opts?: SemanticSimilaritiesOptions
): Promise<ReadonlyMap<string, number>> {
  // ── Short-circuits ──────────────────────────────────────────────────────
  const queryText = query.query?.trim();
  if (!queryText) return new Map();
  const model = opts?.model ?? process.env['RELAY_EMBEDDING_MODEL'];
  if (!model) return new Map();
  if (candidates.length === 0) return new Map();

  const endpoint = opts?.endpoint ?? process.env['LMSTUDIO_ENDPOINT'] ?? 'http://127.0.0.1:1234';

  // ── Embed the query ─────────────────────────────────────────────────────
  const embedOpts: Parameters<typeof embedQuery>[1] = {
    endpoint,
    model,
    timeoutMs: opts?.timeoutMs ?? 5_000,
  };
  if (opts?.fetchImpl) {
    (embedOpts as { fetchImpl?: typeof fetch }).fetchImpl = opts.fetchImpl;
  }
  let qResult: EmbeddingResult;
  try {
    qResult = await embedQuery(queryText, embedOpts);
  } catch {
    // embedQuery never throws by contract — but mocks may misbehave.
    warnSkipped('exception');
    return new Map();
  }
  if (!qResult.ok || !qResult.vector) {
    warnSkipped(qResult.reason ?? 'unknown');
    return new Map();
  }
  if (qResult.vector.length !== EXPECTED_EMBEDDING_DIM) {
    // Defense-in-depth — embedding-client already enforces this.
    warnSkipped('wrong-dim');
    return new Map();
  }

  // ── Decode candidate blobs + cross-model rejection ──────────────────────
  const candidateIds = candidates.map((c) => c.memory_id);
  const rawByCandidate = store.getRawEmbeddings(candidateIds);

  const result = new Map<string, number>();
  for (const [id, { blob, model: rowModel }] of rawByCandidate) {
    if (rowModel !== model) continue; // cross-model: skip
    if (blob.byteLength !== EXPECTED_EMBEDDING_DIM * 4) continue; // corrupt: skip
    const docVec = blobToFloat32(blob);
    const raw = cosineSimNormalized(qResult.vector, docVec);
    // Clamp to [0, 1] (negative = anti-similar = not useful as recall signal).
    const clamped = Math.max(0, Math.min(1, raw));
    result.set(id, clamped);
  }

  return result;
}

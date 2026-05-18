/**
 * Embedding Client — LM Studio `/v1/embeddings` wrapper for nomic-embed-text-v1.5.
 *
 * Mirrors `auto-extract-runner.ts` patterns: probe + POST + AbortController
 * timeout, never throws, encodes every failure as a typed `reason` string.
 *
 * Key constraints (NOMIC-EMBED-SPECS.md + EMBEDDING-PATTERN.md):
 *   - Fixed 768-dim float32 output, asserted on every response. Wrong-dim
 *     responses are refused (a different model was swapped in).
 *   - `search_document: ` (trailing space) for stored memories.
 *   - `search_query: ` (trailing space) for user queries.
 *   - No `temperature`/`top_p` — embeddings don't sample.
 *   - `usage.prompt_tokens` is unreliable (LM Studio bug #1546) — ignored.
 *   - Module load asserts little-endian host: x86_64 / Apple Silicon are LE,
 *     big-endian machines are unsupported (raw Float32Array buffers wouldn't
 *     round-trip through BLOB storage).
 */

/** 768 floats × 4 bytes = 3072 bytes per stored embedding. */
export const EXPECTED_EMBEDDING_DIM = 768;

/** Default request timeout in ms when caller does not override. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Prefix nomic-embed-text-v1.5 requires when embedding stored documents. */
const STORE_PREFIX = 'search_document: ';

/** Prefix nomic-embed-text-v1.5 requires when embedding user queries. */
const QUERY_PREFIX = 'search_query: ';

/** Little-endian platform guard. Apple Silicon + x86_64 satisfy this. */
(function assertLittleEndian(): void {
  const probe = new Uint8Array(new Float32Array([1.0]).buffer);
  if (probe[0] !== 0x00 || probe[3] !== 0x3f) {
    throw new Error(
      'embedding-client: big-endian platform not supported (embedding BLOBs require little-endian host)'
    );
  }
})();

export type EmbeddingReason =
  | 'empty-input'
  | 'unreachable'
  | 'timeout'
  | 'http-500'
  | 'http-4xx'
  | 'parse-error'
  | 'wrong-dim'
  | 'not-loaded'
  | 'no-data';

export interface EmbeddingResult {
  readonly ok: boolean;
  readonly vector?: Float32Array;
  readonly reason?: EmbeddingReason;
  /** Populated when reason === 'wrong-dim'. */
  readonly got?: number;
  /** Optional human-readable detail for debugging (never user-facing). */
  readonly note?: string;
}

export interface EmbedOptions {
  readonly endpoint: string;
  readonly model: string;
  /** Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Injected for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

function trimEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

function getFetch(opts: EmbedOptions): typeof fetch {
  return opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
}

function classifyHttpReason(status: number): EmbeddingReason {
  if (status >= 500) return 'http-500';
  return 'http-4xx';
}

/**
 * Probe `${endpoint}/v1/models` and assert the requested embedding model is
 * loaded. Never throws.
 */
export async function probeEmbeddingsModel(
  opts: EmbedOptions
): Promise<EmbeddingResult> {
  const url = `${trimEndpoint(opts.endpoint)}/v1/models`;
  const fetchImpl = getFetch(opts);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        return { ok: false, reason: 'timeout', note: String(err) };
      }
      return { ok: false, reason: 'unreachable', note: String(err) };
    }
    if (!res.ok) {
      return { ok: false, reason: classifyHttpReason(res.status), note: `probe http ${res.status}` };
    }
    let body: { data?: Array<{ id?: unknown }> };
    try {
      body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    } catch (err) {
      return { ok: false, reason: 'parse-error', note: String(err) };
    }
    const ids = Array.isArray(body.data)
      ? body.data
          .map((entry) => (typeof entry?.id === 'string' ? entry.id : ''))
          .filter((id) => id.length > 0)
      : [];
    if (!ids.includes(opts.model)) {
      return { ok: false, reason: 'not-loaded', note: `loaded: ${ids.join(', ') || 'none'}` };
    }
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

interface EmbeddingResponse {
  readonly data?: Array<{ embedding?: unknown }>;
}

function extractEmbedding(json: unknown): number[] | null {
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as EmbeddingResponse;
  const data = obj.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (typeof first !== 'object' || first === null) return null;
  const embedding = (first as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding)) return null;
  // Validate that every element is a finite number (defensive — the model
  // should never return NaN/Infinity, but a malformed transport could).
  for (const v of embedding) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  return embedding as number[];
}

async function embedWithPrefix(
  prefix: string,
  text: string,
  opts: EmbedOptions
): Promise<EmbeddingResult> {
  // Empty / whitespace short-circuit — saves an HTTP roundtrip and avoids
  // ambiguous server behavior on empty inputs (some return zero-vector, some
  // 400, per NOMIC-EMBED-SPECS §9).
  if (!text || text.trim().length === 0) {
    return { ok: false, reason: 'empty-input' };
  }

  const url = `${trimEndpoint(opts.endpoint)}/v1/embeddings`;
  const fetchImpl = getFetch(opts);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  try {
    // NOMIC-EMBED-SPECS §3 — body has NO temperature/top_p/stream.
    const body = JSON.stringify({
      model: opts.model,
      input: `${prefix}${text}`,
    });

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return { ok: false, reason: 'timeout', note: String(err) };
      }
      return { ok: false, reason: 'unreachable', note: String(err) };
    }

    if (!res.ok) {
      return { ok: false, reason: classifyHttpReason(res.status), note: `http ${res.status}` };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      return { ok: false, reason: 'parse-error', note: String(err) };
    }

    const arr = extractEmbedding(json);
    if (arr === null) {
      // Distinguish "well-formed envelope with empty data" from "malformed
      // envelope" so tests / debug logs can tell them apart.
      if (
        typeof json === 'object' &&
        json !== null &&
        Array.isArray((json as EmbeddingResponse).data) &&
        (json as EmbeddingResponse).data!.length === 0
      ) {
        return { ok: false, reason: 'no-data' };
      }
      return { ok: false, reason: 'parse-error', note: 'missing data[0].embedding' };
    }

    // NOMIC-EMBED-SPECS §9 — wrong-dim means a different model was loaded.
    // Refuse to return the vector — caller MUST not store it.
    if (arr.length !== EXPECTED_EMBEDDING_DIM) {
      return { ok: false, reason: 'wrong-dim', got: arr.length };
    }

    const vector = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) vector[i] = arr[i]!;
    return { ok: true, vector };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed a stored document — prepends `search_document: ` (with trailing space)
 * before sending to nomic-embed-text-v1.5. Returns a 768-dim Float32Array on
 * success, an `EmbeddingResult` with `reason` on every failure path.
 * Never throws.
 */
export async function embedDocument(
  text: string,
  opts: EmbedOptions
): Promise<EmbeddingResult> {
  return embedWithPrefix(STORE_PREFIX, text, opts);
}

/**
 * Embed a user query — prepends `search_query: ` (with trailing space) before
 * sending to nomic-embed-text-v1.5. Returns a 768-dim Float32Array on success,
 * an `EmbeddingResult` with `reason` on every failure path. Never throws.
 */
export async function embedQuery(
  text: string,
  opts: EmbedOptions
): Promise<EmbeddingResult> {
  return embedWithPrefix(QUERY_PREFIX, text, opts);
}

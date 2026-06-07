/**
 * `relay context emit --target <cc|codex|lmstudio-http|lmstudio-cli>`
 *
 * Emits per-LLM-target wrapper format around recalled-memory markdown so each
 * LLM front-end can ingest a single command's stdout without bespoke jq/sed
 * pipelines. Replaces the messy jq pipeline previously used in the CC
 * SessionStart hook.
 *
 * Targets:
 *   - cc            → CC SessionStart hookSpecificOutput JSON envelope
 *   - codex         → plain markdown (caller writes to file, passes via
 *                     `-c model_instructions_file=`)
 *   - lmstudio-http → JSON fragment {"role":"system","content":"..."}
 *   - lmstudio-cli  → single-line text (newlines escaped) for `lms chat -s`
 *
 * Markdown body comes from loadRecalledLessonsContent() (src/context/layers.ts:199),
 * the same loader the SessionStart hook used. When no memories match, all
 * targets emit an empty-but-valid wrapper (empty string for cc/codex/cli, empty
 * content for the lmstudio-http JSON fragment) so callers do not need
 * conditional handling.
 */

import type { CliIO } from './commands.js';

export type EmitTarget = 'cc' | 'codex' | 'lmstudio-http' | 'lmstudio-cli';

export const VALID_EMIT_TARGETS: readonly EmitTarget[] = [
  'cc',
  'codex',
  'lmstudio-http',
  'lmstudio-cli',
] as const;

export type EmitMemoryType = 'lesson' | 'fact' | 'decision' | 'context' | 'state' | 'handoff' | 'session';

const VALID_EMIT_TYPES: readonly EmitMemoryType[] = [
  'lesson',
  'fact',
  'decision',
  'context',
  'state',
  'handoff',
  'session',
] as const;

/**
 * T1 — accepted values for `--min-trust` on `relay context emit`.
 *
 * Mirrors the recall trust ladder (`unverified < provisional < trusted`) with
 * an explicit `any` alias so callers can override the provisional default
 * back down to "no filter applied" without typing the loaded word
 * "unverified". `unverified` and `any` are equivalent — both disable the
 * filter so all tiers are returned.
 */
export type EmitMinTrust = 'any' | 'unverified' | 'provisional' | 'trusted';

export const VALID_EMIT_MIN_TRUST: readonly EmitMinTrust[] = [
  'any',
  'unverified',
  'provisional',
  'trusted',
] as const;

/**
 * T1 — default `--min-trust` for `relay context emit` (any target).
 *
 * Provisional excludes auto-extracted (unverified) memories so unverified
 * lessons cannot leak into a CC SessionStart, Codex `model_instructions_file`,
 * or LM Studio system prompt without an explicit override. Override-up
 * (`trusted`) and override-down (`any`/`unverified`) are honored when the
 * caller passes the flag explicitly.
 */
export const EMIT_MIN_TRUST_DEFAULT: 'provisional' = 'provisional';

/**
 * Parse a raw `--min-trust` value into the recall-layer tier string.
 *
 * - `undefined` → `EMIT_MIN_TRUST_DEFAULT` ('provisional')
 * - `'any'` → `'unverified'` (alias — disables the filter)
 * - `'unverified' | 'provisional' | 'trusted'` → passed through
 * - anything else → throws so the CLI dispatcher can surface a 2 exit code
 */
export function parseEmitMinTrust(
  raw: string | undefined
): 'unverified' | 'provisional' | 'trusted' {
  if (raw === undefined) return EMIT_MIN_TRUST_DEFAULT;
  if (!(VALID_EMIT_MIN_TRUST as readonly string[]).includes(raw)) {
    throw new Error(
      `--min-trust must be one of: ${VALID_EMIT_MIN_TRUST.join(', ')} (got: ${raw})`
    );
  }
  if (raw === 'any') return 'unverified';
  return raw as 'unverified' | 'provisional' | 'trusted';
}

export interface ContextEmitCommand {
  target: EmitTarget;
  workdir: string;
  tokenBudget: number;
  types: readonly EmitMemoryType[];
  /**
   * T1 — minimum trust tier for recalled memories. When omitted, defaults to
   * `EMIT_MIN_TRUST_DEFAULT` ('provisional') so unverified auto-extracted
   * lessons do not reach the LLM via SessionStart/instructions hooks.
   * Callers that explicitly want all tiers should pass `'unverified'` (which
   * the CLI surfaces as `--min-trust=any`).
   */
  minTrust?: 'unverified' | 'provisional' | 'trusted';
}

/**
 * Injectable dependencies for `executeContextEmitCommand`.
 *
 * `readStdin` overrides the default hook-payload reader. In production the
 * default reads the CC hook payload that Claude Code pipes to every hook
 * command's stdin; tests inject a stub so no real stdin is touched.
 */
export interface ContextEmitDeps {
  readStdin?: () => Promise<string>;
}

export function parseEmitTypes(raw: readonly string[]): EmitMemoryType[] {
  if (raw.length === 0) {
    return ['lesson', 'fact', 'decision', 'context'];
  }
  for (const t of raw) {
    if (!(VALID_EMIT_TYPES as readonly string[]).includes(t)) {
      throw new Error(`--types must be a comma list of: ${VALID_EMIT_TYPES.join(', ')} (got: ${t})`);
    }
  }
  return raw as EmitMemoryType[];
}

/** Encode markdown for `lms chat -s "<text>"` — collapse newlines to literal \n. */
function encodeForLmsCli(markdown: string): string {
  return markdown.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/**
 * Default hook-payload reader (Phase 8 / CONTROL-06). Claude Code pipes the
 * hook payload JSON to every hook command's stdin and closes the pipe, so a
 * read-until-EOF normally completes immediately. Guards:
 *   - TTY stdin (manual invocation) → no payload, never block the terminal.
 *   - node:test child processes (NODE_TEST_CONTEXT) → no payload; tests that
 *     exercise the hook path inject `deps.readStdin` instead.
 *   - already-consumed stdin → no payload.
 *   - a silent open pipe is bounded by `timeoutMs` — a hook must never hang
 *     CC startup waiting for input that is not coming.
 */
async function defaultReadHookStdin(timeoutMs = 250): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY === true) return '';
  if (process.env['NODE_TEST_CONTEXT'] !== undefined) return '';
  if (stdin.readableEnded) return '';

  return await new Promise<string>((resolve) => {
    let data = '';
    let settled = false;
    const onData = (chunk: Buffer | string): void => {
      data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', finish);
      stdin.off('error', finish);
      stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.on('data', onData);
    stdin.once('end', finish);
    stdin.once('error', finish);
    stdin.resume();
  });
}

interface ClaudeHookContext {
  hookEventName: 'SessionStart' | 'UserPromptSubmit' | 'SessionEnd';
  /** Rendered cross-session mailbox block ('' when nothing was queued). */
  mailboxBlock: string;
  /** SessionStart re-injects recalled memories; the other boundaries do not. */
  includeMemories: boolean;
}

/**
 * Resolve the CC hook context for `--target cc`: read the payload from stdin,
 * register/refresh/stop-mark the control session, and (except at SessionEnd)
 * drain the session's queued Relay messages through the registry so the same
 * broker/audit path real deliveries use records them (D-13).
 *
 * Returns undefined when no payload was piped (absence) — legacy behavior.
 * Every failure degrades gracefully: a hook must never break CC startup, so
 * parse and control-plane errors are reported on stderr and ignored.
 */
async function resolveClaudeHookContext(
  deps: ContextEmitDeps,
  io: CliIO
): Promise<ClaudeHookContext | undefined> {
  const readStdin = deps.readStdin ?? defaultReadHookStdin;
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    return undefined;
  }
  if (raw.trim().length === 0) return undefined;

  try {
    const { parseClaudeHookPayload, ClaudeCodeControlAdapter } = await import(
      '../control/adapters/claude-code.js'
    );
    const payload = parseClaudeHookPayload(raw);
    if (payload === undefined) return undefined;

    const { ControlSessionStore } = await import('../control/session-store.js');
    const store = new ControlSessionStore();
    const adapter = new ClaudeCodeControlAdapter(store);
    adapter.applyHookPayload(payload);

    if (payload.hook_event_name === 'SessionEnd') {
      // Stop-marking only — an ending session has no render boundary left,
      // so queued messages stay queued for inspection/expiry.
      return { hookEventName: 'SessionEnd', mailboxBlock: '', includeMemories: false };
    }

    const { ControlAdapterRegistry } = await import('../control/adapter-registry.js');
    const registry = new ControlAdapterRegistry(store);
    registry.register(adapter);
    await registry.deliverQueued(payload.session_id);
    const mailboxBlock = adapter.takePendingContext(payload.session_id) ?? '';

    return {
      hookEventName: payload.hook_event_name,
      mailboxBlock,
      includeMemories: payload.hook_event_name === 'SessionStart',
    };
  } catch (err) {
    io.stderr(
      `relay context emit: ignoring hook payload (${err instanceof Error ? err.message : String(err)})\n`
    );
    return undefined;
  }
}

export async function executeContextEmitCommand(
  command: ContextEmitCommand,
  io: CliIO,
  deps: ContextEmitDeps = {}
): Promise<number> {
  if (!(VALID_EMIT_TARGETS as readonly string[]).includes(command.target)) {
    io.stderr(
      `--target must be one of: ${VALID_EMIT_TARGETS.join(', ')} (got: ${command.target})\n`
    );
    return 2;
  }

  // Phase 8 / CONTROL-06: resolve the CC hook payload BEFORE the memory load
  // so non-SessionStart boundaries can skip the recall work entirely.
  const hookCtx = command.target === 'cc' ? await resolveClaudeHookContext(deps, io) : undefined;
  const includeMemories = hookCtx === undefined || hookCtx.includeMemories;

  let body = '';
  if (includeMemories) {
    const { loadRecalledLessonsContent } = await import('../context/layers.js');
    // T1 — default to 'provisional' so unverified memories never leak into
    // CC SessionStart / Codex instructions / LM Studio system prompts unless
    // the caller explicitly passes `--min-trust=any` (or `unverified`).
    const minTrust = command.minTrust ?? EMIT_MIN_TRUST_DEFAULT;
    const markdown = await loadRecalledLessonsContent(command.workdir, undefined, undefined, {
      types: command.types,
      tokenBudget: command.tokenBudget,
      minTrust,
    });
    body = markdown ?? '';
  }

  switch (command.target) {
    case 'cc': {
      const parts = [body, hookCtx?.mailboxBlock ?? ''].filter((part) => part.length > 0);
      const envelope = {
        hookSpecificOutput: {
          hookEventName: hookCtx?.hookEventName ?? 'SessionStart',
          additionalContext: parts.join('\n\n'),
        },
      };
      io.stdout(`${JSON.stringify(envelope)}\n`);
      return 0;
    }
    case 'codex': {
      // Codex consumes plain markdown via `-c model_instructions_file=<path>`.
      // No envelope, no trailing newline — caller pipes to a file.
      io.stdout(body);
      return 0;
    }
    case 'lmstudio-http': {
      const fragment = { role: 'system', content: body };
      io.stdout(`${JSON.stringify(fragment)}\n`);
      return 0;
    }
    case 'lmstudio-cli': {
      io.stdout(`${encodeForLmsCli(body)}\n`);
      return 0;
    }
  }
}

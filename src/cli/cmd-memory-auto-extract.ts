/**
 * `relay memory auto-extract --from-stdin` — wired to Claude Code's SessionEnd hook.
 *
 * CC sends JSON on stdin: `{ session_id, transcript_path, cwd, hook_event_name }`.
 * We:
 *   1. Parse & validate the payload (Zod).
 *   2. Verify per-workdir consent at `<cwd>/.relay/auto-extract.json` (T13 owns the file format).
 *   3. Load the trailing transcript window via the auto-extract-transcript helper.
 *   4. Hand off to the LM Studio extraction runner (T10 — currently stubbed; logs `skipped:llm-not-wired`).
 *   5. Append a single ndjson line to `~/.relay/auto-extract.log` so the user can audit decisions.
 *
 * Skip codes (used in the audit log + JSON output):
 *   - `skipped:no-consent`     consent file missing or `enabled: false`
 *   - `skipped:bad-payload`    stdin is not valid JSON / fails the Zod schema
 *   - `skipped:no-transcript`  `transcript_path` does not exist
 *   - `skipped:empty-window`   transcript existed but produced 0 turns
 *   - `skipped:llm-not-wired`  T10 hasn't been merged yet (the v1 default)
 */

import type { CliIO } from './commands.js';
import { mkdir, appendFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const HookPayloadSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
  hook_event_name: z.string().min(1).optional(),
});

const ConsentSchema = z.object({
  enabled: z.boolean(),
  // Future T13 fields — accept and ignore to stay forward-compatible.
}).passthrough();

type SkipReason =
  | 'skipped:no-consent'
  | 'skipped:bad-payload'
  | 'skipped:no-transcript'
  | 'skipped:empty-window'
  | 'skipped:llm-not-wired';

interface AuditEntry {
  readonly ts: string;
  readonly session_id: string | null;
  readonly cwd: string | null;
  readonly status: SkipReason | 'extracted';
  readonly turns_read?: number;
  readonly bytes?: number;
  readonly extracted_count?: number;
  readonly error?: string;
}

export interface AutoExtractArgs {
  readonly fromStdin: boolean;
  readonly maxBytes: number | undefined;
  readonly json: boolean;
}

export async function executeMemoryAutoExtractCommand(
  args: AutoExtractArgs,
  io: CliIO
): Promise<number> {
  if (!args.fromStdin) {
    io.stderr('relay memory auto-extract requires --from-stdin (CC SessionEnd hook is the only caller)\n');
    return 2;
  }

  // 1. Read + parse stdin.
  const raw = await readAllStdin();
  let payload: z.infer<typeof HookPayloadSchema>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    payload = HookPayloadSchema.parse(parsed);
  } catch (err) {
    await appendAudit({
      ts: new Date().toISOString(),
      session_id: null,
      cwd: null,
      status: 'skipped:bad-payload',
      error: (err as Error).message,
    });
    if (args.json) io.stdout(JSON.stringify({ status: 'skipped:bad-payload', error: (err as Error).message }) + '\n');
    else io.stderr(`auto-extract: bad stdin payload: ${(err as Error).message}\n`);
    return 0; // hooks must never block CC — return 0 even on bad input
  }

  // 2. Consent check.
  const consent = await loadConsent(payload.cwd);
  if (!consent.enabled) {
    await appendAudit({
      ts: new Date().toISOString(),
      session_id: payload.session_id,
      cwd: payload.cwd,
      status: 'skipped:no-consent',
    });
    if (args.json) io.stdout(JSON.stringify({ status: 'skipped:no-consent', cwd: payload.cwd }) + '\n');
    return 0;
  }

  // 3. Transcript exists?
  if (!existsSync(payload.transcript_path)) {
    await appendAudit({
      ts: new Date().toISOString(),
      session_id: payload.session_id,
      cwd: payload.cwd,
      status: 'skipped:no-transcript',
      error: payload.transcript_path,
    });
    if (args.json) io.stdout(JSON.stringify({ status: 'skipped:no-transcript', transcript_path: payload.transcript_path }) + '\n');
    return 0;
  }

  // 4. Load window.
  const { loadRecentTranscriptWindow, DEFAULT_WINDOW_BYTES } = await import('../memory/auto-extract-transcript.js');
  const window = loadRecentTranscriptWindow(payload.transcript_path, args.maxBytes ?? DEFAULT_WINDOW_BYTES);
  if (window.turnsRead === 0) {
    await appendAudit({
      ts: new Date().toISOString(),
      session_id: payload.session_id,
      cwd: payload.cwd,
      status: 'skipped:empty-window',
      turns_read: 0,
      bytes: 0,
    });
    if (args.json) io.stdout(JSON.stringify({ status: 'skipped:empty-window' }) + '\n');
    return 0;
  }

  // 5. LLM stub — T10 will replace with the LM Studio extraction runner.
  await appendAudit({
    ts: new Date().toISOString(),
    session_id: payload.session_id,
    cwd: payload.cwd,
    status: 'skipped:llm-not-wired',
    turns_read: window.turnsRead,
    bytes: window.bytes,
  });
  if (args.json) {
    io.stdout(JSON.stringify({
      status: 'skipped:llm-not-wired',
      session_id: payload.session_id,
      cwd: payload.cwd,
      turns_read: window.turnsRead,
      bytes: window.bytes,
    }) + '\n');
  }
  return 0;
}

/** Drain process.stdin into a string. CC pipes the hook payload as a single short blob. */
async function readAllStdin(): Promise<string> {
  // process.stdin is async iterable in Node 20+. We don't time-limit here —
  // CC writes the payload synchronously and then closes.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface Consent { readonly enabled: boolean; }

async function loadConsent(cwd: string): Promise<Consent> {
  const path = join(cwd, '.relay', 'auto-extract.json');
  try {
    const st = await stat(path);
    if (!st.isFile()) return { enabled: false };
  } catch {
    return { enabled: false };
  }
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = ConsentSchema.parse(JSON.parse(raw));
    return { enabled: parsed.enabled === true };
  } catch (err) {
    // Malformed consent file = treat as no-consent. Surface via audit log only.
    await appendAudit({
      ts: new Date().toISOString(),
      session_id: null,
      cwd,
      status: 'skipped:no-consent',
      error: `bad consent file: ${(err as Error).message}`,
    });
    return { enabled: false };
  }
}

async function appendAudit(entry: AuditEntry): Promise<void> {
  const path = join(homedir(), '.relay', 'auto-extract.log');
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    // Audit log is best-effort. Surface to stderr so loss is observable.
    process.stderr.write(`auto-extract: audit-log write failed: ${(err as Error).message}\n`);
  }
}

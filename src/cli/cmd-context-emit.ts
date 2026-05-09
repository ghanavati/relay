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

export interface ContextEmitCommand {
  target: EmitTarget;
  workdir: string;
  tokenBudget: number;
  types: readonly EmitMemoryType[];
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

export async function executeContextEmitCommand(
  command: ContextEmitCommand,
  io: CliIO
): Promise<number> {
  if (!(VALID_EMIT_TARGETS as readonly string[]).includes(command.target)) {
    io.stderr(
      `--target must be one of: ${VALID_EMIT_TARGETS.join(', ')} (got: ${command.target})\n`
    );
    return 2;
  }

  const { loadRecalledLessonsContent } = await import('../context/layers.js');
  const markdown = await loadRecalledLessonsContent(command.workdir, undefined, undefined, {
    types: command.types,
    tokenBudget: command.tokenBudget,
  });
  const body = markdown ?? '';

  switch (command.target) {
    case 'cc': {
      const envelope = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: body,
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

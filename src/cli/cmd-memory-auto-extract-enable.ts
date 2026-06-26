/**
 * T13 — `relay memory auto-extract --enable [--allow-remote]` writer.
 *
 * Writes `<workdir>/.relay/auto-extract.json` with `enabled: true`. If a
 * file already exists, its values are preserved and only the affirmative
 * fields touched by this command are overwritten — so a user who has
 * already tuned `max_bytes` or added custom redaction patterns does not
 * lose them by re-running `--enable`.
 *
 * No mutation: existing config is parsed, then a fresh object is written.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CliIO } from './commands.js';
import {
  ConsentFile,
  consentFilePath,
  type ConsentConfig,
} from '../memory/auto-extract-consent.js';

export async function executeMemoryAutoExtractEnableCommand(
  command: { allowRemote: boolean; workdir: string; json: boolean; extractor?: string },
  io: CliIO,
): Promise<number> {
  const path = consentFilePath(command.workdir);
  const requestedExtractor = command.extractor?.trim();
  if (requestedExtractor) {
    try {
      const { resolveProvider } = await import('../workers/provider-registry.js');
      resolveProvider(requestedExtractor);
    } catch (err) {
      const msg = (err as Error).message;
      if (command.json) io.stdout(JSON.stringify({ error: msg, path }) + '\n');
      else io.stderr(`${msg}\n`);
      return 2;
    }
  }

  // Try to preserve existing config; fall back to defaults if missing/broken.
  // We only treat ENOENT as a normal "no prior file" case — other errors
  // surface to the user so they can fix permissions before opting in.
  let existing: Partial<ConsentConfig> = {};
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = ConsentFile.safeParse(JSON.parse(raw));
    if (parsed.success) existing = parsed.data;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      const msg = `read existing consent failed: ${(err as Error).message}`;
      if (command.json) io.stdout(JSON.stringify({ error: msg, path }) + '\n');
      else io.stderr(`${msg}\n`);
      return 1;
    }
  }

  const next: ConsentConfig = {
    enabled: true,
    enabled_at: Date.now(),
    allow_remote: command.allowRemote || (existing.allow_remote ?? false),
    extractor: requestedExtractor || existing.extractor || 'codex',
    max_bytes: existing.max_bytes ?? 32_768,
    min_confidence: existing.min_confidence ?? 0.6,
    extra_redaction_patterns: existing.extra_redaction_patterns ?? [],
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + '\n', 'utf8');

  if (command.json) {
    io.stdout(
      JSON.stringify({
        enabled: true,
        allow_remote: next.allow_remote,
        extractor: next.extractor,
        path,
      }) + '\n',
    );
  } else {
    io.stdout(
      `Auto-extract consent enabled at ${path}\n` +
        `  allow_remote: ${next.allow_remote}\n` +
        `  extractor:    ${next.extractor}\n` +
        `  max_bytes:    ${next.max_bytes}\n` +
        `  min_confidence: ${next.min_confidence}\n`,
    );
  }
  return 0;
}

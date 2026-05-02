import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { ContextLayer, ContextLayerProvider } from './layers.js';

interface SessionEntry {
  session_id: string;
  status: string;
  owns_files: string[];
}

export function createSessionScopeLayerProvider(): ContextLayerProvider {
  return {
    id: 'session_scope',
    async load({ workdir }): Promise<ContextLayer | null> {
      if (!process.env['RELAY_SESSION_SCOPE_LAYERS']) return null;
      const indexPath = join(workdir, 'docs', 'sessions', 'index.json');
      let entries: SessionEntry[];
      try {
        const raw = await fs.readFile(indexPath, 'utf-8');
        entries = JSON.parse(raw) as SessionEntry[];
      } catch {
        return null;
      }
      const active = entries.filter(
        (entry) =>
          entry.status === 'active' &&
          Array.isArray(entry.owns_files) &&
          entry.owns_files.length > 0
      );
      if (active.length === 0) return null;
      const lines: string[] = [
        '## Session Scope Boundaries',
        '',
        'The following files are owned by active parallel sessions. Do NOT modify them:',
        '',
        ...active.flatMap((entry) =>
          entry.owns_files.map((file) => `- ${file}  (session: ${entry.session_id})`)
        ),
        '',
        'If your task requires changes to these files, stop and report the conflict.',
      ];
      return { id: 'session_scope', content: lines.join('\n') };
    },
  };
}

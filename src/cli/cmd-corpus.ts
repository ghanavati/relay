/**
 * SHIP-53 — `relay corpus` CLI commands: build, query, list, remove.
 *
 * Thin CLI wrapper around `CorpusStore`. Each sub-command is a pure function:
 * parse the already-typed command, call the store method, render to stdout.
 */

import type { CliIO } from './commands.js';
import { CorpusStore } from '../memory/corpus-store.js';
import type { RecallQuery, MemoryType } from '../memory/types.js';

type CorpusCommand =
  | { kind: 'corpus'; action: 'build'; name: string; description: string | undefined; tags: string[]; types: string[] | undefined; tokenBudget: number; workdir: string | undefined; json: boolean }
  | { kind: 'corpus'; action: 'query'; name: string; queryText: string; limit: number; json: boolean }
  | { kind: 'corpus'; action: 'list'; json: boolean }
  | { kind: 'corpus'; action: 'remove'; name: string; json: boolean };

function writeJson(io: CliIO, payload: unknown): void {
  io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
}

export function executeCorpusCommand(command: CorpusCommand, io: CliIO): number {
  const store = new CorpusStore();

  if (command.action === 'build') {
    const filter: RecallQuery = {
      types: command.types as MemoryType[] | undefined,
      tags: command.tags.length > 0 ? command.tags : undefined,
      token_budget: command.tokenBudget,
      workdir: command.workdir,
      include_expired: false,
    };
    const count = store.build(command.name, command.description ?? null, filter);
    if (command.json) {
      writeJson(io, { built: command.name, memory_count: count });
    } else {
      io.stdout(`Corpus "${command.name}" built from ${count} memor${count === 1 ? 'y' : 'ies'}.\n`);
    }
    return 0;
  }

  if (command.action === 'query') {
    const meta = store.get(command.name);
    if (!meta) {
      if (command.json) writeJson(io, { error: 'not_found', name: command.name });
      else io.stderr(`corpus "${command.name}" not found — run "relay corpus build ${command.name}" first\n`);
      return 1;
    }
    const results = store.query(command.name, command.queryText, command.limit);
    if (command.json) {
      writeJson(io, { corpus: command.name, query: command.queryText, results });
    } else if (results.length === 0) {
      io.stdout(`No matches for "${command.queryText}" in corpus "${command.name}".\n`);
    } else {
      io.stdout(`${results.length} match${results.length === 1 ? '' : 'es'} in "${command.name}":\n\n`);
      for (const r of results) {
        io.stdout(`  [score ${r.score.toFixed(2)}] ${r.snippet}\n\n`);
      }
    }
    return 0;
  }

  if (command.action === 'list') {
    const rows = store.list();
    if (command.json) {
      writeJson(io, { corpora: rows });
    } else if (rows.length === 0) {
      io.stdout('No corpora built yet. Run "relay corpus build <name>" to create one.\n');
    } else {
      io.stdout('Name                 Memories   Built\n');
      io.stdout('──────────────────── ────────── ────────────────────\n');
      for (const row of rows) {
        const builtStr = new Date(row.built_at).toISOString().replace('T', ' ').slice(0, 19);
        io.stdout(`${row.name.padEnd(20).slice(0, 20)} ${String(row.built_from_count).padEnd(10)} ${builtStr}\n`);
      }
    }
    return 0;
  }

  // action === 'remove'
  const removed = store.remove(command.name);
  if (command.json) writeJson(io, { removed, name: command.name });
  else io.stdout(removed ? `Removed corpus "${command.name}".\n` : `No corpus named "${command.name}".\n`);
  return removed ? 0 : 1;
}

// Exported so commands.ts can reference the union shape directly.
export type { CorpusCommand };

export function formatCorpusMatch(matched: number, total: number): string {
  return `${matched}/${total} entries matched`;
}

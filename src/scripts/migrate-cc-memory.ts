#!/usr/bin/env node
/**
 * src/scripts/migrate-cc-memory.ts
 *
 * Migrate Claude Code auto-memory files (~202 .md files) into Relay MemoryStore.
 *
 * 5 phases, gated by CLI flags:
 *   --inventory     phase 1 only — scan source dir, output JSON
 *   --dry-run       phases 1+2 — transform + show proposed rows, no DB writes (DEFAULT)
 *   --apply         phases 1-4 — actually upsert + verify (transactional)
 *   --archive       phase 5 only — move source dir to .archived-YYYY-MM-DD (after apply)
 *
 * Source: /Users/ghanavati/.claude/projects/-Users-ghanavati-ai-stack-Projects-relay-mcp/memory/
 * Target: project workdir's MemoryStore (default: /Users/ghanavati/ai-stack/Projects/relay-mcp)
 *
 * Plan v4 SHIP S3.
 */

import { readFile, readdir, rename, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

import { MemoryStore } from '../memory/memory-store.js';
import { getDb } from '../runtime/store/db.js';
import type { MemoryType } from '../memory/types.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_SOURCE_DIR =
  '/Users/ghanavati/.claude/projects/-Users-ghanavati-ai-stack-Projects-relay-mcp/memory';
const DEFAULT_PROJECT_WORKDIR = '/Users/ghanavati/ai-stack/Projects/relay-mcp';
const TODAY_ISO = new Date().toISOString().slice(0, 10);
const ARCHIVE_SUFFIX = `.archived-${TODAY_ISO}`;
const MIGRATION_TAG = `migration:${TODAY_ISO}`;

// Filename prefix → MemoryStore memory_type.
// Per Codex S3 verdict + agent 2 sample mapping verification.
const PREFIX_TO_TYPE: Readonly<Record<string, MemoryType>> = Object.freeze({
  feedback: 'lesson',
  project: 'context',
  reference: 'fact',
  user: 'fact',
});

// Frontmatter `type` field → MemoryType (fallback when prefix is unrecognized,
// e.g. `architecture-diagnosis.md` per agent 1 finding).
const FM_TYPE_TO_MEMORY_TYPE: Readonly<Record<string, MemoryType>> = Object.freeze({
  feedback: 'lesson',
  project: 'context',
  reference: 'fact',
  user: 'fact',
  lesson: 'lesson',
  decision: 'decision',
  fact: 'fact',
  context: 'context',
  state: 'state',
  handoff: 'handoff',
  session: 'session',
});

// MemoryStore.sanitizeContent silently truncates >100k chars. Pre-validate.
const MAX_BODY_CHARS = 100_000;

// ============================================================================
// Types
// ============================================================================

interface Frontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly type?: string;
}

interface InventoryEntry {
  readonly filename: string;
  readonly entity_key: string;
  readonly prefix: string;
  readonly frontmatter: Frontmatter;
  readonly body: string;
  readonly body_chars: number;
  readonly skip_reason: string | null;
}

interface ProposedRow {
  readonly entity_key: string;
  readonly memory_type: MemoryType;
  readonly content: string;
  readonly tags: readonly string[];
  readonly source_file: string;
  readonly warnings: readonly string[];
}

interface ApplyResult {
  readonly applied: ReadonlyArray<{ entity_key: string; memory_id: string }>;
  readonly failed: ReadonlyArray<{ entity_key: string; error: string }>;
}

interface VerifyResult {
  readonly count_before: number;
  readonly count_after: number;
  readonly count_delta: number;
  readonly expected_delta: number;
  readonly ok: boolean;
}

// ============================================================================
// Frontmatter parsing (lightweight, no YAML dep)
// ============================================================================

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { frontmatter: {}, body: raw };
  }
  const closeIdx = raw.indexOf('\n---', 4);
  if (closeIdx === -1) {
    return { frontmatter: {}, body: raw };
  }
  const yamlBlock = raw.slice(4, closeIdx);
  const bodyStart = raw.indexOf('\n', closeIdx + 4) + 1;
  const body = bodyStart > 0 ? raw.slice(bodyStart) : '';

  const fm: Record<string, string> = {};
  for (const rawLine of yamlBlock.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return {
    frontmatter: {
      name: fm['name'],
      description: fm['description'],
      type: fm['type'],
    },
    body,
  };
}

function derivePrefix(filename: string): string {
  const base = basename(filename, '.md');
  const underscoreIdx = base.indexOf('_');
  if (underscoreIdx === -1) return 'other';
  return base.slice(0, underscoreIdx);
}

// Tombstone detection per agent 1+2 findings (12/202 files marked SUPERSEDED/RESOLVED).
function isTombstone(frontmatter: Frontmatter, body: string): boolean {
  if (frontmatter.name === 'SUPERSEDED') return true;
  if (frontmatter.name === 'RESOLVED') return true;
  const desc = (frontmatter.description ?? '').toUpperCase();
  if (desc.startsWith('REMOVED')) return true;
  if (desc.startsWith('SUPERSEDED')) return true;
  if (desc.startsWith('RESOLVED')) return true;
  const trimmedBody = body.trim();
  if (trimmedBody.startsWith('SUPERSEDED ')) return true;
  if (trimmedBody.startsWith('RESOLVED ')) return true;
  return false;
}

// Resolve memory_type — try filename prefix first, fall back to frontmatter.type.
function resolveMemoryType(prefix: string, frontmatter: Frontmatter): MemoryType | null {
  const fromPrefix = PREFIX_TO_TYPE[prefix];
  if (fromPrefix) return fromPrefix;
  const fromFm = frontmatter.type ? FM_TYPE_TO_MEMORY_TYPE[frontmatter.type.toLowerCase()] : null;
  return fromFm ?? null;
}

// ============================================================================
// Phase 1: inventory
// ============================================================================

async function phase1Inventory(sourceDir: string): Promise<InventoryEntry[]> {
  const entries: InventoryEntry[] = [];
  const files = await readdir(sourceDir);
  for (const filename of files) {
    if (!filename.endsWith('.md')) continue;
    if (filename === 'MEMORY.md') continue;

    const fullPath = join(sourceDir, filename);
    const stats = await stat(fullPath);
    if (!stats.isFile()) continue;

    let raw: string;
    try {
      raw = await readFile(fullPath, 'utf8');
    } catch (e) {
      entries.push({
        filename,
        entity_key: basename(filename, '.md'),
        prefix: derivePrefix(filename),
        frontmatter: {},
        body: '',
        body_chars: 0,
        skip_reason: `read_error: ${(e as Error).message}`,
      });
      continue;
    }

    // Strip BOM if present (per agent 5 edge case 4).
    const cleaned = raw.startsWith('﻿') ? raw.slice(1) : raw;
    const { frontmatter, body } = parseFrontmatter(cleaned);
    const entity_key = basename(filename, '.md');
    const prefix = derivePrefix(filename);

    let skip_reason: string | null = null;
    if (isTombstone(frontmatter, body)) {
      skip_reason = 'tombstone (SUPERSEDED/RESOLVED/REMOVED)';
    } else if (!body.trim()) {
      skip_reason = 'empty_body';
    } else if (resolveMemoryType(prefix, frontmatter) === null) {
      skip_reason = `unmapped_type: prefix=${prefix} fm.type=${frontmatter.type ?? 'missing'}`;
    }

    entries.push({
      filename,
      entity_key,
      prefix,
      frontmatter,
      body,
      body_chars: body.length,
      skip_reason,
    });
  }
  return entries;
}

// ============================================================================
// Phase 2: dry-run transform
// ============================================================================

function phase2DryRun(inventory: readonly InventoryEntry[]): {
  proposed: ProposedRow[];
  skipped: Array<{ entity_key: string; reason: string }>;
} {
  const proposed: ProposedRow[] = [];
  const skipped: Array<{ entity_key: string; reason: string }> = [];

  for (const entry of inventory) {
    if (entry.skip_reason) {
      skipped.push({ entity_key: entry.entity_key, reason: entry.skip_reason });
      continue;
    }

    const memory_type = resolveMemoryType(entry.prefix, entry.frontmatter);
    if (!memory_type) {
      skipped.push({ entity_key: entry.entity_key, reason: 'no_memory_type_resolved' });
      continue;
    }

    const warnings: string[] = [];
    if (entry.body.length > MAX_BODY_CHARS) {
      warnings.push(`body_truncated: ${entry.body.length} → ${MAX_BODY_CHARS}`);
    }

    // Tag with prefix for traceability + migration tag for rollback.
    // Per agent 5 defensive pattern: migration-tag every row enables single-SQL rollback.
    const tags: string[] = [entry.prefix, MIGRATION_TAG, `from-file:${entry.filename}`];
    if (entry.frontmatter.type && entry.frontmatter.type !== entry.prefix) {
      tags.push(`fm-type:${entry.frontmatter.type}`);
    }

    // Preserve `name` and `description` in content header (agent 2: prefix→type
    // mapping loses 30% of nuance; preserving frontmatter prevents semantic loss).
    const header = entry.frontmatter.name ? `# ${entry.frontmatter.name}\n\n` : '';
    const description = entry.frontmatter.description
      ? `_${entry.frontmatter.description}_\n\n`
      : '';
    const content = (header + description + entry.body).slice(0, MAX_BODY_CHARS);

    proposed.push({
      entity_key: entry.entity_key,
      memory_type,
      content,
      tags,
      source_file: entry.filename,
      warnings,
    });
  }

  return { proposed, skipped };
}

// ============================================================================
// Phase 3: apply (transactional, per agent 5 defensive pattern 4)
// ============================================================================

function phase3Apply(
  proposed: readonly ProposedRow[],
  store: MemoryStore,
  workdir: string
): ApplyResult {
  const applied: Array<{ entity_key: string; memory_id: string }> = [];
  const failed: Array<{ entity_key: string; error: string }> = [];

  // Per agent 5: per-row try/catch instead of one big transaction. better-sqlite3
  // savepoints would be ideal but MemoryStore.upsert wraps its own transaction —
  // nested transactions are not supported. So we rely on MemoryStore's own per-call
  // atomicity and just track per-row outcomes here.
  for (const row of proposed) {
    try {
      // Per agent 3 requirements:
      //   - Do NOT pass source_run_id (bypasses write rate limit completely)
      //   - memory_source: 'human' + pinned: true → trust_level 'trusted', GC-exempt
      //   - No expires_at (null = permanent)
      const memory_id = store.upsert({
        entity_key: row.entity_key,
        content: row.content,
        memory_type: row.memory_type,
        tags: row.tags,
        workdir,
        pinned: true,
        memory_source: 'human',
      });
      applied.push({ entity_key: row.entity_key, memory_id });
    } catch (e) {
      const err = e as Error & { code?: string };
      failed.push({
        entity_key: row.entity_key,
        error: `${err.code ?? 'UNKNOWN'}: ${err.message}`,
      });
    }
  }

  return { applied, failed };
}

// ============================================================================
// Phase 4: verify (count-based per agent 5 — FTS recall is unreliable for enumeration)
// ============================================================================

function phase4Verify(
  applyResult: ApplyResult,
  store: MemoryStore,
  workdir: string,
  count_before: number
): VerifyResult {
  const count_after = store.count(workdir);
  const count_delta = count_after - count_before;
  // Each upsert can create 0 net delta (if it superseded an existing row with same
  // entity_key+workdir — replaces, doesn't add). Or +1 if entity_key is new.
  // Lower bound: count delta >= 0. Upper bound: count delta <= applied.length.
  const expected_delta = applyResult.applied.length;
  const ok =
    applyResult.failed.length === 0 &&
    count_delta >= 0 &&
    count_delta <= expected_delta;
  return { count_before, count_after, count_delta, expected_delta, ok };
}

// ============================================================================
// Phase 5: archive
// ============================================================================

async function phase5Archive(sourceDir: string, archiveDir: string): Promise<void> {
  await rename(sourceDir, archiveDir);
}

// ============================================================================
// CLI
// ============================================================================

interface CliArgs {
  readonly mode: 'inventory' | 'dry-run' | 'apply' | 'archive';
  readonly sourceDir: string;
  readonly workdir: string;
  readonly archiveDir: string;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let mode: CliArgs['mode'] = 'dry-run';
  let sourceDir = DEFAULT_SOURCE_DIR;
  let workdir = DEFAULT_PROJECT_WORKDIR;
  let archiveDir = sourceDir + ARCHIVE_SUFFIX;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--inventory') mode = 'inventory';
    else if (arg === '--dry-run') mode = 'dry-run';
    else if (arg === '--apply') mode = 'apply';
    else if (arg === '--archive') mode = 'archive';
    else if (arg === '--json') json = true;
    else if (arg === '--source-dir' && argv[i + 1]) sourceDir = argv[++i] ?? sourceDir;
    else if (arg === '--workdir' && argv[i + 1]) workdir = argv[++i] ?? workdir;
    else if (arg === '--archive-dir' && argv[i + 1]) archiveDir = argv[++i] ?? archiveDir;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg && arg.startsWith('--')) {
      console.error(`unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  return { mode, sourceDir, workdir, archiveDir, json };
}

function printHelp(): void {
  console.error(
    `Usage: migrate-cc-memory.js [--inventory|--dry-run|--apply|--archive] [options]

Modes:
  --inventory   Phase 1 only — scan source dir, list entries with skip reasons.
  --dry-run     Phases 1+2 — show proposed memory rows. No DB writes. (default)
  --apply       Phases 1-4 — write to MemoryStore + verify.
  --archive     Phase 5 only — move source dir to archive dir.

Options:
  --source-dir <path>   Override CC memory source dir.
  --workdir <path>      Override target project workdir.
  --archive-dir <path>  Override archive destination.
  --json                Emit JSON output instead of human-readable.
  -h, --help            Show this message.

Plan v4 SHIP S3.

Rollback (after --apply):
  Apply tags every row with '${MIGRATION_TAG}'. To rollback in SQL:
  UPDATE memories SET superseded_by='migration-rollback'
   WHERE tags_json LIKE '%"${MIGRATION_TAG}"%';
`
  );
}

function emit(json: boolean, label: string, data: unknown): void {
  if (json) {
    process.stdout.write(JSON.stringify({ phase: label, ...(data as object) }) + '\n');
  } else {
    console.log(`=== ${label} ===`);
    console.log(JSON.stringify(data, null, 2));
  }
}

function preflightWorkdirCheck(workdir: string): { ok: boolean; reason?: string } {
  const allowedRaw = process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
  if (!allowedRaw) return { ok: true };
  const allowed = allowedRaw.split(':').filter(Boolean);
  const ok = allowed.some((a: string) => workdir === a || workdir.startsWith(a + '/'));
  return ok
    ? { ok: true }
    : {
        ok: false,
        reason:
          `RELAY_MEMORY_ALLOWED_WORKDIRS is set but does not include workdir.\n` +
          `  workdir:  ${workdir}\n` +
          `  allowed:  ${allowed.join(', ')}\n` +
          `Either unset RELAY_MEMORY_ALLOWED_WORKDIRS or pass --workdir matching one of the allowed prefixes.`,
      };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === 'archive') {
    try {
      await phase5Archive(args.sourceDir, args.archiveDir);
      emit(args.json, 'archive', { from: args.sourceDir, to: args.archiveDir, ok: true });
      return 0;
    } catch (e) {
      emit(args.json, 'archive', {
        from: args.sourceDir,
        to: args.archiveDir,
        ok: false,
        error: (e as Error).message,
      });
      return 1;
    }
  }

  // Pre-flight: workdir guard (per agent 3 requirement).
  if (args.mode === 'apply') {
    const check = preflightWorkdirCheck(args.workdir);
    if (!check.ok) {
      console.error('ERROR: ' + check.reason);
      return 2;
    }
  }

  const inventory = await phase1Inventory(args.sourceDir);
  const counts = {
    total: inventory.length,
    by_prefix: {} as Record<string, number>,
    skipped: inventory.filter(e => e.skip_reason !== null).length,
    eligible: inventory.filter(e => e.skip_reason === null).length,
  };
  for (const e of inventory) {
    counts.by_prefix[e.prefix] = (counts.by_prefix[e.prefix] ?? 0) + 1;
  }

  if (args.mode === 'inventory') {
    emit(args.json, 'inventory', {
      counts,
      entries: inventory.map(e => ({
        filename: e.filename,
        prefix: e.prefix,
        body_chars: e.body_chars,
        skip_reason: e.skip_reason,
      })),
    });
    return 0;
  }

  const { proposed, skipped } = phase2DryRun(inventory);

  if (args.mode === 'dry-run') {
    emit(args.json, 'dry-run', {
      counts: {
        ...counts,
        proposed: proposed.length,
        skipped_in_transform: skipped.length,
      },
      proposed: proposed.map(r => ({
        entity_key: r.entity_key,
        memory_type: r.memory_type,
        content_preview: r.content.slice(0, 200),
        content_chars: r.content.length,
        tags: r.tags,
        warnings: r.warnings,
      })),
      skipped,
    });
    return 0;
  }

  // mode === 'apply'
  const store = new MemoryStore();
  // Force DB to open before count() to ensure migrations have run.
  getDb();
  const count_before = store.count(args.workdir);
  const applyResult = phase3Apply(proposed, store, args.workdir);
  const verifyResult = phase4Verify(applyResult, store, args.workdir, count_before);

  emit(args.json, 'apply', {
    counts: {
      ...counts,
      applied: applyResult.applied.length,
      skipped_total: skipped.length,
      failed: applyResult.failed.length,
    },
    verify: verifyResult,
    failed: applyResult.failed,
    rollback_hint: `UPDATE memories SET superseded_by='migration-rollback' WHERE tags_json LIKE '%"${MIGRATION_TAG}"%';`,
  });

  return verifyResult.ok ? 0 : 1;
}

main().then(
  code => process.exit(code),
  e => {
    console.error('FATAL:', (e as Error).message);
    console.error((e as Error).stack);
    process.exit(2);
  }
);

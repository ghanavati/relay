#!/usr/bin/env node
// One-shot migration: copy CC auto-memory MD files from the relay-mcp project
// into Relay's SQLite memory store via the `relay memory remember` CLI.
//
// Usage:
//   node scripts/migrate-cc-mcp-memory.mjs              # dry-run (default)
//   node scripts/migrate-cc-mcp-memory.mjs --apply      # actually write
//   node scripts/migrate-cc-mcp-memory.mjs --apply --force  # ignore sentinel + duplicate-tag check
//
// Source : ~/.claude/projects/-Users-ghanavati-ai-stack-Projects-relay-mcp/memory/*.md
// Target : Relay memory store (RELAY_DB_PATH or ~/.relay/relay.db)
// Idempotency: writes /tmp/relay-cc-mcp-migration.done after first apply; --force overrides.
// Re-running --apply also checks for existing memory entries tagged 'cc-auto-memory-migration'.

import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';

const SOURCE = join(
  homedir(),
  '.claude/projects/-Users-ghanavati-ai-stack-Projects-relay-mcp/memory',
);
const SENTINEL = join(tmpdir(), 'relay-cc-mcp-migration.done');
const FAILURES_LOG = join(tmpdir(), `relay-cc-mcp-migration-failures-${Date.now()}.log`);
const RELAY_BIN = process.env.RELAY_BIN ?? 'relay';
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

const TYPE_MAP = {
  feedback: 'lesson',
  project: 'context',
  reference: 'fact',
  user: 'context',
};

function stripQuotes(value) {
  return value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function parseFrontmatter(text) {
  // Normalize CRLF → LF so frontmatter delimiters match.
  const normalized = text.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const fmBlock = match[1];
  const body = match[2].trim();
  const meta = {};
  const multiLineMarkers = [];
  for (const line of fmBlock.split('\n')) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    let value = stripQuotes(kv[2].trim());
    // Detect folded/literal block scalars — we don't expand them; flag for manual review.
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      multiLineMarkers.push(kv[1]);
      continue;
    }
    if (value !== '') meta[kv[1]] = value;
  }
  return { meta, body, multiLineMarkers };
}

async function inventory() {
  if (!existsSync(SOURCE)) {
    throw new Error(`Source memory directory not found: ${SOURCE}`);
  }
  const all = await readdir(SOURCE);
  const files = all.filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  const entries = [];
  const skipped = [];
  for (const file of files) {
    const fullPath = join(SOURCE, file);
    let text;
    try {
      text = await readFile(fullPath, 'utf8');
    } catch (err) {
      skipped.push({ file, reason: `read error: ${err.message ?? err}` });
      continue;
    }
    const parsed = parseFrontmatter(text);
    if (!parsed) {
      skipped.push({ file, reason: 'no frontmatter' });
      continue;
    }
    const { meta, body, multiLineMarkers } = parsed;
    if (!body || body.length < 20) {
      skipped.push({ file, reason: `body too short (${body.length})` });
      continue;
    }
    if (multiLineMarkers.length > 0) {
      skipped.push({ file, reason: `unsupported YAML block scalar(s): ${multiLineMarkers.join(', ')}` });
      continue;
    }
    const sourceType = meta.type ?? 'project';
    const mappedType = TYPE_MAP[sourceType] ?? 'context';
    entries.push({
      file,
      name: meta.name ?? basename(file, '.md'),
      description: meta.description ?? '',
      sourceType,
      mappedType,
      body,
      bodyLen: body.length,
    });
  }
  return { entries, skipped };
}

function preflightRelayBinary() {
  try {
    execFileSync(RELAY_BIN, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function preflightExistingMigration() {
  // Check if any memory entries already carry the migration tag.
  // Returns count (0 = clean; >0 = prior migration exists).
  try {
    const out = execFileSync(
      RELAY_BIN,
      ['memory', 'recall', '--tag', 'cc-auto-memory-migration', '--token-budget', '8000', '--json'],
      { stdio: 'pipe' },
    ).toString();
    if (!out.trim()) return 0;
    const parsed = JSON.parse(out);
    // Result shape: { recalled: [...], ... } — count entries defensively.
    const list = parsed.recalled ?? parsed.entries ?? parsed.results ?? [];
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0; // Treat any error as "no prior migration" — sentinel is the primary guard.
  }
}

function printPlan(entries, skipped) {
  console.log(`\nMigration plan (${APPLY ? 'APPLY' : 'DRY-RUN'})`);
  console.log(`  Source : ${SOURCE}`);
  console.log(`  Target : Relay memory store (RELAY_DB_PATH=${process.env.RELAY_DB_PATH ?? '<default ~/.relay/relay.db>'})`);
  console.log(`  Candidates: ${entries.length}`);
  console.log(`  Skipped   : ${skipped.length}`);

  const byType = {};
  for (const e of entries) byType[e.mappedType] = (byType[e.mappedType] ?? 0) + 1;
  console.log(`\nBy mapped type:`);
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type.padEnd(10)} ${count}`);
  }

  const bySource = {};
  for (const e of entries) bySource[e.sourceType] = (bySource[e.sourceType] ?? 0) + 1;
  console.log(`\nBy source type (CC auto-memory):`);
  for (const [type, count] of Object.entries(bySource)) {
    const knownMark = TYPE_MAP[type] ? ' ' : ' ⚠ unknown — defaulted to context';
    console.log(`  ${type.padEnd(10)} ${count}${knownMark}`);
  }

  const unknownTypes = new Set(Object.keys(bySource).filter(t => !TYPE_MAP[t]));
  if (unknownTypes.size > 0) {
    console.log(`\n⚠ Unknown source types found: ${[...unknownTypes].join(', ')}`);
    console.log(`  These were mapped to 'context' by default. Add explicit mapping if needed.`);
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped (all ${skipped.length}):`);
    for (const s of skipped) console.log(`  ${s.file.padEnd(60)} ${s.reason}`);
  }

  console.log(`\nFirst 5 candidates:`);
  for (const e of entries.slice(0, 5)) {
    const snippet = e.body.replace(/\s+/g, ' ').slice(0, 80);
    console.log(`  [${e.mappedType.padEnd(7)}] ${e.name}`);
    console.log(`            ${snippet}${e.body.length > 80 ? '…' : ''}`);
  }
}

async function applyMigration(entries) {
  console.log(`\n[APPLY] Writing ${entries.length} entries via \`${RELAY_BIN} memory remember\`...`);
  console.log(`Failures (if any) will be logged to: ${FAILURES_LOG}`);
  let success = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    try {
      const args = [
        'memory', 'remember',
        e.body,
        '--type', e.mappedType,
        '--tag', 'cc-auto-memory-migration',
        '--tag', `src:${basename(e.file, '.md')}`,
      ];
      execFileSync(RELAY_BIN, args, { stdio: 'pipe' });
      success++;
      if ((i + 1) % 25 === 0) console.log(`  ... ${i + 1}/${entries.length}`);
    } catch (err) {
      failed++;
      const msg = err.stderr?.toString?.() ?? err.message ?? String(err);
      failures.push({ file: e.file, msg });
    }
  }

  console.log(`\nDone. ${success} succeeded, ${failed} failed.`);
  if (failures.length > 0) {
    const logBody = failures.map(f => `--- ${f.file} ---\n${f.msg}\n`).join('\n');
    await writeFile(FAILURES_LOG, logBody, 'utf8');
    console.log(`\nAll ${failures.length} failed filenames:`);
    for (const f of failures) console.log(`  ${f.file}`);
    console.log(`\nFull stderr per failure: ${FAILURES_LOG}`);
  }
  if (failed === 0) {
    await writeFile(SENTINEL, new Date().toISOString() + '\n', 'utf8');
    console.log(`\nWrote sentinel: ${SENTINEL}`);
  }
}

async function main() {
  if (APPLY) {
    if (!preflightRelayBinary()) {
      console.error(`\nRELAY_BIN '${RELAY_BIN}' not found on PATH. Install or set RELAY_BIN env var.`);
      process.exit(2);
    }
    if (existsSync(SENTINEL) && !FORCE) {
      const sStat = await stat(SENTINEL);
      console.error(`\nMigration already applied (${SENTINEL}, mtime=${sStat.mtime.toISOString()}).`);
      console.error(`Re-run with --force to migrate again.`);
      process.exit(2);
    }
    const existing = preflightExistingMigration();
    if (existing > 0 && !FORCE) {
      console.error(`\nFound ${existing} existing memory entries tagged 'cc-auto-memory-migration'.`);
      console.error(`Re-running --apply would create duplicates. Either:`);
      console.error(`  1. Delete prior entries via the Relay memory CLI, then re-run`);
      console.error(`  2. Re-run with --force to insert duplicates anyway`);
      process.exit(2);
    }
  }

  const { entries, skipped } = await inventory();
  printPlan(entries, skipped);

  if (!APPLY) {
    console.log(`\n[DRY-RUN] No writes performed. Re-run with --apply to migrate.`);
    return;
  }

  await applyMigration(entries);
}

main().catch(err => {
  console.error('Migration error:', err.stack ?? err);
  process.exit(1);
});

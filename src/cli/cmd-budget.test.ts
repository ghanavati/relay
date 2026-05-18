/**
 * Tests for the v0.2 `relay budget show` implementation.
 *
 * Pre-condition: `process.env['RELAY_DB_PATH'] = ':memory:'` must be set
 * BEFORE the cmd-budget module is imported — the BudgetStore opens its db
 * connection lazily through `getDb()`.
 *
 * Each `describe` block seeds an isolated set of cost_events into the shared
 * in-memory DB (via beforeEach DELETE) so assertions can target known sums.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { describe, test, beforeEach, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeBudgetShowCommand, type BudgetShowArgs } from './cmd-budget.js';
import { getDb } from '../runtime/store/db.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(cwd = '/tmp'): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd, stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

function seedEvents(rows: Array<[provider: string, workdir: string, cost: number]>): void {
  const db = getDb();
  db.prepare('DELETE FROM cost_events').run();
  const stmt = db.prepare(
    `INSERT INTO cost_events
       (run_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, workdir, created_at)
     VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?)`,
  );
  const now = Date.now();
  rows.forEach(([provider, workdir, cost], i) => {
    stmt.run(`run-${i}`, provider, 'test-model', cost, workdir, now);
  });
}

const ALL_FIVE: Array<[string, string, number]> = [
  ['lmstudio', '/a', 0.01],
  ['lmstudio', '/b', 0.02],
  ['openrouter', '/a', 0.10],
  ['openrouter', '/b', 0.20],
  ['anthropic', '/a', 1.00],
];

describe('executeBudgetShowCommand — human output', () => {
  beforeEach(() => seedEvents(ALL_FIVE));

  test('no flags → "Total: $1.3300 across 5 events"; exit 0', async () => {
    const cap = makeIO();
    const code = await executeBudgetShowCommand({ json: false }, cap.io);
    assert.equal(code, 0);
    assert.equal(cap.stderr.join(''), '');
    const out = cap.stdout.join('');
    assert.match(out, /Total: \$1\.3300/);
    assert.match(out, /5 events/);
  });

  test('--provider lmstudio → header mentions provider, sums lmstudio rows', async () => {
    const cap = makeIO();
    const code = await executeBudgetShowCommand({ json: false, provider: 'lmstudio' }, cap.io);
    assert.equal(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /provider=lmstudio/);
    assert.match(out, /Total: \$0\.0300/);
    assert.match(out, /2 events/);
  });

  test('--workdir /a → header mentions workdir, sums /a rows', async () => {
    const cap = makeIO();
    const code = await executeBudgetShowCommand({ json: false, workdir: '/a' }, cap.io);
    assert.equal(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /workdir=\/a/);
    assert.match(out, /Total: \$1\.1100/);
    assert.match(out, /3 events/);
  });

  test('--provider openrouter --workdir /a → header lists both filters', async () => {
    const cap = makeIO();
    const code = await executeBudgetShowCommand(
      { json: false, provider: 'openrouter', workdir: '/a' },
      cap.io,
    );
    assert.equal(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /provider=openrouter/);
    assert.match(out, /workdir=\/a/);
    assert.match(out, /Total: \$0\.1000/);
    assert.match(out, /1 event\b/); // singular
  });

  test('empty DB → "Total: $0.0000 across 0 events"', async () => {
    getDb().prepare('DELETE FROM cost_events').run();
    const cap = makeIO();
    const code = await executeBudgetShowCommand({ json: false }, cap.io);
    assert.equal(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /Total: \$0\.0000/);
    assert.match(out, /0 events/);
  });
});

describe('executeBudgetShowCommand — --json envelope', () => {
  beforeEach(() => seedEvents(ALL_FIVE));

  test('--json no filters → schema_version=1, total=1.33, count=5, all filters null', async () => {
    const cap = makeIO();
    const code = await executeBudgetShowCommand({ json: true }, cap.io);
    assert.equal(code, 0);
    const raw = cap.stdout.join('');
    assert.ok(raw.endsWith('\n'), 'json output must end with a newline');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'json mode must emit exactly one line');
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.schema_version, 1, 'schema_version pinned at 1');
    assert.ok(Math.abs(parsed.total_usd - 1.33) < 1e-9);
    assert.equal(parsed.event_count, 5);
    assert.deepStrictEqual(parsed.scope_filters, {
      provider: null,
      workdir: null,
      period: null,
    });
  });

  test('--provider lmstudio --json → scope_filters.provider=lmstudio', async () => {
    const cap = makeIO();
    await executeBudgetShowCommand({ json: true, provider: 'lmstudio' }, cap.io);
    const parsed = JSON.parse(cap.stdout.join('').trim());
    assert.equal(parsed.scope_filters.provider, 'lmstudio');
    assert.equal(parsed.scope_filters.workdir, null);
    assert.equal(parsed.scope_filters.period, null);
  });

  test('--period daily --json → scope_filters.period="daily"', async () => {
    const cap = makeIO();
    await executeBudgetShowCommand({ json: true, period: 'daily' }, cap.io);
    const parsed = JSON.parse(cap.stdout.join('').trim());
    assert.equal(parsed.scope_filters.period, 'daily');
  });

  test('--provider openrouter --workdir /a --json → intersection sum', async () => {
    const cap = makeIO();
    const code = await executeBudgetShowCommand(
      { json: true, provider: 'openrouter', workdir: '/a' },
      cap.io,
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim());
    assert.equal(parsed.schema_version, 1);
    assert.ok(Math.abs(parsed.total_usd - 0.10) < 1e-9);
    assert.equal(parsed.event_count, 1);
    assert.deepStrictEqual(parsed.scope_filters, {
      provider: 'openrouter',
      workdir: '/a',
      period: null,
    });
  });

  test('empty DB --json → zeros, all filters null', async () => {
    getDb().prepare('DELETE FROM cost_events').run();
    const cap = makeIO();
    const code = await executeBudgetShowCommand({ json: true }, cap.io);
    assert.equal(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim());
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.total_usd, 0);
    assert.equal(parsed.event_count, 0);
  });
});

describe('executeBudgetShowCommand — error paths', () => {
  beforeEach(() => seedEvents(ALL_FIVE));

  test('--period bogus → stderr message, exit 2', async () => {
    const cap = makeIO();
    const code = await executeBudgetShowCommand(
      { json: false, period: 'bogus' } as unknown as BudgetShowArgs,
      cap.io,
    );
    assert.equal(code, 2);
    assert.equal(cap.stdout.join(''), '', 'no stdout on bad --period');
    assert.match(cap.stderr.join(''), /unknown --period value 'bogus'/);
    assert.match(cap.stderr.join(''), /daily, monthly, alltime/);
  });

  test('--period bogus --json → stderr message, exit 2, no JSON written', async () => {
    const cap = makeIO();
    const code = await executeBudgetShowCommand(
      { json: true, period: 'wat' } as unknown as BudgetShowArgs,
      cap.io,
    );
    assert.equal(code, 2);
    assert.equal(cap.stdout.join(''), '');
    assert.match(cap.stderr.join(''), /unknown --period value 'wat'/);
  });
});

describe('executeBudgetShowCommand — relative --workdir resolution', () => {
  before(() => seedEvents([
    ['lmstudio', '/tmp/proj', 0.05],
  ]));

  test('relative --workdir is resolved against io.cwd', async () => {
    const cap = makeIO('/tmp');
    const code = await executeBudgetShowCommand(
      { json: true, workdir: 'proj' },
      cap.io,
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim());
    assert.equal(parsed.scope_filters.workdir, '/tmp/proj');
    assert.equal(parsed.event_count, 1);
    assert.ok(Math.abs(parsed.total_usd - 0.05) < 1e-9);
  });
});

describe('executeBudgetShowCommand — schema_version stability guard', () => {
  test('--json always carries schema_version: 1 (downstream contract)', async () => {
    seedEvents(ALL_FIVE);
    const cap = makeIO();
    await executeBudgetShowCommand({ json: true }, cap.io);
    const parsed = JSON.parse(cap.stdout.join('').trim());
    assert.equal(parsed.schema_version, 1, 'breaking this field is a SemVer-major change');
  });
});

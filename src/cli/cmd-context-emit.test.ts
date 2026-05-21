process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeContextEmitCommand } from './cmd-context-emit.js';
import { MemoryStore } from '../memory/memory-store.js';
import { getDb } from '../runtime/store/db.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(cwd: string): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd, stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

const WORKDIR = '/tmp/relay-context-emit-test';

/**
 * Seed two human-sourced memories and stamp their trust_level so they survive
 * the new T1 default `--min-trust=provisional`. Without `upgradeTrust()` the
 * `trust_level` column stays at its DB default of 'unverified', which the
 * provisional filter excludes — see memory-store.ts:515.
 */
function seedMemories(): { humanIds: string[] } {
  const store = new MemoryStore();
  const a = store.remember({
    content: 'always run npm test before commit',
    memory_type: 'lesson',
    workdir: WORKDIR,
    memory_source: 'human',
  });
  const b = store.remember({
    content: 'never use force push to main',
    memory_type: 'lesson',
    workdir: WORKDIR,
    memory_source: 'human',
  });
  store.upgradeTrust(a);
  store.upgradeTrust(b);
  return { humanIds: [a, b] };
}

/**
 * T1 — seed an unverified auto-extracted entry alongside seedMemories(). The
 * unverified entry should be excluded by the default --min-trust=provisional
 * but included when the caller passes --min-trust=any (or 'unverified').
 */
function seedUnverifiedMemory(): { unverifiedId: string } {
  const store = new MemoryStore();
  const id = store.remember({
    content: 'unverified auto-extracted lesson about caching layers',
    memory_type: 'lesson',
    workdir: WORKDIR,
    memory_source: 'auto-run-recorder',
  });
  store.upgradeTrust(id);
  return { unverifiedId: id };
}

/**
 * T1 — seed a trusted (human + pinned) memory. Survives `--min-trust=trusted`.
 */
function seedTrustedMemory(): { trustedId: string } {
  const store = new MemoryStore();
  const id = store.remember({
    content: 'trusted-tier human-pinned policy directive zeta',
    memory_type: 'lesson',
    workdir: WORKDIR,
    memory_source: 'human',
    pinned: true,
  });
  store.upgradeTrust(id);
  return { trustedId: id };
}

describe('executeContextEmitCommand — per-target wrapper format', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
    seedMemories();
  });

  test('--target cc → SessionStart hookSpecificOutput JSON envelope', async () => {
    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(
      {
        target: 'cc',
        workdir: WORKDIR,
        tokenBudget: 800,
        types: ['lesson', 'fact', 'decision', 'context'],
      },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.ok(out.endsWith('\n'), 'cc output must end with newline');
    const parsed = JSON.parse(out.trim()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(
      typeof parsed.hookSpecificOutput.additionalContext === 'string',
      'additionalContext must be a string'
    );
    // Memories are seeded in this workdir → markdown body must mention at least one
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /npm test|force push/,
      'additionalContext should contain seeded memory text'
    );
  });

  test('--target codex → plain markdown to stdout (no envelope, no trailing newline)', async () => {
    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(
      {
        target: 'codex',
        workdir: WORKDIR,
        tokenBudget: 800,
        types: ['lesson', 'fact', 'decision', 'context'],
      },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    // Plain markdown — no JSON brackets at start
    assert.ok(!out.startsWith('{'), 'codex output must not be JSON');
    assert.match(out, /Recalled Lessons/, 'codex output should contain markdown heading');
    assert.match(out, /npm test|force push/, 'codex output should contain seeded memory text');
  });

  test('--target lmstudio-http → {"role":"system","content":"..."} JSON fragment', async () => {
    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(
      {
        target: 'lmstudio-http',
        workdir: WORKDIR,
        tokenBudget: 800,
        types: ['lesson', 'fact', 'decision', 'context'],
      },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.ok(out.endsWith('\n'), 'lmstudio-http output must end with newline');
    const parsed = JSON.parse(out.trim()) as { role: string; content: string };
    assert.strictEqual(parsed.role, 'system');
    assert.ok(typeof parsed.content === 'string');
    assert.match(parsed.content, /npm test|force push/);
  });

  test('--target lmstudio-cli → single-line text with newlines escaped', async () => {
    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(
      {
        target: 'lmstudio-cli',
        workdir: WORKDIR,
        tokenBudget: 800,
        types: ['lesson', 'fact', 'decision', 'context'],
      },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    // Must terminate with one trailing \n (writer-added)
    assert.ok(out.endsWith('\n'), 'lmstudio-cli output must end with newline');
    // Body itself must be a single line (no embedded raw newlines)
    const body = out.slice(0, -1);
    assert.ok(!body.includes('\n'), 'lmstudio-cli body must not contain raw newlines');
    // Must contain the literal escape sequence \\n (markdown had real newlines)
    assert.match(body, /\\n/, 'lmstudio-cli body must escape newlines as \\n');
    // And still contain seeded memory text
    assert.match(body, /npm test|force push/);
  });
});

import {
  EMIT_MIN_TRUST_DEFAULT,
  parseEmitMinTrust,
  VALID_EMIT_MIN_TRUST,
} from './cmd-context-emit.js';

describe('T1: executeContextEmitCommand --min-trust default = provisional', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
  });

  test('default (no minTrust passed) excludes unverified auto-extracted entries', async () => {
    // Seed: only one unverified auto-extracted memory in the workdir.
    const { unverifiedId } = seedUnverifiedMemory();
    assert.ok(unverifiedId, 'precondition: unverified memory was seeded');

    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(
      {
        target: 'cc',
        workdir: WORKDIR,
        tokenBudget: 800,
        types: ['lesson', 'fact', 'decision', 'context'],
        // minTrust intentionally omitted — exercises the new default path
      },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    const parsed = JSON.parse(out.trim()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    // Default = 'provisional' → unverified memory is filtered out → empty body
    assert.strictEqual(
      parsed.hookSpecificOutput.additionalContext,
      '',
      'default min-trust=provisional must filter out unverified auto-extracted entries'
    );
    assert.doesNotMatch(
      parsed.hookSpecificOutput.additionalContext,
      /caching layers/,
      'unverified entry text must not appear under the default filter'
    );
  });

  test('override --min-trust=trusted excludes both unverified and provisional', async () => {
    // Seed mix: provisional (human) + unverified (auto) + trusted (human-pinned)
    seedMemories();
    seedUnverifiedMemory();
    seedTrustedMemory();

    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(
      {
        target: 'cc',
        workdir: WORKDIR,
        tokenBudget: 800,
        types: ['lesson', 'fact', 'decision', 'context'],
        minTrust: 'trusted',
      },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    const parsed = JSON.parse(out.trim()) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /policy directive zeta/, 'trusted entry must surface');
    assert.doesNotMatch(ctx, /npm test|force push/, 'provisional entries must be excluded');
    assert.doesNotMatch(ctx, /caching layers/, 'unverified entry must remain excluded');
  });

  test('override --min-trust=unverified (CLI alias: any) includes unverified entries', async () => {
    // Single unverified entry — must surface only when filter is fully open.
    seedUnverifiedMemory();

    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(
      {
        target: 'cc',
        workdir: WORKDIR,
        tokenBudget: 800,
        types: ['lesson', 'fact', 'decision', 'context'],
        // 'unverified' is what parseEmitMinTrust('any') maps to — same effect
        minTrust: 'unverified',
      },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    const parsed = JSON.parse(out.trim()) as {
      hookSpecificOutput: { additionalContext: string };
    };
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /caching layers/,
      'unverified entry must appear when filter is opened to all tiers'
    );
  });
});

describe('T1: parseEmitMinTrust + EMIT_MIN_TRUST_DEFAULT contract', () => {
  test('undefined input → EMIT_MIN_TRUST_DEFAULT (provisional)', () => {
    assert.strictEqual(EMIT_MIN_TRUST_DEFAULT, 'provisional');
    assert.strictEqual(parseEmitMinTrust(undefined), 'provisional');
  });

  test('"any" alias maps to "unverified" (no filter)', () => {
    assert.strictEqual(parseEmitMinTrust('any'), 'unverified');
  });

  test('explicit "trusted" / "provisional" / "unverified" pass through', () => {
    assert.strictEqual(parseEmitMinTrust('trusted'), 'trusted');
    assert.strictEqual(parseEmitMinTrust('provisional'), 'provisional');
    assert.strictEqual(parseEmitMinTrust('unverified'), 'unverified');
  });

  test('invalid value throws with the accepted-values list in the message', () => {
    assert.throws(
      () => parseEmitMinTrust('bogus'),
      (err: Error) =>
        /--min-trust must be one of/.test(err.message) &&
        VALID_EMIT_MIN_TRUST.every((v) => err.message.includes(v))
    );
  });

  test('VALID_EMIT_MIN_TRUST exposes the four accepted CLI values', () => {
    assert.deepStrictEqual(
      [...VALID_EMIT_MIN_TRUST].sort(),
      ['any', 'provisional', 'trusted', 'unverified']
    );
  });
});

describe('PLAN-4 T6: loadRecalledLessonsContent wires semantic similarities', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
    seedMemories();
  });

  test('context-emit path runs through computeSemanticSimilarities short-circuit', async () => {
    // With RELAY_EMBEDDING_MODEL unset, computeSemanticSimilarities returns an
    // empty Map (short-circuit), budgetedRecall falls through to word-overlap.
    // The output must remain byte-identical to pre-T6 (memories surface as
    // before). This proves the wire-up does not regress the unset path.
    const prevModel = process.env['RELAY_EMBEDDING_MODEL'];
    delete process.env['RELAY_EMBEDDING_MODEL'];
    try {
      const cap = makeIO(WORKDIR);
      const code = await executeContextEmitCommand(
        {
          target: 'cc',
          workdir: WORKDIR,
          tokenBudget: 800,
          types: ['lesson', 'fact', 'decision', 'context'],
        },
        cap.io
      );
      assert.strictEqual(code, 0);
      const parsed = JSON.parse(cap.stdout.join('').trim()) as {
        hookSpecificOutput: { additionalContext: string };
      };
      // Seeded memories must still surface — semantic helper short-circuits cleanly.
      assert.match(parsed.hookSpecificOutput.additionalContext, /npm test|force push/);
    } finally {
      if (prevModel === undefined) delete process.env['RELAY_EMBEDDING_MODEL'];
      else process.env['RELAY_EMBEDDING_MODEL'] = prevModel;
    }
  });
});

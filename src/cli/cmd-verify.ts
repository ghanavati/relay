/**
 * `relay verify` — end-to-end smoke test as a built-in CLI command.
 *
 * Replaces ad-hoc smoke scripts. Exercises the v0.1.0 surface:
 *   1. memory remember          — writes a tagged fact
 *   2. memory recall            — reads it back via the recall tool
 *   3. context emit             — loadRecalledLessonsContent (recalled_lessons layer)
 *   4. hook script              — verify HOOK_SCRIPT format + DB roundtrip
 *   5. db roundtrip             — direct MemoryStore read/write/get
 *
 * Each check returns `{name, status: 'pass'|'fail'|'skip', message}`.
 * Exit 1 if any critical step fails. `--json` mode emits structured result.
 */
import type { CliIO } from './commands.js';
import { c, statusBadge } from './colors.js';
import { randomUUID } from 'node:crypto';

export interface VerifyArgs {
  json: boolean;
}

export type VerifyStatus = 'pass' | 'fail' | 'skip';

export interface VerifyCheck {
  name: string;
  status: VerifyStatus;
  message: string;
  critical: boolean;
}

interface VerifySummary {
  pass: number;
  fail: number;
  skip: number;
}

const SMOKE_TAG = 'relay-verify-smoke';

/**
 * Optional dependency seam for tests. When provided, individual check runners
 * are replaced with the supplied stubs. Production code passes nothing and
 * gets the default implementations below. Each stub receives the same args
 * as the real runner.
 */
export interface VerifyDeps {
  runRememberCheck?: (token: string) => Promise<VerifyCheck>;
  runRecallCheck?: (token: string) => Promise<VerifyCheck>;
  runContextEmitCheck?: (workdir: string, token: string) => Promise<VerifyCheck>;
  runHookCheck?: () => Promise<VerifyCheck>;
  runDbRoundtripCheck?: () => Promise<VerifyCheck>;
}

export async function runRememberCheck(token: string): Promise<VerifyCheck> {
  try {
    const { handleRemember } = await import('../tools/remember.js');
    const { RememberArgsSchema } = await import('../contracts/memory.js');
    const args = RememberArgsSchema.parse({
      content: `relay verify smoke test ${token}`,
      memory_type: 'fact',
      tags: [SMOKE_TAG, token],
      pinned: false,
    });
    const response = handleRemember(args, 'human') as { content: Array<{ type: string; text: string }>; isError?: boolean };
    if (response.isError) {
      return { name: 'remember', status: 'fail', message: 'remember returned isError', critical: true };
    }
    const text = response.content[0]?.text ?? '{}';
    const parsed = JSON.parse(text) as { memory_id?: string };
    if (!parsed.memory_id) {
      return { name: 'remember', status: 'fail', message: 'no memory_id in response', critical: true };
    }
    return { name: 'remember', status: 'pass', message: `wrote ${parsed.memory_id.slice(0, 8)}`, critical: true };
  } catch (err) {
    return { name: 'remember', status: 'fail', message: (err as Error).message, critical: true };
  }
}

export async function runRecallCheck(token: string): Promise<VerifyCheck> {
  try {
    const { handleRecall } = await import('../tools/recall.js');
    const { RecallArgsSchema } = await import('../contracts/memory.js');
    const args = RecallArgsSchema.parse({
      query: token,
      tags: [SMOKE_TAG],
      token_budget: 800,
    });
    const response = handleRecall(args) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    if (response.isError) {
      return { name: 'recall', status: 'fail', message: 'recall returned isError', critical: true };
    }
    const text = response.content[0]?.text ?? '{}';
    const parsed = JSON.parse(text) as { memories?: Array<{ content?: string }> };
    const found = (parsed.memories ?? []).some(m => (m.content ?? '').includes(token));
    if (!found) {
      return { name: 'recall', status: 'fail', message: `token ${token} not in recalled memories`, critical: true };
    }
    return { name: 'recall', status: 'pass', message: `recalled ${parsed.memories?.length ?? 0} entry(ies)`, critical: true };
  } catch (err) {
    return { name: 'recall', status: 'fail', message: (err as Error).message, critical: true };
  }
}

export async function runContextEmitCheck(workdir: string, token: string): Promise<VerifyCheck> {
  try {
    const { loadRecalledLessonsContent } = await import('../context/layers.js');
    const content = await loadRecalledLessonsContent(workdir, token, undefined, {
      types: ['fact', 'lesson', 'decision', 'context'],
      tokenBudget: 800,
    });
    if (content === null || content === '') {
      return { name: 'context-emit', status: 'fail', message: 'recalled_lessons emitted empty content', critical: true };
    }
    if (!content.includes(token)) {
      return { name: 'context-emit', status: 'fail', message: 'context did not include smoke token', critical: true };
    }
    return { name: 'context-emit', status: 'pass', message: `emitted ${content.length} chars`, critical: true };
  } catch (err) {
    return { name: 'context-emit', status: 'fail', message: (err as Error).message, critical: true };
  }
}

export async function runHookCheck(): Promise<VerifyCheck> {
  try {
    const { HOOK_SCRIPT } = await import('./cmd-memory-ops.js');
    if (typeof HOOK_SCRIPT !== 'string' || !HOOK_SCRIPT.includes('relay context emit')) {
      return { name: 'hook', status: 'fail', message: 'HOOK_SCRIPT missing relay context emit', critical: true };
    }
    if (!HOOK_SCRIPT.includes('--target cc')) {
      return { name: 'hook', status: 'fail', message: 'HOOK_SCRIPT missing --target cc', critical: true };
    }
    return { name: 'hook', status: 'pass', message: 'SessionStart hook script well-formed', critical: false };
  } catch (err) {
    return { name: 'hook', status: 'fail', message: (err as Error).message, critical: true };
  }
}

export async function runDbRoundtripCheck(): Promise<VerifyCheck> {
  try {
    const { MemoryStore } = await import('../memory/memory-store.js');
    const store = new MemoryStore();
    const probeContent = `verify db roundtrip ${randomUUID()}`;
    const id = store.remember({
      content: probeContent,
      memory_type: 'fact',
      tags: [SMOKE_TAG, 'db-roundtrip'],
    });
    const fetched = store.getMemory(id);
    if (!fetched) {
      return { name: 'db-roundtrip', status: 'fail', message: `getMemory returned null for ${id}`, critical: true };
    }
    if (fetched.content !== probeContent) {
      return { name: 'db-roundtrip', status: 'fail', message: 'content mismatch after roundtrip', critical: true };
    }
    return { name: 'db-roundtrip', status: 'pass', message: `db read/write ok (${id.slice(0, 8)})`, critical: true };
  } catch (err) {
    return { name: 'db-roundtrip', status: 'fail', message: (err as Error).message, critical: true };
  }
}

export async function executeVerifyCommand(args: VerifyArgs, io: CliIO, _deps?: VerifyDeps): Promise<number> {
  const token = randomUUID().slice(0, 8);
  const checks: VerifyCheck[] = [];

  // Resolve runners — defaults are real implementations; tests inject stubs.
  const rememberFn = _deps?.runRememberCheck ?? runRememberCheck;
  const recallFn = _deps?.runRecallCheck ?? runRecallCheck;
  const contextEmitFn = _deps?.runContextEmitCheck ?? runContextEmitCheck;
  const hookFn = _deps?.runHookCheck ?? runHookCheck;
  const dbRoundtripFn = _deps?.runDbRoundtripCheck ?? runDbRoundtripCheck;

  // 1. write a memory
  checks.push(await rememberFn(token));
  // 2. recall it back
  checks.push(await recallFn(token));
  // 3. context emit (recalled_lessons layer)
  checks.push(await contextEmitFn(io.cwd, token));
  // 4. hook script roundtrip
  checks.push(await hookFn());
  // 5. direct db roundtrip
  checks.push(await dbRoundtripFn());

  const summary: VerifySummary = checks.reduce(
    (acc, ch) => {
      acc[ch.status] += 1;
      return acc;
    },
    { pass: 0, fail: 0, skip: 0 } as VerifySummary
  );
  const criticalFailed = checks.some(ch => ch.critical && ch.status === 'fail');

  if (args.json) {
    io.stdout(JSON.stringify({ checks, summary, ok: !criticalFailed }) + '\n');
  } else {
    io.stdout(c.bold('relay verify') + '\n\n');
    for (const ch of checks) {
      const badge = statusBadge(ch.status === 'pass' ? 'ok' : ch.status === 'fail' ? 'failed' : 'missing');
      io.stdout(`${ch.name.padEnd(16)} ${badge} ${c.dim(ch.message)}\n`);
    }
    io.stdout('\n');
    if (criticalFailed) {
      io.stdout(`${c.red(`${summary.fail} check(s) failed`)}, ${summary.pass} passed, ${summary.skip} skipped.\n`);
    } else {
      io.stdout(`${c.green('All critical checks passed.')} (${summary.pass} pass, ${summary.skip} skip)\n`);
    }
  }

  return criticalFailed ? 1 : 0;
}

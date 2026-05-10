process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { executeMemoryAutoExtractCommand } from './cmd-memory-auto-extract.js';
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

/**
 * Replace process.stdin with an in-memory Readable for the duration of one
 * call, then restore. Node lets us reassign because process is a plain object
 * and stdin is a getter-backed property only on some platforms — `Object.defineProperty`
 * is the safe path.
 */
async function withStdin<T>(payload: string, fn: () => Promise<T>): Promise<T> {
  const original = process.stdin;
  const stream = Readable.from([Buffer.from(payload, 'utf8')]);
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', { value: original, configurable: true });
  }
}

describe('executeMemoryAutoExtractCommand', () => {
  let tmp: string;
  // Redirect HOME so the audit log writes into the test sandbox.
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-auto-extract-'));
    savedHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    // homedir() in Node honours $HOME on POSIX. We don't run on Windows.
    void homedir;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test('rejects without --from-stdin → exit 2 with stderr message', async () => {
    const cap = makeIO(tmp);
    const code = await executeMemoryAutoExtractCommand(
      { fromStdin: false, maxBytes: undefined, json: false },
      cap.io
    );
    assert.strictEqual(code, 2);
    assert.match(cap.stderr.join(''), /--from-stdin/);
  });

  test('bad JSON on stdin → exit 0 (never blocks CC) + audit logged + bad-payload status', async () => {
    const cap = makeIO(tmp);
    const code = await withStdin('not-json{{{', () =>
      executeMemoryAutoExtractCommand(
        { fromStdin: true, maxBytes: undefined, json: true },
        cap.io
      )
    );
    assert.strictEqual(code, 0, 'hooks must never block — bad payload still exits 0');
    const out = cap.stdout.join('').trim();
    const parsed = JSON.parse(out) as { status: string };
    assert.strictEqual(parsed.status, 'skipped:bad-payload');

    // Audit log line written
    const auditPath = join(tmp, '.relay', 'auto-extract.log');
    const audit = await readFile(auditPath, 'utf8');
    assert.match(audit, /skipped:bad-payload/);
  });

  test('valid payload + no consent file → skipped:no-consent, exit 0', async () => {
    const projectCwd = join(tmp, 'project');
    await mkdir(projectCwd, { recursive: true });
    const transcriptPath = join(projectCwd, 'transcript.jsonl');
    await writeFile(transcriptPath, JSON.stringify({ role: 'user', text: 'hi' }) + '\n', 'utf8');

    const payload = JSON.stringify({
      session_id: 'sess-123',
      transcript_path: transcriptPath,
      cwd: projectCwd,
      hook_event_name: 'SessionEnd',
    });

    const cap = makeIO(tmp);
    const code = await withStdin(payload, () =>
      executeMemoryAutoExtractCommand(
        { fromStdin: true, maxBytes: undefined, json: true },
        cap.io
      )
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('').trim();
    const parsed = JSON.parse(out) as { status: string; cwd: string };
    assert.strictEqual(parsed.status, 'skipped:no-consent');
    assert.strictEqual(parsed.cwd, projectCwd);

    const auditPath = join(tmp, '.relay', 'auto-extract.log');
    const audit = await readFile(auditPath, 'utf8');
    assert.match(audit, /skipped:no-consent/);
    assert.match(audit, /sess-123/);
  });

  test('consent file with enabled:false → skipped:disabled', async () => {
    const projectCwd = join(tmp, 'project');
    await mkdir(join(projectCwd, '.relay'), { recursive: true });
    await writeFile(
      join(projectCwd, '.relay', 'auto-extract.json'),
      JSON.stringify({ enabled: false }),
      'utf8'
    );
    const transcriptPath = join(projectCwd, 'transcript.jsonl');
    await writeFile(transcriptPath, JSON.stringify({ role: 'user' }) + '\n', 'utf8');

    const payload = JSON.stringify({
      session_id: 's2',
      transcript_path: transcriptPath,
      cwd: projectCwd,
    });

    const cap = makeIO(tmp);
    const code = await withStdin(payload, () =>
      executeMemoryAutoExtractCommand(
        { fromStdin: true, maxBytes: undefined, json: true },
        cap.io
      )
    );
    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string };
    assert.strictEqual(out.status, 'skipped:disabled');
  });

  test('consent enabled but transcript missing → skipped:no-transcript', async () => {
    const projectCwd = join(tmp, 'project2');
    await mkdir(join(projectCwd, '.relay'), { recursive: true });
    await writeFile(
      join(projectCwd, '.relay', 'auto-extract.json'),
      JSON.stringify({ enabled: true }),
      'utf8'
    );

    const payload = JSON.stringify({
      session_id: 's3',
      transcript_path: join(projectCwd, 'does-not-exist.jsonl'),
      cwd: projectCwd,
    });

    const cap = makeIO(tmp);
    const code = await withStdin(payload, () =>
      executeMemoryAutoExtractCommand(
        { fromStdin: true, maxBytes: undefined, json: true },
        cap.io
      )
    );
    assert.strictEqual(code, 0);
    const out = JSON.parse(cap.stdout.join('').trim()) as { status: string };
    assert.strictEqual(out.status, 'skipped:no-transcript');
  });

  test('consent + valid transcript + LM Studio unreachable → error:llm-down', async () => {
    const projectCwd = join(tmp, 'project3');
    await mkdir(join(projectCwd, '.relay'), { recursive: true });
    await writeFile(
      join(projectCwd, '.relay', 'auto-extract.json'),
      JSON.stringify({ enabled: true }),
      'utf8'
    );
    const transcriptPath = join(projectCwd, 'transcript.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ role: 'user', text: 'hello' }),
        JSON.stringify({ role: 'assistant', text: 'hi' }),
      ].join('\n') + '\n',
      'utf8'
    );

    const payload = JSON.stringify({
      session_id: 's4',
      transcript_path: transcriptPath,
      cwd: projectCwd,
      hook_event_name: 'SessionEnd',
    });

    // Force LM Studio unreachable by pointing at a closed port.
    const prevEndpoint = process.env['RELAY_AUTO_EXTRACT_ENDPOINT'];
    process.env['RELAY_AUTO_EXTRACT_ENDPOINT'] = 'http://127.0.0.1:1';
    try {
      const cap = makeIO(tmp);
      const code = await withStdin(payload, () =>
        executeMemoryAutoExtractCommand(
          { fromStdin: true, maxBytes: undefined, json: true },
          cap.io
        )
      );
      assert.strictEqual(code, 0);
      const parsed = JSON.parse(cap.stdout.join('').trim()) as {
        status: string;
        session_id: string;
        turns_read: number;
      };
      assert.strictEqual(parsed.status, 'error:llm-down');
      assert.strictEqual(parsed.session_id, 's4');
      assert.strictEqual(parsed.turns_read, 2);

      const audit = await readFile(join(tmp, '.relay', 'auto-extract.log'), 'utf8');
      assert.match(audit, /error:llm-down/);
      assert.match(audit, /s4/);
    } finally {
      if (prevEndpoint === undefined) delete process.env['RELAY_AUTO_EXTRACT_ENDPOINT'];
      else process.env['RELAY_AUTO_EXTRACT_ENDPOINT'] = prevEndpoint;
    }
  });
});

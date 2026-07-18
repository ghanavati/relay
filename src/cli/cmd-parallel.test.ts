process.env['RELAY_DB_PATH'] = ':memory:';

import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeParallelCommand } from './cmd-parallel.js';
import { ControlSessionStore } from '../control/session-store.js';

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function makeIo(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { cwd, stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) }, stdout, stderr };
}

async function writeSpec(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-parallel-test.'));
  tempPaths.push(dir);
  const path = join(dir, 'spec.json');
  await writeFile(path, JSON.stringify(value));
  return path;
}

test('parallel refuses agentic tasks that share a workdir', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'relay-parallel-workdir.'));
  tempPaths.push(workdir);
  const specPath = await writeSpec({ tasks: [
    { task: 'first', provider: 'lmstudio-agentic', model: 'test-model', workdir },
    { task: 'second', provider: 'lmstudio-agentic', model: 'test-model', workdir },
  ] });
  const captured = makeIo(workdir);

  const code = await executeParallelCommand({ specPath, maxConcurrency: 2, json: true }, captured.io);

  assert.equal(code, 2);
  assert.match(captured.stderr.join(''), /separate workdir/i);
});

test('parallel agentic runs register and end a Relay control session', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'relay-parallel-workdir.'));
  tempPaths.push(workdir);
  const specPath = await writeSpec({ tasks: [
    { task: 'inspect the workdir', provider: 'lmstudio-agentic', model: 'test-model', workdir, timeout_ms: 1_000 },
  ] });
  const captured = makeIo(workdir);
  const oldEndpoint = process.env['LMSTUDIO_ENDPOINT'];
  process.env['LMSTUDIO_ENDPOINT'] = 'http://127.0.0.1:1';

  try {
    await executeParallelCommand({ specPath, maxConcurrency: 1, json: true }, captured.io);
  } finally {
    if (oldEndpoint === undefined) delete process.env['LMSTUDIO_ENDPOINT'];
    else process.env['LMSTUDIO_ENDPOINT'] = oldEndpoint;
  }

  const response = JSON.parse(captured.stdout.join('')) as { runs: Array<{ run_id: string }> };
  const session = new ControlSessionStore().getSession(response.runs[0]!.run_id);
  assert.ok(session, 'agentic parallel run registers a control session');
  assert.equal(session.state, 'ended');
});

test('parallel JSON includes an agentic runner error message', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'relay-parallel-workdir.'));
  tempPaths.push(workdir);
  const specPath = await writeSpec({ tasks: [
    { task: 'inspect the workdir', provider: 'lmstudio-agentic', model: 'test-model', workdir, timeout_ms: 1_000 },
  ] });
  const captured = makeIo(workdir);
  const oldEndpoint = process.env['LMSTUDIO_ENDPOINT'];
  process.env['LMSTUDIO_ENDPOINT'] = 'http://127.0.0.1:1';

  try {
    await executeParallelCommand({ specPath, maxConcurrency: 1, json: true }, captured.io);
  } finally {
    if (oldEndpoint === undefined) delete process.env['LMSTUDIO_ENDPOINT'];
    else process.env['LMSTUDIO_ENDPOINT'] = oldEndpoint;
  }

  const response = JSON.parse(captured.stdout.join('')) as { runs: Array<{ status: string; error?: string }> };
  assert.equal(response.runs[0]?.status, 'error');
  assert.match(response.runs[0]?.error ?? '', /LM Studio/i);
});

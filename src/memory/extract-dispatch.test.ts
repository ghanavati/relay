process.env['RELAY_DB_PATH'] = ':memory:';

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  dispatchExtraction,
  type ExtractionRunnerFactory,
} from './extract-dispatch.js';
import type { ProviderConfig } from '../workers/provider-registry.js';
import type { WorkerRunner } from '../workers/runner.js';
import type { WorkerTask, WorkerResult } from '../workers/types.js';

function successRunner(tasks: WorkerTask[]): WorkerRunner {
  return {
    async run(task: WorkerTask): Promise<WorkerResult> {
      tasks.push(task);
      return {
        status: 'success',
        output: '{"lessons":[]}',
        duration_ms: 7,
        exit_code: 0,
      };
    },
  };
}

describe('dispatchExtraction — provider-agnostic registry dispatch', () => {
  test('resolves builtin and env provider names through resolveProvider', async () => {
    const env = {
      RELAY_PROVIDER_FOO_URL: 'https://foo.example/v1',
    } as NodeJS.ProcessEnv;
    const seen: ProviderConfig[] = [];
    const tasks: WorkerTask[] = [];
    const factory: ExtractionRunnerFactory = async (config) => {
      seen.push(config);
      return successRunner(tasks);
    };

    for (const name of ['codex', 'claude', 'anthropic', 'lmstudio', 'foo']) {
      const output = await dispatchExtraction(name, `prompt for ${name}`, {
        timeoutMs: 1234,
        model: name === 'codex' || name === 'claude' ? undefined : 'model/x',
        workdir: '/tmp/project',
        env,
        runnerFactory: factory,
      });
      assert.strictEqual(output, '{"lessons":[]}');
    }

    assert.deepStrictEqual(
      seen.map((config) => [config.name, config.source, config.type]),
      [
        ['codex', 'builtin', 'subprocess'],
        ['claude', 'builtin', 'subprocess'],
        ['anthropic', 'builtin', 'anthropic'],
        ['lmstudio', 'builtin', 'openai'],
        ['foo', 'env', 'openai'],
      ],
    );
    assert.strictEqual(tasks.length, 5);
    assert.strictEqual(tasks[0]!.provider, 'codex');
    assert.strictEqual(tasks[1]!.provider, 'claude');
    assert.strictEqual(tasks[4]!.model, 'model/x');
    assert.strictEqual(tasks[4]!.timeout_ms, 1234);
    assert.strictEqual(tasks[4]!.workdir, '/tmp/project');
  });

  test('unknown provider rejects with the registry error', async () => {
    await assert.rejects(
      dispatchExtraction('missing-provider', 'prompt', {
        timeoutMs: 100,
        runnerFactory: async () => successRunner([]),
      }),
      /unknown provider "missing-provider"/,
    );
  });

  test('runner timeout/error statuses reject with context instead of returning partial text', async () => {
    const factory: ExtractionRunnerFactory = async () => ({
      async run(_task: WorkerTask): Promise<WorkerResult> {
        return {
          status: 'timeout',
          output: 'partial',
          duration_ms: 100,
          exit_code: null,
          error: {
            code: 'TIMEOUT',
            message: 'synthetic timeout',
            retryable: true,
          },
        };
      },
    });

    await assert.rejects(
      dispatchExtraction('codex', 'prompt', { timeoutMs: 100, runnerFactory: factory }),
      /synthetic timeout/,
    );
  });
});

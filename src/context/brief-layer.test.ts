import { describe, test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBriefLayerProvider } from './brief-layer.js';

describe('brief-layer', () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'relay-brief-layer-'));
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('missing .relay/brief.md => returns null', async () => {
    const workdir = tmpRoot;
    const provider = createBriefLayerProvider();
    const result = await provider.load({ workdir });
    assert.strictEqual(result, null);
  });

  test('empty .relay/brief.md => returns null', async () => {
    const workdir = tmpRoot;
    const relayDir = join(workdir, '.relay');
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(join(relayDir, 'brief.md'), '', 'utf8');

    const provider = createBriefLayerProvider();
    const result = await provider.load({ workdir });
    assert.strictEqual(result, null);
  });

  test('.relay/brief.md with content => returns layer with that content', async () => {
    const workdir = tmpRoot;
    const relayDir = join(workdir, '.relay');
    mkdirSync(relayDir, { recursive: true });
    const content = '# Test Brief\n\nThis is a test brief file.';
    writeFileSync(join(relayDir, 'brief.md'), content, 'utf8');

    const provider = createBriefLayerProvider();
    const result = await provider.load({ workdir });
    assert.ok(result);
    assert.strictEqual(result!.id, 'project_knowledge');
    assert.strictEqual(result!.content, content);
  });

  test('provider id === "project_knowledge"', () => {
    const provider = createBriefLayerProvider();
    assert.strictEqual(provider.id, 'project_knowledge');
  });
});

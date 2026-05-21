import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cleanupAndValidate, ExtractedLesson, ExtractionResult } from './auto-extract-schema.js';

describe('cleanupAndValidate — happy path', () => {
  test('accepts plain JSON with valid lessons above threshold', () => {
    const raw = JSON.stringify({
      lessons: [
        {
          content: 'Always use spread to copy arrays in TS',
          memory_type: 'lesson',
          confidence: 0.85,
        },
      ],
    });

    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lessons.length, 1);
      assert.equal(result.lessons[0]?.memory_type, 'lesson');
      assert.equal(result.lessons[0]?.confidence, 0.85);
    }
  });

  test('accepts all three memory_type values', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'lesson content here', memory_type: 'lesson', confidence: 0.9 },
        { content: 'fact content here  ', memory_type: 'fact', confidence: 0.9 },
        { content: 'decision body text ', memory_type: 'decision', confidence: 0.9 },
      ],
    });

    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lessons.length, 3);
    }
  });

  test('accepts empty raw lessons but reports low-confidence (no kept)', () => {
    // Edge: zero lessons in array — schema allows it (max 3, no min), but
    // filter step yields zero kept, so reason becomes low-confidence.
    const raw = JSON.stringify({ lessons: [] });
    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'low-confidence');
    }
  });
});

describe('cleanupAndValidate — code fence stripping (qwen wrapping)', () => {
  test('strips ```json fences', () => {
    const inner = JSON.stringify({
      lessons: [
        { content: 'always validate at boundaries', memory_type: 'lesson', confidence: 0.8 },
      ],
    });
    const raw = '```json\n' + inner + '\n```';

    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, true);
  });

  test('strips bare ``` fences (no language tag)', () => {
    const inner = JSON.stringify({
      lessons: [
        { content: 'use Zod for input validation', memory_type: 'lesson', confidence: 0.7 },
      ],
    });
    const raw = '```\n' + inner + '\n```';

    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, true);
  });

  test('handles fenced JSON with surrounding whitespace', () => {
    const inner = JSON.stringify({
      lessons: [
        { content: 'tests are the spec', memory_type: 'fact', confidence: 0.95 },
      ],
    });
    const raw = '   \n```json\n' + inner + '\n```   \n';

    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, true);
  });

  test('strips ```js fences', () => {
    const inner = JSON.stringify({
      lessons: [
        { content: 'better-sqlite3 is synchronous', memory_type: 'fact', confidence: 0.9 },
      ],
    });
    const raw = '```js\n' + inner + '\n```';

    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, true);
  });
});

describe('cleanupAndValidate — malformed JSON', () => {
  test('reports parse-error on broken JSON', () => {
    const raw = '{ lessons: [not json';
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'parse-error');
      assert.ok(result.detail !== undefined && result.detail.length > 0);
    }
  });

  test('reports parse-error on empty string', () => {
    const result = cleanupAndValidate('');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'parse-error');
    }
  });

  test('reports parse-error on whitespace-only input', () => {
    const result = cleanupAndValidate('   \n\t  ');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'parse-error');
    }
  });

  test('reports parse-error on fenced non-JSON', () => {
    const result = cleanupAndValidate('```json\nhello not json\n```');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'parse-error');
    }
  });
});

describe('cleanupAndValidate — schema failures', () => {
  test('rejects when lessons key is missing', () => {
    const raw = JSON.stringify({ items: [] });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'schema-error');
    }
  });

  test('rejects content shorter than 10 chars', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'short', memory_type: 'lesson', confidence: 0.9 },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'schema-error');
      assert.ok(result.detail !== undefined && result.detail.includes('content'));
    }
  });

  test('rejects content longer than 200 chars', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'a'.repeat(201), memory_type: 'lesson', confidence: 0.9 },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'schema-error');
    }
  });

  test('rejects unknown memory_type values', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'valid content here', memory_type: 'context', confidence: 0.9 },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'schema-error');
    }
  });

  test('rejects confidence > 1', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'valid content here', memory_type: 'lesson', confidence: 1.5 },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'schema-error');
    }
  });

  test('rejects confidence < 0', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'valid content here', memory_type: 'lesson', confidence: -0.1 },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'schema-error');
    }
  });

  test('rejects more than 3 lessons', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'lesson one content', memory_type: 'lesson', confidence: 0.9 },
        { content: 'lesson two content', memory_type: 'lesson', confidence: 0.9 },
        { content: 'lesson three body ', memory_type: 'lesson', confidence: 0.9 },
        { content: 'lesson four body  ', memory_type: 'lesson', confidence: 0.9 },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'schema-error');
    }
  });

  test('rejects non-object root', () => {
    const raw = JSON.stringify(['not', 'an', 'object']);
    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'schema-error');
    }
  });
});

describe('cleanupAndValidate — confidence filter', () => {
  test('drops lessons below default minConfidence (0.6)', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'high-confidence claim', memory_type: 'lesson', confidence: 0.85 },
        { content: 'low-confidence guess ', memory_type: 'lesson', confidence: 0.4 },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lessons.length, 1);
      assert.equal(result.lessons[0]?.confidence, 0.85);
    }
  });

  test('keeps lessons exactly at threshold (>= comparison)', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'right at threshold', memory_type: 'lesson', confidence: 0.6 },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lessons.length, 1);
    }
  });

  test('honors caller-supplied minConfidence (stricter)', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'medium confidence c', memory_type: 'lesson', confidence: 0.7 },
      ],
    });
    const result = cleanupAndValidate(raw, 0.9);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'low-confidence');
    }
  });

  test('honors caller-supplied minConfidence (looser)', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'low confidence one  ', memory_type: 'lesson', confidence: 0.3 },
      ],
    });
    const result = cleanupAndValidate(raw, 0.2);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lessons.length, 1);
    }
  });

  test('reports low-confidence when ALL lessons are below threshold', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'first low confid ', memory_type: 'lesson', confidence: 0.3 },
        { content: 'second low confid', memory_type: 'lesson', confidence: 0.4 },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'low-confidence');
      assert.ok(result.detail !== undefined && result.detail.includes('2'));
    }
  });
});

describe('cleanupAndValidate — redaction leak', () => {
  test('rejects when any lesson content includes [REDACTED:', () => {
    const raw = JSON.stringify({
      lessons: [
        {
          content: 'auth token [REDACTED:OPENAI_KEY] saved',
          memory_type: 'lesson',
          confidence: 0.9,
        },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'redaction-leak');
    }
  });

  test('rejects even one leaked lesson among clean ones', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'a totally clean lesson', memory_type: 'lesson', confidence: 0.9 },
        {
          content: 'leaked [REDACTED:AWS_KEY] body',
          memory_type: 'lesson',
          confidence: 0.9,
        },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'redaction-leak');
    }
  });

  test('does NOT trip on the bare word "redacted" without bracket sentinel', () => {
    const raw = JSON.stringify({
      lessons: [
        {
          content: 'comment about redacted text',
          memory_type: 'lesson',
          confidence: 0.9,
        },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, true);
  });

  test('redaction-leak takes priority over low-confidence', () => {
    // A leaked lesson at confidence 0.1 should still report redaction-leak,
    // because leak detection happens before the confidence filter.
    const raw = JSON.stringify({
      lessons: [
        {
          content: 'leaked [REDACTED:GITHUB_PAT] hi',
          memory_type: 'lesson',
          confidence: 0.1,
        },
      ],
    });
    const result = cleanupAndValidate(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'redaction-leak');
    }
  });
});

describe('cleanupAndValidate — kind field (Phase 6 delta-extraction signal)', () => {
  test('accepts lesson without kind (defaults to add semantically; field optional)', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'no kind field present', memory_type: 'lesson', confidence: 0.8 },
      ],
    });
    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lessons[0]?.kind, undefined, 'missing kind stays undefined');
    }
  });

  test('accepts kind="add"', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'kind add valid one', memory_type: 'lesson', confidence: 0.8, kind: 'add' },
      ],
    });
    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lessons[0]?.kind, 'add');
    }
  });

  test('accepts kind="refine"', () => {
    const raw = JSON.stringify({
      lessons: [
        { content: 'kind refine valid', memory_type: 'lesson', confidence: 0.8, kind: 'refine' },
      ],
    });
    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lessons[0]?.kind, 'refine');
    }
  });

  test('accepts kind="contradict" (load-bearing: routes to delta-contradiction memory_source)', () => {
    const raw = JSON.stringify({
      lessons: [
        {
          content: 'kind contradict valid',
          memory_type: 'lesson',
          confidence: 0.8,
          kind: 'contradict',
        },
      ],
    });
    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lessons[0]?.kind, 'contradict');
    }
  });

  test('rejects unknown kind values', () => {
    const raw = JSON.stringify({
      lessons: [
        {
          content: 'kind invalid value here',
          memory_type: 'lesson',
          confidence: 0.8,
          kind: 'override',
        },
      ],
    });
    const result = cleanupAndValidate(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'schema-error');
      assert.ok(result.detail !== undefined && result.detail.includes('kind'));
    }
  });
});

describe('schema exports — direct safeParse', () => {
  test('ExtractedLesson validates a single lesson object', () => {
    const parsed = ExtractedLesson.safeParse({
      content: 'a single valid lesson',
      memory_type: 'fact',
      confidence: 0.5,
    });
    assert.equal(parsed.success, true);
  });

  test('ExtractionResult validates the wrapper', () => {
    const parsed = ExtractionResult.safeParse({
      lessons: [
        { content: 'wrapper test lesson', memory_type: 'lesson', confidence: 0.5 },
      ],
    });
    assert.equal(parsed.success, true);
  });
});

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { CorpusQueryArgsSchema } from './corpus.js';

test('valid parse — minimal fields', () => {
  const result = CorpusQueryArgsSchema.safeParse({ name: 'my_corpus', query_text: 'hello world' });
  assert.equal(result.success, true);
});

test('valid parse — with limit', () => {
  const result = CorpusQueryArgsSchema.safeParse({ name: 'corpus1', query_text: 'search term', limit: 50 });
  assert.equal(result.success, true);
  assert.equal(result.data.limit, 50);
});

test('empty name — should fail', () => {
  const result = CorpusQueryArgsSchema.safeParse({ name: '', query_text: 'hello' });
  assert.equal(result.success, false);
});

test('name > 200 chars — should fail', () => {
  const longName = 'a'.repeat(201);
  const result = CorpusQueryArgsSchema.safeParse({ name: longName, query_text: 'hello' });
  assert.equal(result.success, false);
});

test('name with spaces — should fail', () => {
  const result = CorpusQueryArgsSchema.safeParse({ name: 'my corpus', query_text: 'hello' });
  assert.equal(result.success, false);
});

test('name with dots — should fail', () => {
  const result = CorpusQueryArgsSchema.safeParse({ name: 'my.corpus', query_text: 'hello' });
  assert.equal(result.success, false);
});

test('underscore allowed in name', () => {
  const result = CorpusQueryArgsSchema.safeParse({ name: 'my_corpus_name', query_text: 'hello' });
  assert.equal(result.success, true);
});

test('hyphen allowed in name', () => {
  const result = CorpusQueryArgsSchema.safeParse({ name: 'my-corpus-name', query_text: 'hello' });
  assert.equal(result.success, true);
});

test('empty query_text — should fail', () => {
  const result = CorpusQueryArgsSchema.safeParse({ name: 'corpus1', query_text: '' });
  assert.equal(result.success, false);
});

test('query_text > 2000 chars — should fail', () => {
  const longQuery = 'a'.repeat(2001);
  const result = CorpusQueryArgsSchema.safeParse({ name: 'corpus1', query_text: longQuery });
  assert.equal(result.success, false);
});

test('limit > 100 — should fail', () => {
  const result = CorpusQueryArgsSchema.safeParse({ name: 'corpus1', query_text: 'hello', limit: 101 });
  assert.equal(result.success, false);
});

test('limit = 0 — should fail', () => {
  const result = CorpusQueryArgsSchema.safeParse({ name: 'corpus1', query_text: 'hello', limit: 0 });
  assert.equal(result.success, false);
});

test('limit is optional — omitting it succeeds', () => {
  const result = CorpusQueryArgsSchema.safeParse({ name: 'corpus1', query_text: 'hello' });
  assert.equal(result.success, true);
  assert.equal(result.data.limit, undefined);
});

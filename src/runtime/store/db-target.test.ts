import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveDbTarget, assertRemoteWritable, _setReplicaOfflineForTest } from './db.js';

describe('resolveDbTarget — RELAY_DB_URL boundary', () => {
  test('unset → local default under ~/.relay', () => {
    const t = resolveDbTarget({});
    assert.equal(t.kind, 'local');
    assert.equal(t.path, join(homedir(), '.relay', 'relay.db'));
  });

  test('RELAY_DB_PATH overrides the local default', () => {
    const t = resolveDbTarget({ RELAY_DB_PATH: '/tmp/elsewhere.db' });
    assert.equal(t.kind, 'local');
    assert.equal(t.path, '/tmp/elsewhere.db');
  });

  test('libsql:// URL → replica target with derived per-remote path + token', () => {
    const t = resolveDbTarget({
      RELAY_DB_URL: 'libsql://mydb-me.turso.io',
      RELAY_DB_AUTH_TOKEN: '  tok123  ',
    });
    assert.equal(t.kind, 'replica');
    if (t.kind !== 'replica') return;
    assert.equal(t.syncUrl, 'libsql://mydb-me.turso.io');
    assert.equal(t.authToken, 'tok123');
    assert.match(t.path, /\.relay\/replica-[0-9a-f]{12}\.db$/);
  });

  test('different URLs derive different replica files; same URL is stable', () => {
    const a = resolveDbTarget({ RELAY_DB_URL: 'libsql://a.turso.io' });
    const b = resolveDbTarget({ RELAY_DB_URL: 'libsql://b.turso.io' });
    const a2 = resolveDbTarget({ RELAY_DB_URL: 'libsql://a.turso.io' });
    assert.notEqual(a.path, b.path);
    assert.equal(a.path, a2.path);
  });

  test('unsupported scheme → rejected, message names the scheme but never the value', () => {
    const url = 'postgres://user:hunter2@host/db';
    assert.throws(
      () => resolveDbTarget({ RELAY_DB_URL: url }),
      (err: Error) => {
        assert.match(err.message, /postgres:/);
        assert.doesNotMatch(err.message, /hunter2/);
        assert.doesNotMatch(err.message, /host\/db/);
        return true;
      }
    );
  });

  test('garbage URL → rejected without echoing the value', () => {
    assert.throws(
      () => resolveDbTarget({ RELAY_DB_URL: 'not a url with secret-bits' }),
      (err: Error) => {
        assert.doesNotMatch(err.message, /secret-bits/);
        return true;
      }
    );
  });

  test('assertRemoteWritable: no-op normally, plain-language refusal in offline fallback', () => {
    assert.doesNotThrow(() => assertRemoteWritable());
    _setReplicaOfflineForTest(true);
    try {
      assert.throws(
        () => assertRemoteWritable(),
        (err: Error) => {
          assert.match(err.message, /saving is paused/);
          assert.match(err.message, /reads still work/i);
          return true;
        }
      );
    } finally {
      _setReplicaOfflineForTest(false);
    }
  });

  test('config file db_url is used when env is unset; env wins when both set', () => {
    // npm test runs with HOME pointed at a scratch dir — safe to write there.
    const relayDir = join(homedir(), '.relay');
    mkdirSync(relayDir, { recursive: true });
    const cfgPath = join(relayDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ db_url: 'libsql://from-config.turso.io' }));
    try {
      const fromConfig = resolveDbTarget({});
      assert.equal(fromConfig.kind, 'replica');
      if (fromConfig.kind === 'replica') {
        assert.equal(fromConfig.syncUrl, 'libsql://from-config.turso.io');
      }
      const envWins = resolveDbTarget({ RELAY_DB_URL: 'libsql://from-env.turso.io' });
      assert.equal(envWins.kind, 'replica');
      if (envWins.kind === 'replica') {
        assert.equal(envWins.syncUrl, 'libsql://from-env.turso.io');
      }
    } finally {
      rmSync(cfgPath, { force: true });
    }
  });
});

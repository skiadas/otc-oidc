import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAdapter, type AdapterBundle } from '../src/adapter.js';
import { createClientReconciler } from '../src/oidc.js';
import type { Config } from '../src/config.js';

let dir: string;
let adapter: AdapterBundle;

function configWith(path: string): Config {
  return { clientsPath: path } as Config;
}

function writeClients(path: string, clients: unknown[]): void {
  writeFileSync(path, JSON.stringify({ clients }));
}

function setMtime(path: string, ms: number): void {
  const seconds = Math.floor(ms / 1000);
  utimesSync(path, seconds, seconds);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'otc-reconcile-'));
  adapter = createSqliteAdapter();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createClientReconciler', () => {
  it('adds a new client when the file changes', async () => {
    const path = join(dir, 'clients.json');
    writeClients(path, [{ client_id: 'a', redirect_uris: ['https://a/cb'] }]);
    const reconciler = createClientReconciler(configWith(path), adapter);

    reconciler.sweep();
    assert.equal(await adapter.adapter('Client').find('a'), undefined);

    writeClients(path, [
      { client_id: 'a', redirect_uris: ['https://a/cb'] },
      { client_id: 'b', redirect_uris: ['https://b/cb'] },
    ]);
    setMtime(path, Date.now() + 60_000);
    reconciler.sweep();

    const found = await adapter.adapter('Client').find('b');
    assert.equal(found?.client_id, 'b');
  });

  it('skips the read when mtime is unchanged', async () => {
    const path = join(dir, 'clients.json');
    writeClients(path, [{ client_id: 'a', redirect_uris: ['https://a/cb'] }]);
    const reconciler = createClientReconciler(configWith(path), adapter);

    const base = Date.now();
    setMtime(path, base);
    reconciler.sweep();

    writeClients(path, [
      { client_id: 'a', redirect_uris: ['https://a/cb'] },
      { client_id: 'b', redirect_uris: ['https://b/cb'] },
    ]);
    setMtime(path, base); // backdate: content changed but mtime did not
    reconciler.sweep();

    assert.equal(await adapter.adapter('Client').find('b'), undefined);
  });

  it('ignores edits to already-known clients', async () => {
    const path = join(dir, 'clients.json');
    writeClients(path, [{ client_id: 'a', client_secret: 'old', redirect_uris: ['https://a/cb'] }]);
    const reconciler = createClientReconciler(configWith(path), adapter);

    writeClients(path, [{ client_id: 'a', client_secret: 'new', redirect_uris: ['https://a/cb'] }]);
    setMtime(path, Date.now() + 60_000);
    reconciler.sweep();

    // 'a' is known from boot, so an edit must not write it into the adapter.
    assert.equal(await adapter.adapter('Client').find('a'), undefined);
  });

  it('does not throw on a malformed file and keeps prior state', async () => {
    const path = join(dir, 'clients.json');
    writeClients(path, [{ client_id: 'a', redirect_uris: ['https://a/cb'] }]);
    const reconciler = createClientReconciler(configWith(path), adapter);

    setMtime(path, Date.now() + 60_000);
    writeFileSync(path, '{ not valid json');
    reconciler.sweep();

    writeClients(path, [{ client_id: 'b', redirect_uris: ['https://b/cb'] }]);
    setMtime(path, Date.now() + 120_000);
    reconciler.sweep();

    assert.equal((await adapter.adapter('Client').find('b'))?.client_id, 'b');
  });

  it('handles a missing file without throwing', async () => {
    const path = join(dir, 'missing.json');
    const reconciler = createClientReconciler(configWith(path), adapter);
    reconciler.sweep();
    reconciler.sweep();
    assert.equal(await adapter.adapter('Client').find('a'), undefined);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteAdapter } from '../src/adapter.js';

describe('SqliteAdapter', () => {
  it('finds a session by its uid', async () => {
    const { adapter } = createSqliteAdapter();
    const sessions = adapter('Session');
    await sessions.upsert('sid1', { uid: 'uid1', accountId: 'a@c.edu' });
    const found = await sessions.findByUid('uid1');
    assert.ok(found);
    assert.equal(found.accountId, 'a@c.edu');
  });

  it('returns undefined for an unknown uid', async () => {
    const { adapter } = createSqliteAdapter();
    const sessions = adapter('Session');
    await sessions.upsert('sid1', { uid: 'uid1' });
    assert.equal(await sessions.findByUid('nope'), undefined);
  });

  it('treats an immediately-expired entry as missing', async () => {
    const { adapter } = createSqliteAdapter();
    const sessions = adapter('Session');
    await sessions.upsert('sid1', { uid: 'uid1' }, 0);
    assert.equal(await sessions.find('sid1'), undefined);
    assert.equal(await sessions.findByUid('uid1'), undefined);
  });

  it('upserting again replaces the stored payload', async () => {
    const { adapter } = createSqliteAdapter();
    const tokens = adapter('AccessToken');
    await tokens.upsert('tok1', { accountId: 'a@c.edu' });
    await tokens.upsert('tok1', { accountId: 'b@c.edu' });
    const found = await tokens.find('tok1');
    assert.ok(found);
    assert.equal(found.accountId, 'b@c.edu');
  });

  it('revokes every entry recorded under a grant id', async () => {
    const { adapter } = createSqliteAdapter();
    const tokens = adapter('AccessToken');
    await tokens.upsert('tok1', { grantId: 'g1' });
    await tokens.upsert('tok2', { grantId: 'g1' });
    await tokens.upsert('tok3', { grantId: 'g2' });
    await tokens.revokeByGrantId('g1');
    assert.equal(await tokens.find('tok1'), undefined);
    assert.equal(await tokens.find('tok2'), undefined);
    assert.ok(await tokens.find('tok3'));
  });

  it('destroys an entry and clears its uid lookup', async () => {
    const { adapter } = createSqliteAdapter();
    const sessions = adapter('Session');
    await sessions.upsert('sid1', { uid: 'uid1' });
    await sessions.destroy('sid1');
    assert.equal(await sessions.find('sid1'), undefined);
    assert.equal(await sessions.findByUid('uid1'), undefined);
  });

  it('records consumption as epoch seconds in the payload', async () => {
    const { adapter } = createSqliteAdapter();
    const codes = adapter('AuthorizationCode');
    await codes.upsert('code1', { grantId: 'g1' });
    await codes.consume('code1');
    const found = await codes.find('code1');
    assert.ok(found);
    assert.equal(typeof found.consumed, 'number');
  });

  it('sweep removes expired entries', async () => {
    const { adapter, sweep } = createSqliteAdapter();
    const sessions = adapter('Session');
    await sessions.upsert('sid1', { uid: 'uid1' }, 1);
    await sessions.upsert('sid2', { uid: 'uid2' }, 0);
    sweep();
    assert.ok(await sessions.find('sid1'));
    assert.equal(await sessions.find('sid2'), undefined);
  });
});

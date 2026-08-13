import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OtcService, isAllowedEmail } from '../src/otc.js';

function makeService(
  overrides: Partial<{
    codeLength: number;
    codeTtlSeconds: number;
    maxCodeAttempts: number;
    lockoutMs: number;
  }> = {},
): OtcService {
  return new OtcService(
    {
      codeLength: overrides.codeLength ?? 6,
      codeTtlSeconds: overrides.codeTtlSeconds ?? 300,
      maxCodeAttempts: overrides.maxCodeAttempts ?? 5,
      lockoutMs: overrides.lockoutMs ?? 900_000,
    },
    'test-secret',
  );
}

describe('generateCode', () => {
  it('produces a numeric code of the configured length', () => {
    const otc = makeService();
    for (let i = 0; i < 50; i++) {
      const code = otc.generateCode();
      assert.match(code, /^\d{6}$/);
    }
  });

  it('honours a custom length', () => {
    const otc = makeService({ codeLength: 8 });
    for (let i = 0; i < 20; i++) assert.match(otc.generateCode(), /^\d{8}$/);
  });
});

describe('verifyCode', () => {
  it('accepts a freshly sent code and is single-use', () => {
    const otc = makeService();
    const code = otc.sendCode('student@college.edu');
    assert.deepEqual(otc.verifyCode('student@college.edu', code), { ok: true });
    assert.deepEqual(otc.verifyCode('student@college.edu', code), { ok: false, reason: 'invalid' });
  });

  it('rejects a wrong code', () => {
    const otc = makeService();
    otc.sendCode('student@college.edu');
    assert.deepEqual(otc.verifyCode('student@college.edu', '000000'), {
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects an expired code', () => {
    const otc = makeService({ codeTtlSeconds: 0 });
    const code = otc.sendCode('student@college.edu');
    assert.deepEqual(otc.verifyCode('student@college.edu', code), { ok: false, reason: 'expired' });
  });

  it('locks the email after too many attempts', () => {
    const otc = makeService({ maxCodeAttempts: 3 });
    otc.sendCode('student@college.edu');
    assert.deepEqual(otc.verifyCode('student@college.edu', '000000'), {
      ok: false,
      reason: 'invalid',
    });
    assert.deepEqual(otc.verifyCode('student@college.edu', '000000'), {
      ok: false,
      reason: 'invalid',
    });
    assert.equal(otc.isLocked('student@college.edu'), false);
    assert.deepEqual(otc.verifyCode('student@college.edu', '000000'), {
      ok: false,
      reason: 'invalid',
    });
    assert.equal(otc.isLocked('student@college.edu'), true);
    assert.deepEqual(otc.verifyCode('student@college.edu', '000000'), {
      ok: false,
      reason: 'locked',
    });
  });

  it('blocks sending a new code while locked', () => {
    const otc = makeService({ maxCodeAttempts: 2 });
    otc.sendCode('student@college.edu');
    otc.verifyCode('student@college.edu', '000000');
    otc.verifyCode('student@college.edu', '000000');
    assert.throws(() => otc.sendCode('student@college.edu'), /locked/);
  });

  it('sending a new code replaces the old one', () => {
    const otc = makeService();
    const first = otc.sendCode('student@college.edu');
    const second = otc.sendCode('student@college.edu');
    assert.deepEqual(otc.verifyCode('student@college.edu', first), {
      ok: false,
      reason: 'invalid',
    });
    assert.deepEqual(otc.verifyCode('student@college.edu', second), { ok: true });
  });
});

describe('isAllowedEmail', () => {
  const domains = ['college.edu'];

  it('accepts addresses in the allowed domain', () => {
    assert.equal(isAllowedEmail('student@college.edu', domains), true);
    assert.equal(isAllowedEmail('STUDENT@COLLEGE.EDU', domains), true);
  });

  it('rejects other domains and malformed addresses', () => {
    assert.equal(isAllowedEmail('student@gmail.com', domains), false);
    assert.equal(isAllowedEmail('not-an-email', domains), false);
    assert.equal(isAllowedEmail('@college.edu', domains), false);
    assert.equal(isAllowedEmail('', domains), false);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.js';
import { maskEmail, renderCodeForm, renderEmailForm, renderError } from '../src/views.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    port: 3000,
    issuerUrl: 'http://localhost:3000',
    cookieSecret: 'secret',
    dataDir: './data',
    allowedEmailDomains: ['college.edu'],
    serviceName: 'College SSO',
    fromAddress: 'no-reply@example.org',
    mailDriver: 'console',
    smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
    codeTtlSeconds: 300,
    codeLength: 6,
    maxCodeAttempts: 5,
    rateLimitSendPerEmail: 3,
    rateLimitSendWindowMs: 300_000,
    rateLimitSendPerIp: 10,
    rateLimitIpWindowMs: 300_000,
    lockoutMs: 900_000,
    sessionTtlSeconds: 604_800,
    accessTokenTtlSeconds: 3_600,
    idTokenTtlSeconds: 3_600,
    refreshTokenTtlSeconds: 1_209_600,
    authCodeTtlSeconds: 600,
    grantTtlSeconds: 2_592_000,
    interactionTtlSeconds: 600,
    clientsPath: './clients.json',
    auditLogDir: './data',
    auditRetentionDays: 30,
    ...overrides,
  };
}

describe('views', () => {
  it('escapes a malicious email hint in the email form', () => {
    const html = renderEmailForm(makeConfig(), 'uid', {
      emailHint: '<script>alert(1)</script>',
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('escapes a malicious email in the code form', () => {
    const html = renderCodeForm(makeConfig(), 'uid', '<img src=x onerror=alert(1)>');
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
    assert.ok(html.includes('&lt;img'));
  });

  it('escapes the error message in the error page', () => {
    const html = renderError(makeConfig(), 'Something went wrong', '<script>alert(1)</script>');
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('masks the email shown in the code form', () => {
    const html = renderCodeForm(makeConfig(), 'uid', 'student@college.edu');
    assert.ok(html.includes('<strong>s******@college.edu</strong>'));
    assert.ok(!html.includes('<strong>student@college.edu</strong>'));
  });
});

describe('maskEmail', () => {
  it('masks the local part, keeping the first character', () => {
    assert.equal(maskEmail('student@college.edu'), 's******@college.edu');
  });

  it('clamps the star count to one for a single-character local part', () => {
    assert.equal(maskEmail('a@college.edu'), 'a*@college.edu');
  });

  it('clamps the star count to six for a long local part', () => {
    assert.equal(maskEmail('verylonglocalpart@college.edu'), 'v******@college.edu');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeCodeEmail, type MailerConfig } from '../src/mailer.js';

function makeMailerConfig(overrides: Partial<MailerConfig> = {}): MailerConfig {
  return {
    mailDriver: 'console',
    smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
    fromAddress: 'no-reply@example.org',
    serviceName: 'College SSO',
    codeTtlSeconds: 300,
    ...overrides,
  };
}

describe('composeCodeEmail', () => {
  it('includes the code and service name', () => {
    const { subject, text } = composeCodeEmail(makeMailerConfig(), '123456');
    assert.ok(subject.includes('College SSO'));
    assert.ok(text.includes('123456'));
  });

  it('states the expiry in whole minutes', () => {
    const { text } = composeCodeEmail(makeMailerConfig(), '123456');
    assert.ok(text.includes('5 minutes'));
  });

  it('never says the code expires in zero minutes', () => {
    const { text } = composeCodeEmail(makeMailerConfig({ codeTtlSeconds: 30 }), '123456');
    assert.ok(text.includes('1 minutes'));
  });
});

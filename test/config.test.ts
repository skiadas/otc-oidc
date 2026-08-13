import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const CONFIG_KEYS = [
  'NODE_ENV',
  'PORT',
  'ISSUER_URL',
  'COOKIE_SECRET',
  'ALLOWED_EMAIL_DOMAINS',
  'DATA_DIR',
  'SERVICE_NAME',
  'FROM_ADDRESS',
  'MAIL_DRIVER',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'CODE_TTL_SECONDS',
  'CODE_LENGTH',
  'MAX_CODE_ATTEMPTS',
  'RATE_LIMIT_SEND_PER_EMAIL',
  'RATE_LIMIT_SEND_WINDOW_MS',
  'RATE_LIMIT_SEND_PER_IP',
  'RATE_LIMIT_IP_WINDOW_MS',
  'LOCKOUT_MS',
  'SESSION_TTL_SECONDS',
  'ACCESS_TOKEN_TTL_SECONDS',
  'ID_TOKEN_TTL_SECONDS',
  'REFRESH_TOKEN_TTL_SECONDS',
  'AUTH_CODE_TTL_SECONDS',
  'GRANT_TTL_SECONDS',
  'INTERACTION_TTL_SECONDS',
  'CLIENTS_PATH',
  'AUDIT_LOG_DIR',
  'AUDIT_RETENTION_DAYS',
];

beforeEach(() => {
  for (const key of CONFIG_KEYS) delete process.env[key];
});

describe('loadConfig', () => {
  it('returns development defaults', () => {
    process.env.NODE_ENV = 'development';
    const config = loadConfig();
    assert.equal(config.nodeEnv, 'development');
    assert.equal(config.port, 3000);
    assert.equal(config.codeLength, 6);
    assert.deepEqual(config.allowedEmailDomains, ['college.edu']);
    assert.equal(config.cookieSecret, 'dev-cookie-secret');
  });

  it('loads a valid production configuration', () => {
    process.env.NODE_ENV = 'production';
    process.env.ISSUER_URL = 'https://sso.example.org';
    process.env.COOKIE_SECRET = 'secret';
    process.env.MAIL_DRIVER = 'smtp';
    process.env.SMTP_USER = 'ses-user';
    process.env.SMTP_PASS = 'ses-pass';
    process.env.CLIENTS_PATH = './clients.example.json';
    const config = loadConfig();
    assert.equal(config.nodeEnv, 'production');
    assert.equal(config.issuerUrl, 'https://sso.example.org');
  });

  it('rejects production without a cookie secret', () => {
    process.env.NODE_ENV = 'production';
    assert.throws(() => loadConfig(), /COOKIE_SECRET/);
  });

  it('rejects production with a plain-http issuer', () => {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECRET = 'secret';
    process.env.ISSUER_URL = 'http://sso.example.org';
    assert.throws(() => loadConfig(), /ISSUER_URL must be an https URL/);
  });

  it('rejects production with the console mail driver', () => {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECRET = 'secret';
    process.env.ISSUER_URL = 'https://sso.example.org';
    process.env.MAIL_DRIVER = 'console';
    assert.throws(() => loadConfig(), /MAIL_DRIVER=console is not allowed/);
  });

  it('rejects an unknown NODE_ENV value', () => {
    process.env.NODE_ENV = 'staging';
    assert.throws(() => loadConfig(), /NODE_ENV/);
  });

  it('rejects a code length out of range', () => {
    process.env.CODE_LENGTH = '40';
    assert.throws(() => loadConfig(), /CODE_LENGTH.*between 4 and 10/);
  });

  it('rejects a port out of range', () => {
    process.env.PORT = '70000';
    assert.throws(() => loadConfig(), /PORT/);
  });
});

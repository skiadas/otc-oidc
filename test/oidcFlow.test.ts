/**
 * End-to-end OIDC flow tests.
 *
 * Boots the real app wiring (provider + interaction router) on an ephemeral
 * port and drives the full login: authorize -> send code -> verify -> token
 * exchange. Only the mailer is stubbed (it captures the generated code instead
 * of sending it); everything else — OtcService, AccountStore, rate limiters,
 * audit, adapter, provider — is the real implementation.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { AccountStore } from '../src/accounts.js';
import { createSqliteAdapter } from '../src/adapter.js';
import { AuditLogger } from '../src/audit.js';
import type { Config } from '../src/config.js';
import { Mailer } from '../src/mailer.js';
import { OtcService } from '../src/otc.js';
import { createProvider } from '../src/oidc.js';
import { RateLimiter } from '../src/rateLimit.js';
import { interactionRouter } from '../src/routes/interaction.js';

const ISSUER = 'https://sso.test';
const REDIRECT_URI = 'https://app.test/oidc/callback';
const EMAIL = 'skiadas@hanover.edu';

const dir = mkdtempSync(join(tmpdir(), 'otc-flow-'));
const clientsPath = join(dir, 'clients.json');
const dataDir = join(dir, 'data');
const auditLogDir = join(dir, 'audit');

writeFileSync(
  clientsPath,
  JSON.stringify({
    clients: [
      {
        client_id: 'mathplacement',
        client_secret: 'secret',
        name: 'Math Placement',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'openid email profile',
      },
    ],
  }),
);

const config: Config = {
  nodeEnv: 'test',
  port: 0,
  issuerUrl: ISSUER,
  cookieSecret: 'test-cookie-secret',
  dataDir,
  allowedEmailDomains: ['hanover.edu'],
  serviceName: 'Test SSO',
  fromAddress: 'no-reply@example.org',
  mailDriver: 'console',
  smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
  codeTtlSeconds: 300,
  codeLength: 6,
  maxCodeAttempts: 5,
  rateLimitSendPerEmail: 100,
  rateLimitSendWindowMs: 60_000,
  rateLimitSendPerIp: 100,
  rateLimitIpWindowMs: 60_000,
  lockoutMs: 60_000,
  sessionTtlSeconds: 3600,
  accessTokenTtlSeconds: 3600,
  idTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 3600,
  authCodeTtlSeconds: 600,
  grantTtlSeconds: 3600,
  interactionTtlSeconds: 600,
  clientsPath,
  auditLogDir,
  auditRetentionDays: 30,
};

interface FlowServer {
  server: Server;
  base: string;
  serverCode: () => string;
}

async function buildApp(): Promise<FlowServer> {
  const memory = createSqliteAdapter();
  const accounts = new AccountStore();
  const audit = new AuditLogger(config.auditLogDir, config.auditRetentionDays);
  const otc = new OtcService(config, config.cookieSecret);
  const sendLimiterByEmail = new RateLimiter(
    config.rateLimitSendWindowMs,
    config.rateLimitSendPerEmail,
  );
  const sendLimiterByIp = new RateLimiter(config.rateLimitIpWindowMs, config.rateLimitSendPerIp);
  let lastCode = '';

  // Only the mailer is stubbed: capture the code instead of sending it.
  const mailer = new Mailer(config);
  const realSend = mailer.sendCode.bind(mailer);
  mailer.sendCode = async (_to: string, code: string) => {
    lastCode = code;
    await realSend(_to, code);
  };

  const provider = await createProvider(config, memory, accounts);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    '/interaction',
    interactionRouter({
      provider,
      config,
      otc,
      mailer,
      audit,
      accounts,
      sendLimiterByEmail,
      sendLimiterByIp,
    }),
  );
  app.use(provider.callback());

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    serverCode: () => lastCode,
  };
}

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function decodeIdToken(idToken: string): Record<string, unknown> {
  const [, payload = ''] = idToken.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

function request(
  base: string,
  path: string,
  opts: { method?: string; form?: Record<string, string>; cookie?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { method = 'GET', form, cookie } = opts;
  const headers: Record<string, string> = {};
  if (cookie) headers['cookie'] = cookie;
  let body = '';
  if (form) {
    body = new URLSearchParams(form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out }),
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieJar(headers: Record<string, string | string[] | undefined>): string {
  const set = headers['set-cookie'];
  if (!set) return '';
  const list = Array.isArray(set) ? set : [set];
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function startLogin(base: string, cookie: string) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = s256(verifier);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'mathplacement',
    redirect_uri: REDIRECT_URI,
    scope: 'openid email profile',
    state: 'st',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const res = await request(base, `/auth?${params}`, { cookie });
  return { status: res.status, location: res.headers.location as string, verifier, cookie: cookieJar(res.headers) };
}

async function exchangeCode(base: string, code: string, verifier: string) {
  const res = await request(base, '/token', {
    method: 'POST',
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: 'mathplacement',
      client_secret: 'secret',
      code_verifier: verifier,
    },
  });
  return { status: res.status, body: res.body };
}

/**
 * Follow a 3xx redirect chain (up to `hops` redirects) inside the provider,
 * collecting cookies along the way. Stops when the target leaves the provider
 * (i.e. the client redirect_uri) and returns the final location plus cookie.
 */
async function follow(
  base: string,
  start: string,
  cookie: string,
  hops = 6,
): Promise<{ cookie: string; finalLocation?: string }> {
  if (/^https?:\/\//.test(start) && !start.startsWith(base)) {
    return { cookie, finalLocation: start };
  }
  let current = start.startsWith('/') ? start : start.replace(base, '');
  let jar = cookie;
  for (let i = 0; i < hops; i++) {
    const res = await request(base, current, { cookie: jar });
    jar = cookieJar(res.headers) || jar;
    const location = res.headers.location as string | undefined;
    if (!location) {
      return { cookie: jar, finalLocation: current };
    }
    if (location.startsWith(base)) {
      current = location.slice(base.length);
    } else if (location.startsWith('/')) {
      current = location;
    } else {
      return { cookie: jar, finalLocation: location };
    }
  }
  return { cookie: jar, finalLocation: current };
}

describe('OIDC flow', () => {
  it('issues an ID token with the email claim', async () => {
    const { server, base, serverCode } = await buildApp();
    try {
      const login = await startLogin(base, '');
      assert.equal(login.status, 303);
      assert.ok(login.location.includes('/interaction/'), `expected interaction redirect, got ${login.location}`);
      const uid = login.location.split('/').pop() ?? '';
      const cookie = login.cookie;

      let res = await request(base, `/interaction/${uid}`, { cookie });
      assert.equal(res.status, 200);
      assert.match(res.body, /College email/);

      res = await request(base, `/interaction/${uid}`, {
        method: 'POST',
        form: { action: 'send-code', email: EMAIL },
        cookie,
      });
      assert.equal(res.status, 200);

      const code = serverCode();
      assert.ok(code.length > 0, 'mailer stub should have captured a code');

      res = await request(base, `/interaction/${uid}`, {
        method: 'POST',
        form: { action: 'verify', email: EMAIL, code },
        cookie,
      });
      assert.equal(res.status, 303);
      const verifyCookie = cookieJar(res.headers) || cookie;

      // Follow the resume redirect chain to the client callback; the final
      // location carries the authorization code.
      const done = await follow(base, res.headers.location as string, verifyCookie);
      assert.ok(done.finalLocation?.startsWith(REDIRECT_URI), `expected client callback, got ${done.finalLocation}`);
      const authCode = new URL(done.finalLocation!).searchParams.get('code');
      assert.ok(authCode, 'authorization code should be present in the final redirect');

      const token = await exchangeCode(base, authCode!, login.verifier);
      assert.equal(token.status, 200, `token exchange failed: ${token.body}`);
      const parsed = JSON.parse(token.body);
      const idClaims = decodeIdToken(parsed.id_token);
      assert.equal(idClaims.email, EMAIL);
      assert.equal(idClaims.email_verified, true);
      assert.equal(idClaims.preferred_username, EMAIL);
      assert.match(parsed.scope ?? '', /email/);
    } finally {
      server.close();
    }
  });

  it('silent SSO skips the code prompt', async () => {
    const { server, base, serverCode } = await buildApp();
    try {
      // First login establishes a session.
      const login = await startLogin(base, '');
      const uid = login.location.split('/').pop() ?? '';
      let cookie = login.cookie;
      const getRes = await request(base, `/interaction/${uid}`, { cookie });
      cookie = cookieJar(getRes.headers) || cookie;
      const sendRes = await request(base, `/interaction/${uid}`, {
        method: 'POST',
        form: { action: 'send-code', email: EMAIL },
        cookie,
      });
      cookie = cookieJar(sendRes.headers) || cookie;
      const verifyRes = await request(base, `/interaction/${uid}`, {
        method: 'POST',
        form: { action: 'verify', email: EMAIL, code: serverCode() },
        cookie,
      });
      assert.equal(verifyRes.status, 303);
      const first = await follow(base, verifyRes.headers.location as string, cookieJar(verifyRes.headers) || cookie);
      assert.ok(
        new URL(first.finalLocation!).searchParams.get('code'),
        `first login should yield an auth code, got ${first.finalLocation}`,
      );
      cookie = first.cookie;

      // Second authorize with the established session completes silently:
      // the provider redirects straight to the client callback without
      // routing through the interaction (no code prompt).
      const second = await startLogin(base, cookie);
      assert.equal(second.status, 303);
      const secondDone = await follow(base, second.location, second.cookie);
      assert.ok(secondDone.finalLocation?.startsWith(REDIRECT_URI), `expected silent SSO to reach the client, got ${secondDone.finalLocation}`);
      const code = new URL(secondDone.finalLocation!).searchParams.get('code');
      assert.ok(code, 'silent SSO should still yield an authorization code');

      const token = await exchangeCode(base, code!, second.verifier);
      assert.equal(token.status, 200, `token exchange failed: ${token.body}`);
    } finally {
      server.close();
    }
  });
});

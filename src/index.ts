/**
 * Process bootstrap.
 *
 * Wires the in-memory stores, mailer, audit logger, and oidc-provider together
 * and mounts them on an Express app. `provider.callback()` is mounted last
 * because the provider answers its own routes (discovery, auth, token, ...)
 * and 404s anything it doesn't recognise. A background interval sweeps expired
 * in-memory entries and prunes old audit files.
 */
import express from 'express';
import helmet from 'helmet';
import { createSqliteAdapter } from './adapter.js';
import { loadConfig, type Config } from './config.js';
import { OtcService } from './otc.js';
import { RateLimiter } from './rateLimit.js';
import { AuditLogger } from './audit.js';
import { Mailer } from './mailer.js';
import { AccountStore } from './accounts.js';
import { createProvider, loadClients, type ClientConfig } from './oidc.js';
import { interactionRouter } from './routes/interaction.js';
import { html, raw, renderInfoPage } from './views.js';

function renderDevHarness(config: Config, clients: ClientConfig[]): string {
  const rows = clients.map((c) => html`<li><code>${c.client_id}</code></li>`).join('');
  return html`
    <html>
      <body style="font-family:system-ui;max-width:640px;margin:40px auto">
        <h1>otc-oidc (development)</h1>
        <p>Issuer: <code>${config.issuerUrl}</code></p>
        <p>
          Run <code>npm run dev:client</code> in another terminal to exercise the full OIDC flow
          (PKCE + code exchange + SSO).
        </p>
        <p>Registered clients:</p>
        <ul>
          ${raw(rows)}
        </ul>
        <p>
          Discovery:
          <a href="/.well-known/openid-configuration">/.well-known/openid-configuration</a>
        </p>
        <p>This page is only served when <code>NODE_ENV=development</code>.</p>
      </body>
    </html>
  `;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const memory = createSqliteAdapter();
  const accounts = new AccountStore();
  const audit = new AuditLogger(config.auditLogDir, config.auditRetentionDays);
  const mailer = new Mailer(config);
  // The cookie secret doubles as the code-hashing HMAC key: one secret for the
  // whole process, since rotating it invalidates sessions and codes together.
  const otc = new OtcService(config, config.cookieSecret);
  const sendLimiterByEmail = new RateLimiter(
    config.rateLimitSendWindowMs,
    config.rateLimitSendPerEmail,
  );
  const sendLimiterByIp = new RateLimiter(config.rateLimitIpWindowMs, config.rateLimitSendPerIp);

  const provider = await createProvider(config, memory, accounts);

  provider.on('server_error', (_ctx, err) => {
    process.stderr.write(
      `provider server_error: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
  });

  const app = express();
  app.disable('x-powered-by');
  // One trusted reverse-proxy hop (Caddy). Trusting all proxies would let a
  // client spoof X-Forwarded-For and bypass the IP-based rate limiter.
  app.set('trust proxy', 1);
  // form-action is dropped: the only cross-origin navigation after a form is
  // the post-login redirect to a registered client's redirect_uri, which
  // oidc-provider already allowlists. Keeping 'self' there blocks that redirect.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          formAction: null,
        },
      },
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', issuer: config.issuerUrl });
  });

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

  if (config.nodeEnv === 'development') {
    app.get('/', (_req, res) => {
      const clients = loadClients(config.clientsPath);
      res.set('Content-Type', 'text/html').send(renderDevHarness(config, clients));
    });
  } else {
    app.get('/', (_req, res) => {
      res.set('Content-Type', 'text/html').send(renderInfoPage(config));
    });
  }

  app.use(provider.callback());

  const sweeper = setInterval(() => {
    [memory, otc, sendLimiterByEmail, sendLimiterByIp, audit].forEach((s) => s.sweep());
  }, 60_000);
  sweeper.unref();

  app.listen(config.port, () => {
    process.stdout.write(`otc-oidc listening on ${config.issuerUrl}\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

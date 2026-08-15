/**
 * oidc-provider wiring.
 *
 * Clients are loaded from a per-instance config file (`clients.json`, not in
 * git); adding a tool means adding an entry and restarting, though new clients
 * are also picked up without a restart by the reconciler (see
 * {@link createClientReconciler}) — it upserts previously-unknown client ids
 * into the adapter, which oidc-provider serves on the next lookup. PKCE is
 * required for every client. The built-in dev interactions are disabled so our
 * `/interaction/:uid` routes (see `routes/interaction.ts`) handle login, and
 * `interactions.url` returns that path because the interaction cookie is scoped
 * to it. The RS256 signing key is persisted to `$DATA_DIR/jwks.json` so tokens
 * stay verifiable across restarts.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import Provider from 'oidc-provider';
import type { ProviderConfiguration } from 'oidc-provider';
import type { Config } from './config.js';
import type { AccountStore } from './accounts.js';
import type { AdapterBundle } from './adapter.js';
import { html } from './views.js';

export interface ClientConfig {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  post_logout_redirect_uris?: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
  [key: string]: unknown;
}

const KEY_FILE_MODE = 0o600;

export function loadClients(path: string): ClientConfig[] {
  if (!existsSync(path)) return [];

  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw as { clients?: unknown }).clients;
  if (!Array.isArray(list)) {
    throw new Error('clients file must contain an array or { clients: [...] }');
  }

  return list as ClientConfig[];
}

/**
 * Periodic reconciler that picks up newly-added clients from `clients.json`
 * without a restart. oidc-provider only re-reads a client from the adapter when
 * the id is absent from its static client map (see `Client.find`), so unknown
 * ids written here are served on the next request. Edits to existing clients
 * are intentionally ignored — changing those still requires a restart, since
 * the static map is authoritative for ids it already knows.
 *
 * The file is re-read only when its mtime changes; a malformed file is logged
 * and skipped, keeping the last known-good state.
 */
export function createClientReconciler(
  config: Config,
  adapterBundle: AdapterBundle,
): { sweep: () => void } {
  let lastMtimeMs = 0;
  const known = new Set(loadClients(config.clientsPath).map((c) => c.client_id));

  return {
    sweep: () => {
      if (!existsSync(config.clientsPath)) return;

      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(config.clientsPath);
      } catch {
        return;
      }
      if (stat.mtimeMs === lastMtimeMs) return;

      let clients: ClientConfig[];
      try {
        clients = loadClients(config.clientsPath);
      } catch (err) {
        process.stderr.write(
          `client reconcile: ignoring unreadable clients file: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return;
      }

      const adapter = adapterBundle.adapter('Client');
      for (const client of clients) {
        if (known.has(client.client_id)) continue;

        known.add(client.client_id);
        adapter.upsert(client.client_id, client);
        process.stderr.write(`client reconcile: added client ${client.client_id}\n`);
      }

      lastMtimeMs = stat.mtimeMs;
    },
  };
}

/**
 * Load or generate the RS256 signing key. Persisted (mode 0600) so access
 * tokens issued before a restart remain verifiable afterwards.
 */
export async function loadOrCreateJwks(dataDir: string): Promise<{ keys: unknown[] }> {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'jwks.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as { keys: unknown[] };

  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.kid = randomBytes(8).toString('hex');
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  const set = { keys: [jwk] };
  writeFileSync(file, JSON.stringify(set, null, 2), { mode: KEY_FILE_MODE });
  return set;
}

/**
 * Branded error page shown by oidc-provider when it has to respond with a
 * failure (e.g. an invalid authorization request). Kept minimal and consistent
 * with the login pages' styling.
 */
function renderProviderErrorPage(config: Config, out: unknown): string {
  const description = String(
    (out as { error_description?: string }).error_description ??
      (out as { error?: string }).error ??
      'Something went wrong. Please try again.',
  );
  return html`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${config.serviceName}</title>
        <style>
          body {
            font-family: system-ui, sans-serif;
            background: #f4f5f7;
            color: #1c2733;
            display: flex;
            min-height: 100vh;
            align-items: center;
            justify-content: center;
            margin: 0;
          }
          .card {
            background: #fff;
            border: 1px solid #d7dce2;
            border-radius: 8px;
            padding: 24px;
            max-width: 420px;
            margin: 16px;
          }
          h1 {
            font-size: 1.15rem;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Something went wrong</h1>
          <p>${description}</p>
        </div>
      </body>
    </html>
  `;
}

function buildProviderConfig(
  config: Config,
  accounts: AccountStore,
  clients: ClientConfig[],
  jwks: { keys: unknown[] },
  adapterBundle: AdapterBundle,
): ProviderConfiguration {
  const {
    cookieSecret,
    accessTokenTtlSeconds,
    authCodeTtlSeconds,
    idTokenTtlSeconds,
    refreshTokenTtlSeconds,
    grantTtlSeconds,
    interactionTtlSeconds,
    sessionTtlSeconds,
  } = config;

  return {
    adapter: adapterBundle.adapter,
    clients,
    jwks,
    scopes: ['openid', 'offline_access', 'profile', 'email'],
    claims: {
      acr: null,
      sid: null,
      auth_time: null,
      iss: null,
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name', 'preferred_username'],
    },
    // Default true collapses the ID token's scope to just `openid` whenever
    // the userinfo endpoint is enabled and the access token has no audience —
    // which is our code flow. We want granted claims (email, etc.) in the
    // ID token itself, so disable that compatibility behavior.
    conformIdTokenClaims: false,
    cookies: {
      keys: [cookieSecret],
    },
    pkce: {
      required: () => true,
    },
    features: {
      devInteractions: { enabled: false },
    },
    renderError: (ctx, out) => {
      const koaCtx = ctx as { type: string; body: string };
      koaCtx.type = 'html';
      koaCtx.body = renderProviderErrorPage(config, out);
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    findAccount: (_ctx, sub) => accounts.findAccount(_ctx, sub),
    ttl: {
      AccessToken: accessTokenTtlSeconds,
      AuthorizationCode: authCodeTtlSeconds,
      IdToken: idTokenTtlSeconds,
      RefreshToken: refreshTokenTtlSeconds,
      Grant: grantTtlSeconds,
      Interaction: interactionTtlSeconds,
      Session: sessionTtlSeconds,
    },
  };
}

export async function createProvider(
  config: Config,
  adapterBundle: AdapterBundle,
  accounts: AccountStore,
): Promise<Provider> {
  const clients = loadClients(config.clientsPath);
  const jwks = await loadOrCreateJwks(config.dataDir);
  const provider = new Provider(
    config.issuerUrl,
    buildProviderConfig(config, accounts, clients, jwks, adapterBundle),
  );
  // Caddy terminates TLS in front, so Koa sees plain http and would render
  // http:// discovery endpoints. Trust the forwarded scheme/host instead.
  provider.proxy = true;
  return provider;
}

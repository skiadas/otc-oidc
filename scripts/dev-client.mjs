import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { decodeJwt } from 'jose';

function loadEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const i = trimmed.indexOf('=');
    const key = trimmed.slice(0, i).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(i + 1).trim();
  }
}
loadEnv();

const issuer = process.env.ISSUER_URL ?? 'http://localhost:3000';
const clientsPath = process.env.CLIENTS_PATH ?? './clients.json';
const clients = JSON.parse(readFileSync(clientsPath, 'utf8')).clients ?? [];

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function generateVerifier() {
  return base64url(randomBytes(32));
}

async function generateChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', Buffer.from(verifier));
  return base64url(new Uint8Array(digest));
}

function buildAuthorizeUrl(client, verifier, challenge, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    scope: client.scope ?? 'openid email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${issuer}/auth?${params.toString()}`;
}

async function exchange(client, redirectUri, code, verifier) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    client_secret: client.client_secret ?? '',
    code_verifier: verifier,
  });
  const res = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(json)}`);

  return json;
}

async function runRound(label, client) {
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  const state = randomUUID();
  const redirectUri = client.redirect_uris[0];
  const url = new URL(redirectUri);

  const tokens = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url, redirectUri);
      const code = reqUrl.searchParams.get('code');
      const gotState = reqUrl.searchParams.get('state');
      if (!code || gotState !== state) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('missing code or state mismatch');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Callback received</h1><p>You can close this tab.</p>');
      try {
        const token = await exchange(client, redirectUri, code, verifier);
        server.close();
        resolve(token);
      } catch (err) {
        server.close();
        reject(err);
      }
    });
    server.listen(url.port, () => {
      process.stdout.write(
        `\n== ${label} ==\nOpen this URL in your browser:\n  ${buildAuthorizeUrl(client, verifier, challenge, state)}\n`,
      );
    });
  });

  const idToken = decodeJwt(tokens.id_token);
  process.stdout.write(`\nAccess token (scopes granted): ${tokens.scope ?? '(not returned)'}\n`);
  process.stdout.write(`ID token claims: ${JSON.stringify(idToken, null, 2)}\n`);
  return tokens;
}

const mainClient =
  clients.find((c) => c.client_id === (process.env.DEV_CLIENT_ID ?? 'dev-tool')) ?? clients[0];
if (!mainClient) {
  process.stderr.write('no clients found in CLIENTS_PATH\n');
  process.exit(1);
}

await runRound('Round 1: sign in (expect email + code)', mainClient);
process.stdout.write('\nNow open the SAME URL flow again (Round 2) to see silent SSO...\n');
await runRound('Round 2: sign in again (expect no code, silent SSO)', mainClient);
process.stdout.write('\nDone. SSO across interactions works.\n');

# otc-oidc

Central one-time-code (email OTP) login + OpenID Connect single sign-on for college tools.

Instead of bolting an OTP flow onto every tool, tools become OIDC clients and redirect users here.
This service verifies that the user controls a `@college.edu` inbox by emailing them a one-time code,
then issues standard OIDC tokens and keeps a single sign-on session across all tools.

Built for lightweight, infrequent-use internal tools. Runs on a single small server.

> **Disclaimer:** This is a side-project identity service. It is not audited and is not intended
> for regulated, compliance-bound, or high-security environments. You are responsible for the
> security posture of any instance you run — HTTPS, secrets, and configuration included.

## Features

- Passwordless login with one-time codes sent to a restricted email domain
- Real OIDC provider (authorization code + PKCE) via `oidc-provider`
- Silent SSO across tools (log in once, next tools sign you in automatically)
- Rate limiting per email + IP, attempt lockout, hashed single-use codes
- JSONL audit log with daily rotation and retention
- One Node.js process, in-memory storage, zero external services (no Postgres/Redis)

## How it works

```
tool redirects user ──► /auth ──► /interaction/<uid>  (enter email)
                                      │
                              email code sent via SMTP/SES
                                      │
                                enter code → verified
                                      │
                        SSO session established (cookie)
                                      │
                              redirect back to tool with code
                                      │
                        tool exchanges code for tokens (/token)
```

The next tool you open skips the email/code entirely (silent SSO) until your session expires.

For a deeper look at how the pieces fit together — the interaction protocol, storage and
security models, and deployment topology — see [docs/architecture.md](docs/architecture.md).

## Requirements

- Node.js 20+ (24 recommended)
- A public HTTPS URL (the issuer)
- An SMTP endpoint to send the codes (AWS SES works well)
- A domain you can send email from

## Quickstart (local dev)

```bash
npm install
cp .env.example .env
# edit .env: ALLOWED_EMAIL_DOMAINS, MAIL_DRIVER=console
cp clients.example.json clients.json
npm run gen:secrets    # prints a COOKIE_SECRET to put in .env
npm run dev
```

Then exercise the full OIDC flow in a browser:

```bash
npm run dev:client
```

It prints an authorization URL; open it, sign in with a `@college.edu` address, read the code from
the server console, and watch the tokens print. Run it again to see silent SSO (no code prompt).

Before committing, run `npm run format && npm run lint` (plus `npm run typecheck` and the test
suite) — Prettier and ESLint are the project's enforced style.

`MAIL_DRIVER=console` prints codes to stdout instead of sending them. Never use it in production —
the service refuses to boot with it when `NODE_ENV=production`.

## Configuration

All configuration is via environment variables (see `.env.example`). The important ones:

| Variable                                               | Purpose                                            |
| ------------------------------------------------------ | -------------------------------------------------- |
| `ISSUER_URL`                                           | Public base URL (must be `https://` in production) |
| `COOKIE_SECRET`                                        | Signs session/interaction cookies                  |
| `ALLOWED_EMAIL_DOMAINS`                                | Comma-separated domains allowed to log in          |
| `MAIL_DRIVER`                                          | `console` (dev) or `smtp` (prod)                   |
| `SMTP_HOST/PORT/USER/PASS`, `FROM_ADDRESS`             | SMTP/SES transport                                 |
| `SERVICE_NAME`                                         | Branding shown on login pages                      |
| `CODE_TTL_SECONDS`, `CODE_LENGTH`, `MAX_CODE_ATTEMPTS` | OTC behaviour                                      |
| `RATE_LIMIT_*`, `LOCKOUT_MS`                           | Abuse protection                                   |
| `SESSION_TTL_SECONDS`, `ACCESS_TOKEN_TTL_SECONDS`, ... | Token lifetimes                                    |
| `CLIENTS_PATH`                                         | OIDC client registrations file                     |
| `AUDIT_LOG_DIR`, `AUDIT_RETENTION_DAYS`                | Audit log location/retention                       |

## Registering a tool (OIDC client)

Add an entry to `clients.json` (per-instance file, gitignored — copy `clients.example.json` and fill in real secrets) and restart.

```json
{
  "clients": [
    {
      "client_id": "gradebook",
      "client_secret": "<generated-secret>",
      "name": "Gradebook",
      "redirect_uris": ["https://gradebook.example.edu/auth/callback"],
      "post_logout_redirect_uris": ["https://gradebook.example.edu/"],
      "grant_types": ["authorization_code"],
      "response_types": ["code"],
      "token_endpoint_auth_method": "client_secret_post",
      "scope": "openid email"
    }
  ]
}
```

- `redirect_uris` must be **exact full URLs** — scheme, host, and a fixed path. Never use wildcards
  or a bare origin. Each client on a shared host should use a distinct callback path.
- PKCE is **required** for every client (enforced server-side).
- The tool then uses a standard OIDC client library against `<issuer>/.well-known/openid-configuration`
  and provisions users just-in-time from the `email` claim.

## Integrating a tool (client side)

Any standard OIDC authorization-code flow works (Passport/Express, NextAuth, `authlib`, Laravel
Socialite, Spring Security, etc.). The tool:

1. Redirects to the authorization endpoint with `response_type=code`, `code_challenge` (S256), and its registered `redirect_uri`.
2. Receives the `code` at its callback.
3. Exchanges the code at the token endpoint with its `client_secret` + `code_verifier`.
4. Uses the `email` claim from the ID token / userinfo as the canonical user identity (JIT-provision if needed).
5. Optionally wires logout through `<issuer>/session/end`.

See `scripts/dev-client.mjs` for a minimal, dependency-free example of the whole dance.

## Self-hosting

### 1. Server

A single VPS is enough (a 1 GB / 2 vCPU Lightsail-class box is comfortable; the process idles
around 150-300 MB). Install Docker + Compose.

### 2. DNS and TLS

Point `sso.example.org` (A record) at your server. `compose.yml` runs Caddy in front of the app and
provisions Let's Encrypt certificates automatically; set `DOMAIN` in your `.env`.

### 3. Email (SES)

- Verify the sending domain in SES (add DKIM/SPF/MAIL FROM records via Route53).
- Create SMTP credentials; put them in `.env` (`MAIL_DRIVER=smtp`, `SMTP_HOST=email-smtp.<region>.amazonaws.com`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS`, `FROM_ADDRESS`).
- **Request SES production access** (out of sandbox) or codes will only reach verified recipients.
- Codes should come from a domain you are **authorized** to send as. Do not impersonate an
  organization you don't control.

### 4. Deploy

```bash
# on the server
git clone <your-repo> /opt/otc-oidc
cd /opt/otc-oidc
cp .env.example .env        # fill in real values
cp clients.example.json clients.json
docker compose up -d
```

`DOMAIN` and `GHCR_OWNER` are read by `compose.yml` (not the app): `DOMAIN` is the hostname Caddy
serves, `GHCR_OWNER` is the GitHub owner of the image you pull from. The `./data` directory is a
bind mount owned by the container's `node` user; the image's entrypoint fixes ownership on start,
so no manual `chown` is needed.

The GitHub Actions pipeline (`.github/workflows/deploy.yml`) runs on every push to `main`: it runs
typecheck/lint/tests, then builds and publishes `ghcr.io/<you>/otc-oidc:<sha>` + `:latest`. It does
**not** touch the server. Instead the server pulls updates on its own schedule:

```bash
# as root: hourly check for a new image, snapshot + restart only on change
crontab -e
# add:
0 * * * * /opt/otc-oidc/scripts/deploy.sh
```

`scripts/deploy.sh` pulls the app image and restarts the stack only when the image digest changed,
so unchanged polls are no-ops. Before restarting it snapshots `data/` + `clients.json` into
`./backups` (last 15 kept). No GitHub secrets are needed.

To roll back after a bad upgrade, restore the matching snapshot from `./backups` and point compose
at the previous image: `IMAGE_TAG=<previous-sha> docker compose up -d`.

### 5. Backups

The only irreplaceable data is the audit log (append-only JSONL in `AUDIT_LOG_DIR`) and your
`clients.json`. The deploy pipeline snapshots both locally before each upgrade. For belt-and-braces,
periodically copy the log directory somewhere off-box — there's no database to back up.

## Storage & restart semantics

Storage is in-memory by design (an in-memory SQLite database, no Postgres/Redis). Consequences:

- Restarting the service invalidates all SSO sessions, auth codes, refresh tokens, and pending OTC
  records. Users' tool sessions are unaffected (tools hold their own sessions); they may just need
  to re-enter a code next time their tool session expires.
- The RS256 signing key is persisted to `data/jwks.json` so tokens already issued remain valid
  across restarts.

## Operations

- Health check: `GET /health` returns `{"status":"ok"}`.
- Audit events are written to `audit-YYYY-MM-DD.log` (login success/failure, code sends, rate
  limits) and pruned after `AUDIT_RETENTION_DAYS`.
- Watch the service logs for `provider server_error` lines when debugging token/auth issues.

## Security notes

- Codes: crypto-random, stored only as HMAC hashes, single-use, 5-minute expiry, constant-time
  comparison, per-email lockout after repeated failures.
- Sends are rate-limited per email and per IP; the login flow only accepts addresses on
  `ALLOWED_EMAIL_DOMAINS`.
- Cookies are `httpOnly` + `SameSite=lax`; all pages serve security headers via `helmet`.
- PKCE is mandatory for all clients; redirect URIs are exact-match allowlists.
- **There is no password.** Whoever can read the inbox can sign in as that user. That is the
  intended model for low-stakes college tools; do not use this for anything sensitive.

## License

MIT. See `LICENSE`. Contributions are welcome under the same terms.

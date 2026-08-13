# Architecture

How otc-oidc is put together: a single-process OpenID Connect provider whose login
flow is an email one-time-code instead of a password.

## Overview

- **One Node.js/TypeScript process.** No Postgres, Redis, or worker — all state lives in
  memory and is lost on restart.
- **The protocol comes from `oidc-provider`** (authorization code + PKCE, discovery, JWKS,
  tokens, logout). We only implement the _interaction_: proving ownership of a `@college.edu`
  inbox by emailing a one-time code.
- **Tools are standard OIDC clients.** Each tool registers a client (config file), redirects
  to the issuer, and provisions users just-in-time from the `email` claim.
- **A single sign-on session** is held by the provider, so visiting a second tool is silent.

## System context

```
+--------+  redirect   +-----------------------------------------------+
|  tool  | ----------> |               otc-oidc (the issuer)            |
| (OIDC  |             |                                               |
| client)| <---------- |  /auth  /interaction  /token  /jwks  /userinfo |
+--------+   code +    |          (email + code UI)   ^                 |
            tokens     +-----------------------------------------------+
                                                      |
                                                 SMTP/SES
                                                      |
                                                 user's inbox
```

The tool never sees a password or a code — it only ever holds tokens. The email and the code
stay on the issuer.

## Request flow

```
tool redirects to /auth?response_type=code&scope=openid email&code_challenge=S256&...
        |
        |  oidc-provider checks the session cookie + consent grant
        v
  no session or new client? ---------> redirect to /interaction/<uid>
        |                                    |
        | silent (session + consent         | GET: if a session already exists,
        | already present)                  |      finish immediately (SSO)
        |                                   | else render email form
        |                                   |
        |                                   | POST send-code
        |                                   |   1. email must match ALLOWED_EMAIL_DOMAINS
        |                                   |   2. rate limit per email + per IP
        |                                   |   3. not currently locked out
        |                                   |   4. generate code, store its HMAC, email it
        |                                   |
        |                                   | POST verify (code + email)
        |                                   |   constant-time compare, single-use, lockout
        |                                   v
        |                           interactionFinished({
        |                             login:   { accountId: email },
        |                             consent: { grantId },
        |                           })
        v
  resume: session established, authorization code issued
        |
        v
tool callback?code=...  -->  POST /token (code + client_secret + code_verifier)
        |
        v
  access token + id token (+ refresh token)  -->  GET /userinfo
```

## The interaction protocol (oidc-provider specifics)

These are the non-obvious contracts our interaction code must honour:

- **Redirect target.** `configuration.interactions.url` returns `/interaction/${uid}` and the
  interaction cookie is scoped to that path, so the routes in
  `src/routes/interaction.ts` must live there.
- **Interaction result shape.** `provider.interactionFinished(req, res, result)` takes
  `{ login: { accountId }, consent: { grantId } }`. The login key is **`accountId`**, not
  `account`.
- **The grant must carry the same account as the login.** `details.grantId` points at the
  _empty_ grant oidc-provider created during the authorization request — created before
  login, so it has no account. If we don't set `grant.accountId` to the verified email, the
  resume fails with `accountId mismatch`. See `grantConsent`.
- **Grant all requested scopes from `params.scope`.** The prompt's `details` only expose the
  _first_ failing check, so they're not a reliable list of what to grant. Granting everything
  requested is what removes consent screens and makes repeat visits fully silent.
- **Silent SSO.** In the interaction GET, if `details.session?.accountId` is set, the browser
  already proved inbox ownership — finish immediately with `{ consent }`, never send a code.
- **Auth codes are session-bound.** `expiresWithSession: true` means `AuthorizationCode.find`
  resolves the code's session via `Session.findByUid`. That lookup goes through the adapter's
  uid lookup (a SQL column/index); break it and every token exchange fails with `invalid_grant`.
- **Missing/expired interactions are typed.** The package exports a runtime `errors`
  namespace; a missing or expired interaction surfaces as `errors.SessionNotFound`, and
  `classifyInteractionError` routes those to the friendly "expired request" page via
  `instanceof` — not by string-matching the message.
- **Built-in dev interactions are disabled** (`features.devInteractions.enabled: false`),
  otherwise they'd override our `interactions.url`.
- **PKCE is required for every client** (`pkce.required: () => true`).

## Storage model

| Data                                 | Where                                     | Survives restart?                        |
| ------------------------------------ | ----------------------------------------- | ---------------------------------------- |
| Sessions, auth codes, grants, tokens | SQLite `:memory:` (`src/adapter.ts`)      | no — everyone re-logs in                 |
| OTC records (hashes)                 | in-memory (`src/otc.ts`)                  | no                                       |
| Rate-limit buckets                   | in-memory (`src/rateLimit.ts`)            | no                                       |
| User table (email, first/last login) | in-memory (`src/accounts.ts`)             | no — recreates on next login             |
| RS256 signing key                    | `data/jwks.json` (gitignored)             | **yes** — keeps issued tokens verifiable |
| Audit log                            | JSONL files in `AUDIT_LOG_DIR`            | yes                                      |
| OIDC client registrations            | `clients.json` (per-instance, gitignored) | yes                                      |

Restart consequences, by design: SSO sessions and refresh tokens die, so a restart is a
mass-logout at the issuer; users' tool sessions survive (tools hold their own), so the visible
impact is an extra code entry next time a tool session expires.

## Security model

- **Restricted domain.** Only addresses matching `ALLOWED_EMAIL_DOMAINS` can request a code.
  This is the primary abuse control: login requires access to a college inbox.
- **Codes.** Crypto-random; stored only as HMAC-SHA256 hashes; compared with
  `timingSafeEqual`; single-use (verify consumes the record); short TTL; a new send replaces
  the old.
- **Lockout.** `MAX_CODE_ATTEMPTS` wrong guesses lock the email for `LOCKOUT_MS` and block new
  sends.
- **Rate limiting.** Sliding-window per-email and per-IP limits on code sends
  (`RATE_LIMIT_SEND_*`). Buckets are window-bounded: keys self-expire on `sweep`, so memory
  cannot grow monotonically even under a flood of distinct keys.
- **OIDC hardening.** PKCE mandatory; redirect URIs are exact-match allowlists (https, fixed
  paths); same for `post_logout_redirect_uris`.
- **Transport.** HTTPS-only issuer; cookies are `httpOnly` + `SameSite=lax`; `helmet` security
  headers on every response; `Cache-Control: no-store` on the interaction routes.
- **No password exists.** The trust model is "whoever can read the inbox is the user." That is
  the intended scope — low-stakes internal college tools, not sensitive systems.

## Component map

| File                           | Role                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| `src/index.ts`                 | Bootstrap; mounts routes + `provider.callback()` last; sweeper interval   |
| `src/config.ts`                | Env parsing + validation via `envalid`; fails fast in production          |
| `src/oidc.ts`                  | `oidc-provider` setup; client loading; JWKS persistence                   |
| `src/routes/interaction.ts`    | The OTC login flow + silent-SSO finish + consent                          |
| `src/otc.ts`                   | Code generation, hashing, verification, lockout                           |
| `src/rateLimit.ts`             | Sliding-window limiter (keys self-expire, so it is bounded by the window) |
| `src/adapter.ts`               | SQLite (`:memory:`) adapter for oidc-provider                             |
| `src/accounts.ts`              | JIT user records + `findAccount`                                          |
| `src/mailer.ts`                | Console (dev) / SMTP (SES) code delivery                                  |
| `src/audit.ts`                 | Append-only JSONL logs, daily rotation, retention                         |
| `src/views.ts`                 | Server-rendered login pages via the `html`/`raw` tagged templates         |
| `src/types/oidc-provider.d.ts` | Minimal type declarations for `oidc-provider`                             |

## Deployment topology

- `compose.yml` runs the app behind **Caddy**, which terminates TLS and provisions Let's
  Encrypt certificates for `{$DOMAIN}`. Only 80/443 are exposed.
- Codes go out over **SMTP/SES** (`MAIL_DRIVER=smtp`); `console` is dev-only and refused in
  production.
- Upgrades run through the **GHCR pipeline** (`.github/workflows/deploy.yml`): build on `main`
  → push `ghcr.io/<you>/otc-oidc:<sha>` + `:latest` → SSH → `scripts/deploy.sh` takes a
  pre-upgrade snapshot of `data/` + `clients.json`, then pulls and restarts.
- Backups are local by design: the audit logs are the only irreplaceable data (client config
  lives in git-adjacent config; user records self-heal), and the deploy script snapshots them
  before every upgrade.

## Extension points

- **Add a tool:** add a client entry to `clients.json` and restart. PKCE + exact redirect URI
  required.
- **Allow a new domain:** add it to `ALLOWED_EMAIL_DOMAINS`.
- **Tune behaviour:** code length/TTL, attempt limits, rate limits, session/token lifetimes —
  all env-driven (see `.env.example`).

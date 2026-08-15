# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

A central one-time-code (email OTP) + OpenID Connect single-sign-on service for college tools.
One Node/TypeScript process. In-memory storage. JSONL audit logs. OIDC protocol provided by
`oidc-provider`; the OTC email login flow is our own interaction implementation.

## Commands

- `npm run dev` — run with `tsx watch` (`--env-file-if-exists=.env` loads the env; no dotenv dependency)
- `npm run build` — `tsc -p tsconfig.build.json` → `dist/`
- `npm start` — run the compiled build
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — node:test via `tsx` (`test/**/*.test.ts`)
- `npm run lint` / `npm run lint:fix` — ESLint (with `curly: multi-line`)
- `npm run format` / `npm run format:check` — Prettier
- `npm run gen:secrets` — prints a `COOKIE_SECRET`
- `npm run dev:client` — browser-driven OIDC client for manual testing (PKCE, token exchange, silent SSO)

## Project structure

- `src/index.ts` — express bootstrap, health endpoint, dev harness, sweeper interval
- `src/config.ts` — env parsing + validation via `envalid`; fails fast on missing/invalid values
- `src/oidc.ts` — `oidc-provider` setup (config built by `buildProviderConfig`), JWKS persistence, client loading
- `src/routes/interaction.ts` — the OTC login flow (GET renders form / silent-SSO finish, POST send-code / verify)
- `src/otc.ts` — code generation, HMAC hashing, constant-time verify, lockout
- `src/rateLimit.ts` — sliding-window per-key limiter
- `src/audit.ts` — append-only JSONL logs, per-day files, retention sweep
- `src/adapter.ts` — SQLite (`:memory:`) adapter for oidc-provider; one generic table with `uid`/`user_code`/`grant_id` columns
- `src/accounts.ts` — user records (JIT by email), `findAccount` for oidc-provider
- `src/duration.ts` — small derived-duration helpers (e.g. seconds → whole minutes)
- `src/mailer.ts` — console (dev) or SMTP/SES transport
- `src/views.ts` — server-rendered login pages via the `html`/`raw` tagged templates
- `src/types/oidc-provider.d.ts` — minimal type declaration for oidc-provider (it ships no types)
- `docs/` — `architecture.md` (system design) and `reviewing.md` (review rubric)
- `scripts/dev-client.mjs` — manual test OIDC client; `scripts/deploy.sh` — server-side deploy; `scripts/gen-secrets.ts`
- `test/` — node:test suites; `test/oidcFlow.test.ts` boots the real app on an ephemeral port and drives the full HTTP OIDC flow (authorize → interaction send-code/verify → resume redirect → token exchange), stubbing only the mailer. It is the canonical way to test provider behavior.

## Conventions

- TypeScript strict. ESM only (`"type": "module"`). Relative imports **must use `.js` extensions** (NodeNext).
- **Format with Prettier, lint with ESLint before committing** (`npm run format && npm run lint`). Style rules live in `.prettierrc.json` and `eslint.config.js`; single-statement `if` bodies are brace-less only when they fit on one line (`curly: multi-line`).
- Prefer **destructuring** repeated `obj.field` access at the point of use (see `docs/REVIEWING.md`).
- **`typescript` is pinned to ^6** (the JS-based compiler): typescript-eslint needs the TypeScript compiler API, which the native TS 7 package does not expose. Bump back to 7 once typescript-eslint supports it.
- **Comments are allowed only where they capture non-obvious behavior or security intent** (see the module headers in `src/oidc.ts`, `src/adapter.ts`, `src/otc.ts`, `src/routes/interaction.ts`, `src/index.ts`). Never add a comment that restates what the code already says; self-evident functions stay bare. No `console.log`/debug scaffolding — remove it before committing.
- No secrets in the repo. Everything configurable via env (`.env.example` documents all variables).
- Clients are configured in `clients.json` (per-instance, gitignored; `clients.example.json` is tracked and documents the format). Adding a client = add entry; new client ids are picked up without restart by the reconciler (`createClientReconciler` in `src/oidc.ts`). Editing an existing client's entry requires **`docker compose restart app`** — `up -d` won't recreate a container for a content-only change to a mounted file, and the reconciler ignores edits to already-known ids. (Forgetting this shows up as `invalid_client` at the token endpoint.)
- Config values are read in `src/config.ts` only; pass the typed `Config` around.

## Debugging

- **Prefer establishing written tests over running ad-hoc scripts.** When investigating oidc-provider behavior, write the reproduction as a real test in `test/` (boot the app on an ephemeral port exactly as `oidcFlow.test.ts` does) rather than throwaway `.mjs`/inline scripts. Standalone scripts can't resolve `oidc-provider`/`dist` the same way, get discarded, and leave no regression coverage. If you're about to write a *second* ad-hoc script, stop and convert it to a test.
- The installed `oidc-provider` is partly minified, so reading its source is unreliable. Diagnose via runtime state (adapter rows, actual HTTP responses) and real tests instead.

## oidc-provider v9 specifics (verified against installed version)

- `Provider` extends Koa; mount with `app.use(provider.callback())` LAST (it 404s unmatched paths).
- Interaction result shape is `{ login: { accountId, ... }, consent: { grantId } }` — the key is **`accountId`**, not `account`.
- When finishing an interaction after a fresh login, the **Grant must carry the same `accountId`** as the login. The interaction's `details.grantId` may point at an empty grant created during the auth request, so always set `grant.accountId`.
- To grant consent without a consent screen, add **all** requested scopes from `details.params.scope` to the grant (the prompt details only list the first failing check, so don't rely on them).
- Silent SSO: in the interaction GET, if `details.session?.accountId` is set, finish immediately with `{ consent }` (no login).
- Auth codes are **session-bound** (`expiresWithSession: true`): `AuthorizationCode.find` calls `Session.findByUid`, so the adapter's uid lookup must work or every token exchange fails with `invalid_grant`.
- The package exports a runtime `errors` namespace (`import { errors } from 'oidc-provider'`); `errors.SessionNotFound` is thrown for any missing/expired interaction, and `errors.OIDCProviderError` is the base class. Use `instanceof` against these (see `classifyInteractionError`).
- `findAccount(ctx, sub)` must return an account object with `accountId` and an async `claims()`.
- Dev-only `devInteractions` must be disabled (`features.devInteractions.enabled: false`) or it overrides our `interactions.url`.
- **`conformIdTokenClaims` defaults to `true`** (verified): with the userinfo endpoint enabled and an access token that has no audience (our code flow), it collapses the ID token's scope to just `openid`, so only `sub` is emitted. We set `conformIdTokenClaims: false` so granted claims (`email`, `email_verified`, `preferred_username`) appear in the ID token. Symptom to recognize: the token response `scope` says `openid email profile` but the decoded ID token has only `sub`.
- The `claims` config maps **scope → claim names** (`{ email: ['email', 'email_verified'] }`); array values are auto-unpacked, and discovery `claims_supported` is derived from scopes × claims.

## In-memory semantics (accepted tradeoffs)

- A restart invalidates all sessions, auth codes, refresh tokens, and OTC records. Users' tool sessions survive (tools hold their own sessions). Expect occasional re-logins after restarts.
- Provider state lives in an in-memory SQLite database (`:memory:`); switching to a file is a one-line change in `src/adapter.ts`.
- The RS256 signing key is persisted to `$DATA_DIR/jwks.json` (gitignored) so access tokens stay verifiable across restarts.
- Audit logs are append-only JSONL in `$AUDIT_LOG_DIR` (default `./data`), rotated per day, pruned after `AUDIT_RETENTION_DAYS`.
- Rate-limit counters, OTC records, user table, and provider state are all in memory. Nothing else to back up except logs + client config.

## Deploy

- `compose.yml` runs `app` (this image) + `caddy` (TLS via `{$DOMAIN}`).
- GHCR pipeline: `.github/workflows/deploy.yml` builds `ghcr.io/<repo>:<sha>` + `:latest`, SSHes to the server, runs `scripts/deploy.sh <sha>` (pre-upgrade snapshot → pull → up).
- The server's hourly cron runs `deploy.sh`, which restarts the app **only when the image digest changed**. After editing `clients.json` or any other mounted config (which doesn't change the digest), run `docker compose restart app` manually to apply it.
- See README for the full self-host guide.

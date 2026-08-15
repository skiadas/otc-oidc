# Known issues & deferred items

Anything deferred from a change or investigation lands here so it is not lost to memory or commit
messages. Revisit these when the context that created them changes. See AGENTS.md → Working
agreements for the policy that drives this file.

## GHCR token scope (local `gh`)

- **Status:** deferred — no action needed until you want `gh` to inspect GHCR package metadata.
- The local `gh` token (`skiadas`) has only `repo`/`workflow` scopes, so
  `gh api /user/packages/...` fails with a `read:packages` permission error. The image is public,
  so pulls and deploys are unaffected. If you later want `gh` to list package versions or check
  visibility, add `read:packages` to the token scope.

## SSO `clients.json` `mathplacement` entry cleanup

- **Status:** deferred — harmless to leave, but both are dead/loose config.
- `post_logout_redirect_uris` is never used: math placement does plain `session.clear()` and skips
  RP-initiated logout, so nothing ever redirects to it.
- `http://localhost:5002/oidc/callback` (the local dev redirect) is in the registered
  `redirect_uris`. Useful for local testing; keep it until local testing is no longer needed.
- Removing either requires an SSO restart (`docker compose restart app`) — the reconciler only
  picks up new client ids, not edits.

## SSO sender identity

- **Status:** deferred until a dedicated sending domain is chosen.
- `FROM_ADDRESS` currently reuses the verified `mathplacement.harisskiadas.com` subdomain (via
  `no-reply@mathplacement.harisskiadas.com`). It works; revisit if a dedicated domain is preferred.
  Note verifying the apex `harisskiadas.com` in SES would cover all subdomains with one identity.

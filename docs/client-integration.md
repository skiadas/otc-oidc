# Integrating a client (OIDC tool)

This is the guide for **tool developers** wiring a new application into this SSO. The SSO is an
OpenID Connect provider at `https://sso.harisskiadas.com`; tools become OIDC clients and redirect
users here for sign-in. This document applies to any tool, in any language — a concrete Python
(authlib) example is included at the end.

If you are the **SSO operator** adding a client, see the "Registering a tool" section in the
README instead.

## 1. Get a client registered

The operator adds an entry to the SSO instance's `clients.json`:

```json
{
  "client_id": "gradebook",
  "client_secret": "<generated-secret>",
  "name": "Gradebook",
  "redirect_uris": ["https://gradebook.example.edu/auth/callback"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "client_secret_post",
  "scope": "openid email"
}
```

You need three things from this:

- **`client_id`** and **`client_secret`** — your credentials at the token endpoint.
- **Your `redirect_uri`** — must be an exact full URL, and it must match the registered one
  byte-for-byte. No wildcards, no bare origins.
- **The issuer** — `https://sso.harisskiadas.com`.

The secret is a shared secret: the SSO validates it at the token endpoint, so your configured
value must match the registered value exactly (no surrounding quotes, no trailing whitespace).
If the operator later changes it in `clients.json`, the SSO must be restarted for the change to
take effect.

## 2. The flow

Standard OIDC authorization-code flow with **PKCE (S256)**:

1. **Authorize** — redirect the browser to the authorization endpoint:
   - `response_type=code`
   - `client_id`
   - `redirect_uri` (registered)
   - `scope` (must include `openid`)
   - `state` (CSRF)
   - `code_challenge` + `code_challenge_method=S256`
2. **Callback** — the browser returns to your `redirect_uri` with `?code=...&state=...`.
   Verify `state`, then exchange the code.
3. **Token exchange** — POST to the token endpoint with `grant_type=authorization_code`,
   the `code`, your `redirect_uri`, `client_id`, `client_secret`, and `code_verifier`.
4. **Identity** — read the `email` claim from the **ID token** (or call the userinfo endpoint).
   Provision the user just-in-time from `email` if you don't have them yet.

Discovery is at `/.well-known/openid-configuration`; the signing keys are at the `jwks_uri` it
advertises. Use a real OIDC client library and let it validate the ID token
(`iss`, `aud`, `exp`, and `nonce`). Do not hand-roll signature verification.

## 3. Identity model

- `sub` **is the user's email address** (e.g. `jsmith@hanover.edu`).
- The `email` claim is your canonical identity key. Treat it as unique per account.
- **The SSO is identity-only.** It does not carry roles or permissions — your application
  decides what a signed-in user may do.
- **Silent SSO is free.** Once a user has an SSO session cookie, later authorize requests
  complete without a sign-in prompt, as long as your client's requested scope is within the
  registered `scope`.

## 4. Logout (optional)

If you want sign-out to also end the SSO session, use RP-initiated logout:

```
GET <issuer>/session/end?post_logout_redirect_uri=<registered>&id_token_hint=<id_token>
```

Your `post_logout_redirect_uri` must be registered. If you only clear your own session cookie,
the user will silently re-authenticate next time they return.

## 5. Gotchas (learned the hard way)

- **PKCE must be enabled explicitly.** `code_challenge_method: 'S256'` must be set in your
  client library's configuration. Most libraries do **not** auto-enable it from the discovery
  document, and this SSO requires it for every request. If it's missing, the token exchange
  fails with `invalid_request: Authorization Server policy requires PKCE`.
- **Auth method is `client_secret_post`.** Configure `token_endpoint_auth_method:
  client_secret_post` so the secret is sent in the token-request body, matching the client
  registration.
- **Catch the library's real error type.** With authlib, token failures raise
  `authlib.integrations.base_client.errors.OAuthError`, **not** `OAuth2Error`. Catching the
  wrong type turns every failure into a generic error page and hides the actual reason.
- **The secret must match exactly** on both sides. A mismatch shows up as
  `invalid_client: client authentication failed` at the token endpoint.

## 6. Python (authlib) example

Registration (in your Flask app factory, reading env vars):

```python
from authlib.integrations.flask_client import OAuth

oauth = OAuth()

def init_oidc(app):
    oauth.init_app(app)
    issuer = os.getenv('OIDC_ISSUER')
    client_id = os.getenv('OIDC_CLIENT_ID')
    client_secret = os.getenv('OIDC_CLIENT_SECRET')
    if not (issuer and client_id and client_secret):
        return  # degrade to "sign-in not configured"
    oauth.register(
        'myapp',
        server_metadata_url=f'{issuer}/.well-known/openid-configuration',
        client_id=client_id,
        client_secret=client_secret,
        client_kwargs={
            'scope': 'openid email profile',
            'token_endpoint_auth_method': 'client_secret_post',
            'code_challenge_method': 'S256',
        },
    )
```

Login and callback:

```python
from authlib.integrations.base_client.errors import OAuthError

@app.get('/oidc/login')
def oidc_login():
    if 'user_id' in session:
        return redirect(url_for('index'))
    client = oauth.create_client('myapp')
    return client.authorize_redirect(os.getenv('OIDC_REDIRECT_URI'))

@app.get('/oidc/callback')
def oidc_callback():
    client = oauth.create_client('myapp')
    try:
        token = client.authorize_access_token()
    except OAuthError as err:
        return render_template('login.html', error=f'Sign-in failed: {err.description or err.error}')
    userinfo = token.get('userinfo') or {}
    email = (userinfo.get('email') or '').strip().lower()
    # ... validate the domain, find-or-create your user by email, set your session ...
    return redirect(url_for('index'))
```

The ID token is validated automatically by authlib (signature, `iss`, `aud`, `exp`, `nonce`);
`token['userinfo']` is the validated ID-token claims, including `email`.

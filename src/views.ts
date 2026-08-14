import type { Config } from './config.js';
import { minutesFromSeconds } from './duration.js';

type RawString = { __html: string };

function isRawString(value: unknown): value is RawString {
  return typeof value === 'object' && value !== null && '__html' in value;
}

/**
 * Marks a string as pre-rendered HTML so the `html` template does not escape
 * it. Only use for output we generated ourselves or already escaped.
 */
export function raw(value: string): RawString {
  return { __html: value };
}

/**
 * HTML tagged template that escapes every interpolated value, so page content
 * and user input never reach the DOM unescaped. Nest pre-rendered markup via
 * {@link raw}.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i] ?? '';
    if (i < values.length) {
      const value = values[i] as unknown;
      out += isRawString(value) ? value.__html : escapeHtml(String(value));
    }
  }
  return out;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Mask the local part of an email for display, keeping the first character and
 * up to six asterisks so short addresses still hide most of their local part.
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;

  const visible = local.slice(0, 1);
  const stars = Math.min(Math.max(local.length - 1, 1), 6);
  return `${visible}${'*'.repeat(stars)}@${domain}`;
}

function errorBanner(message: string): RawString {
  return raw(`<div class="err">${escapeHtml(message)}</div>`);
}

function layout(config: Config, title: string, body: string): string {
  const { auditRetentionDays, serviceName } = config;
  const privacy = raw(
    `This service collects your ${escapeHtml(serviceName)} email address and login activity for authentication and security purposes. Audit logs are retained for ${auditRetentionDays} days.`,
  );
  return html`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          * {
            box-sizing: border-box;
          }
          body {
            font-family:
              system-ui,
              -apple-system,
              sans-serif;
            background: #f4f5f7;
            margin: 0;
            color: #1c2733;
          }
          .wrap {
            max-width: 420px;
            margin: 8vh auto;
            padding: 0 16px;
          }
          .card {
            background: #fff;
            border: 1px solid #d7dce2;
            border-radius: 8px;
            padding: 24px;
          }
          h1 {
            font-size: 1.15rem;
            margin: 0 0 16px;
          }
          label {
            display: block;
            font-size: 0.9rem;
            margin: 12px 0 4px;
          }
          input {
            width: 100%;
            padding: 10px 12px;
            border: 1px solid #b9c1cb;
            border-radius: 6px;
            font-size: 1rem;
          }
          input:focus {
            outline: 2px solid #2f6fed;
            border-color: #2f6fed;
          }
          button {
            width: 100%;
            margin-top: 16px;
            padding: 10px 12px;
            background: #2f6fed;
            color: #fff;
            border: 0;
            border-radius: 6px;
            font-size: 1rem;
            cursor: pointer;
          }
          button:hover {
            background: #2459c2;
          }
          .alt {
            text-align: center;
            font-size: 0.85rem;
            margin-top: 12px;
          }
          .alt a {
            color: #2f6fed;
          }
          .err {
            background: #fdecea;
            color: #8c1d18;
            border: 1px solid #f5c6c2;
            border-radius: 6px;
            padding: 10px 12px;
            margin-bottom: 12px;
            font-size: 0.9rem;
          }
          .note {
            font-size: 0.8rem;
            color: #5a6a7a;
            margin-top: 20px;
            line-height: 1.5;
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="card">${raw(body)}</div>
          <div class="note">${privacy}</div>
        </div>
      </body>
    </html>
  `;
}

export function renderEmailForm(
  config: Config,
  interactionUid: string,
  opts: { error?: string; emailHint?: string } = {},
): string {
  const action = '/interaction/' + encodeURIComponent(interactionUid);
  const body = html`
    <h1>Sign in to ${config.serviceName}</h1>
    ${opts.error ? errorBanner(opts.error) : raw('')}
    <form method="post" action="${action}">
      <input type="hidden" name="action" value="send-code" />
      <label for="email">College email</label>
      <input
        type="email"
        id="email"
        name="email"
        autocomplete="email"
        autofocus
        required
        value="${opts.emailHint ?? ''}"
      />
      <button type="submit">Send code</button>
    </form>
  `;
  return layout(config, `Sign in — ${config.serviceName}`, body);
}

export function renderCodeForm(
  config: Config,
  interactionUid: string,
  email: string,
  opts: { error?: string; locked?: boolean } = {},
): string {
  const action = '/interaction/' + encodeURIComponent(interactionUid);
  // While locked we show the full address so the user knows which inbox is
  // blocked; otherwise the masked form is enough to confirm the destination.
  const masked = opts.locked ? email : maskEmail(email);
  const body = html`
    <h1>Enter your code</h1>
    ${opts.error ? errorBanner(opts.error) : raw('')}
    <p style="font-size:0.9rem">
      We sent a code to <strong>${masked}</strong>. It expires in
      ${minutesFromSeconds(config.codeTtlSeconds)} minutes.
    </p>
    <form method="post" action="${action}">
      <input type="hidden" name="action" value="verify" />
      <input type="hidden" name="email" value="${email}" />
      <label for="code">One-time code</label>
      <input
        type="text"
        id="code"
        name="code"
        inputmode="numeric"
        pattern="[0-9]*"
        maxlength="${config.codeLength}"
        autocomplete="one-time-code"
        autofocus
        required
      />
      <button type="submit">Verify code</button>
    </form>
    <form method="post" action="${action}">
      <input type="hidden" name="action" value="send-code" />
      <input type="hidden" name="email" value="${email}" />
      <div class="alt">
        <button
          type="submit"
          style="margin-top:0;padding:0;background:none;color:#2f6fed;width:auto"
        >
          Resend code
        </button>
      </div>
    </form>
    <div class="alt"><a href="${action}">Use a different email</a></div>
  `;
  return layout(config, 'Enter code — ' + config.serviceName, body);
}

export function renderError(config: Config, title: string, message: string): string {
  return layout(
    config,
    title,
    html`<h1>${title}</h1>
      ${errorBanner(message)}`,
  );
}

/**
 * Minimal landing page served at `/` in production, so a bare visit to the
 * issuer host shows something human-readable instead of a 404. No user data.
 */
export function renderInfoPage(config: Config): string {
  const discovery = '/.well-known/openid-configuration';
  const body = html`
    <h1>${config.serviceName}</h1>
    <p>
      This is the sign-in provider for ${config.serviceName}. Tools redirect
      here to log you in; there is nothing to browse at this address.
    </p>
    <p>
      <a href="${discovery}">OpenID Connect discovery document</a>
    </p>
  `;
  return layout(config, config.serviceName, body);
}

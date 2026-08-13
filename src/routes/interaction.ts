/**
 * The OTC login interaction for oidc-provider.
 *
 * When an authorization request needs the end-user, oidc-provider redirects to
 * `/interaction/:uid`. A GET completes silently (SSO) if the browser already
 * has a session; otherwise it drives email -> code -> verify, then finishes
 * the interaction, which redirects back to the client with an authorization
 * code. Codes are sent and verified through {@link OtcService} with the
 * allowed-domain and rate-limit checks enforced here.
 */
import { Router } from 'express';
import express from 'express';
import type { Request, Response } from 'express';
import { errors } from 'oidc-provider';
import type Provider from 'oidc-provider';
import type { Grant, InteractionDetails } from 'oidc-provider';
import type { Config } from '../config.js';
import type { OtcService } from '../otc.js';
import { isAllowedEmail, type VerifyFailureReason } from '../otc.js';
import type { Mailer } from '../mailer.js';
import type { AuditLogger } from '../audit.js';
import type { AccountStore } from '../accounts.js';
import type { RateLimiter } from '../rateLimit.js';
import { minutesFromSeconds } from '../duration.js';
import { renderCodeForm, renderEmailForm, renderError } from '../views.js';

export interface InteractionContext {
  provider: Provider;
  config: Config;
  otc: OtcService;
  mailer: Mailer;
  audit: AuditLogger;
  accounts: AccountStore;
  sendLimiterByEmail: RateLimiter;
  sendLimiterByIp: RateLimiter;
}

const LOCKED_MESSAGE = 'Too many failed attempts. Please wait a few minutes and try again.';

const VERIFY_FAILURE_MESSAGES: Record<VerifyFailureReason, string> = {
  locked: LOCKED_MESSAGE,
  expired: 'That code has expired. Request a new one.',
  invalid: 'That code is not correct. Please check and try again.',
};

function parseEmail(req: Request): string {
  return (req.body?.email ?? '').trim().toLowerCase();
}

/**
 * Find the grant for this interaction, or create it, ensuring it belongs to
 * the given account. The interaction's `details.grantId` points at the empty
 * grant oidc-provider created during the authorization request — before login,
 * so it has no account — meaning `grant.accountId` must be set to the logged-in
 * account or the resume fails with `accountId mismatch`.
 */
async function findExistingGrant(
  provider: Provider,
  details: InteractionDetails,
): Promise<Grant | undefined> {
  const { grantId } = details;
  return grantId ? provider.Grant.find(grantId) : undefined;
}

function createGrant(provider: Provider, details: InteractionDetails, accountId: string): Grant {
  const { client_id } = details.params;
  return new provider.Grant({ accountId, clientId: client_id });
}

async function ensureGrant(
  provider: Provider,
  details: InteractionDetails,
  accountId: string,
): Promise<Grant> {
  const grant =
    (await findExistingGrant(provider, details)) ?? createGrant(provider, details, accountId);
  grant.accountId = accountId;
  return grant;
}

/**
 * Record every requested scope and claim on the grant. The prompt details only
 * surface the first failing check, so `params.scope` is the reliable source;
 * granting everything requested is what makes consent screens unnecessary and
 * later visits fully silent.
 */
function grantRequestedScopes(grant: Grant, details: InteractionDetails): void {
  const { params, prompt } = details;
  const scope = params.scope?.trim();
  const requestedScopes = scope ? scope.split(/\s+/) : [];
  if (requestedScopes.length > 0) grant.addOIDCScope(requestedScopes.join(' '));

  const promptDetails = prompt?.details ?? {};
  if (promptDetails.missingOIDCClaims && promptDetails.missingOIDCClaims.length > 0) {
    grant.addOIDCClaims(promptDetails.missingOIDCClaims);
  }

  if (promptDetails.missingResourceScopes) {
    for (const [indicator, scopes] of Object.entries(promptDetails.missingResourceScopes)) {
      grant.addResourceScope(indicator, scopes.join(' '));
    }
  }
}

async function grantConsent(
  provider: Provider,
  details: InteractionDetails,
  accountId: string,
): Promise<string> {
  const grant = await ensureGrant(provider, details, accountId);
  grantRequestedScopes(grant, details);
  return grant.save();
}

// Each `reject*` guard below checks one precondition for sending a code and, if
// it fails, responds with the rejection and returns true. Rejections re-render
// the current form (HTTP 200) so the error shows inline; the per-IP limit is
// the one hard 429 stop.

function rejectInvalidEmailDomain(
  res: Response,
  ctx: InteractionContext,
  details: InteractionDetails,
  email: string,
): boolean {
  const { config } = ctx;
  if (isAllowedEmail(email, config.allowedEmailDomains)) return false;

  res.status(200).send(
    renderEmailForm(config, details.uid, {
      error: `Only addresses ending in ${config.allowedEmailDomains.join(', ')} can sign in.`,
      emailHint: email,
    }),
  );
  return true;
}

function rejectEmailRateLimited(
  res: Response,
  ctx: InteractionContext,
  details: InteractionDetails,
  email: string,
  ip: string,
): boolean {
  const { audit, config, sendLimiterByEmail } = ctx;
  if (sendLimiterByEmail.check(email)) return false;

  audit.log({ event: 'code_send_rate_limited', email, ip });
  const minutes = minutesFromSeconds(sendLimiterByEmail.windowMs / 1000);
  res.status(200).send(
    renderEmailForm(config, details.uid, {
      error: `Too many codes requested for this address. Please wait about ${minutes} minutes and try again.`,
      emailHint: email,
    }),
  );
  return true;
}

function rejectIpRateLimited(
  res: Response,
  ctx: InteractionContext,
  email: string,
  ip: string,
): boolean {
  const { audit, config, sendLimiterByIp } = ctx;
  if (sendLimiterByIp.check(`ip:${ip}`)) return false;

  audit.log({ event: 'code_send_rate_limited', email, ip });
  const minutes = minutesFromSeconds(sendLimiterByIp.windowMs / 1000);
  res
    .status(429)
    .send(
      renderError(
        config,
        'Slow down',
        `Too many requests from this network. Please wait about ${minutes} minutes and try again.`,
      ),
    );
  return true;
}

function rejectLockedOut(
  res: Response,
  ctx: InteractionContext,
  details: InteractionDetails,
  email: string,
): boolean {
  const { config, otc } = ctx;
  if (!otc.isLocked(email)) return false;

  res.status(200).send(
    renderCodeForm(config, details.uid, email, {
      error: LOCKED_MESSAGE,
      locked: true,
    }),
  );
  return true;
}

function handleSendFailure(
  res: Response,
  ctx: InteractionContext,
  email: string,
  ip: string,
  err: unknown,
): void {
  const { audit, config } = ctx;
  audit.log({ event: 'code_send_failed', email, ip, detail: errorDetail(err) });
  res
    .status(500)
    .send(
      renderError(
        config,
        'Something went wrong',
        'We could not send the code. Please try again in a moment.',
      ),
    );
}

async function handleSendCode(
  ctx: InteractionContext,
  req: Request,
  res: Response,
  details: InteractionDetails,
): Promise<void> {
  const email = parseEmail(req);
  const ip = req.ip ?? 'unknown';

  if (rejectInvalidEmailDomain(res, ctx, details, email)) return;
  if (rejectEmailRateLimited(res, ctx, details, email, ip)) return;
  if (rejectIpRateLimited(res, ctx, email, ip)) return;
  if (rejectLockedOut(res, ctx, details, email)) return;

  const { audit, config, mailer, otc } = ctx;
  try {
    const code = otc.sendCode(email);
    await mailer.sendCode(email, code);
  } catch (err) {
    handleSendFailure(res, ctx, email, ip, err);
    return;
  }

  audit.log({ event: 'code_sent', email, ip, clientId: details.params.client_id });
  res.status(200).send(renderCodeForm(config, details.uid, email));
}

function rejectUnallowedEmail(
  res: Response,
  ctx: InteractionContext,
  details: InteractionDetails,
  email: string,
): boolean {
  const { config } = ctx;
  if (isAllowedEmail(email, config.allowedEmailDomains)) return false;

  res.status(200).send(
    renderCodeForm(config, details.uid, email, {
      error: 'This email address is not allowed to sign in.',
    }),
  );
  return true;
}

function rejectFailedVerify(
  res: Response,
  ctx: InteractionContext,
  details: InteractionDetails,
  email: string,
  ip: string,
  code: string,
): boolean {
  const { audit, config, otc } = ctx;
  const result = otc.verifyCode(email, code);
  if (result.ok) return false;

  audit.log({ event: 'code_verify_failure', email, ip, detail: result.reason });
  res.status(200).send(
    renderCodeForm(config, details.uid, email, {
      error: VERIFY_FAILURE_MESSAGES[result.reason],
      locked: result.reason === 'locked',
    }),
  );
  return true;
}

/**
 * Verify the submitted code and, on success, log the user in and finish the
 * interaction. The account id in the login result and the grant must both be
 * the verified email, and the interaction result key is `accountId` (not
 * `account`) in this oidc-provider version.
 */
async function handleVerifyCode(
  ctx: InteractionContext,
  req: Request,
  res: Response,
  details: InteractionDetails,
): Promise<void> {
  const email = parseEmail(req);
  const code = (req.body?.code ?? '').trim();
  const ip = req.ip ?? 'unknown';

  if (rejectUnallowedEmail(res, ctx, details, email)) return;
  if (rejectFailedVerify(res, ctx, details, email, ip, code)) return;

  const { accounts, audit, provider } = ctx;
  accounts.touch(email);
  audit.log({ event: 'login_success', email, ip, clientId: details.params.client_id });

  const grantId = await grantConsent(provider, details, email);
  await provider.interactionFinished(req, res, {
    login: { accountId: email, amr: ['otp'], remember: true },
    consent: { grantId },
  });
}

export interface InteractionErrorPage {
  status: number;
  title: string;
  message: string;
}

const EXPIRED_REQUEST_PAGE: InteractionErrorPage = {
  status: 400,
  title: 'Expired request',
  message: 'This sign-in request has expired. Please start again from the tool you were using.',
};

const SERVER_ERROR_PAGE: InteractionErrorPage = {
  status: 500,
  title: 'Something went wrong',
  message: 'An unexpected error occurred. Please try again.',
};

/**
 * The human-readable reason for an oidc-provider error. Its `message` is always
 * the short error code (e.g. `invalid_request`); the useful detail is carried
 * in `error_description` when present.
 */
function errorDetail(err: unknown): string {
  if (err instanceof errors.OIDCProviderError) return err.error_description ?? err.error;

  return err instanceof Error ? err.message : String(err);
}

/**
 * Decide how to present an interaction failure. A missing or expired
 * interaction is reported as `SessionNotFound`; that type is what routes these
 * to the friendly "expired request" page instead of a 500.
 */
export function classifyInteractionError(err: unknown): InteractionErrorPage {
  if (err instanceof errors.SessionNotFound) return EXPIRED_REQUEST_PAGE;

  return SERVER_ERROR_PAGE;
}

function handleInteractionError(config: Config, _req: unknown, res: Response, err: unknown): void {
  const page = classifyInteractionError(err);
  if (page.status === 500) {
    process.stderr.write(`interaction error: ${errorDetail(err)}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  }
  res.status(page.status).send(renderError(config, page.title, page.message));
}

async function handleInteractionGet(
  ctx: InteractionContext,
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const details = await ctx.provider.interactionDetails(req, res);
    // Silent SSO: an existing session means the user already proved ownership
    // of their inbox — record consent and finish immediately instead of asking
    // for a code again.
    if (details.session?.accountId) {
      const grantId = await grantConsent(ctx.provider, details, details.session.accountId);
      await ctx.provider.interactionFinished(req, res, { consent: { grantId } });
      return;
    }
    res.status(200).send(renderEmailForm(ctx.config, details.uid));
  } catch (err) {
    handleInteractionError(ctx.config, req, res, err);
  }
}

async function handleInteractionSubmit(
  ctx: InteractionContext,
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const details = await ctx.provider.interactionDetails(req, res);
    const action = req.body?.action;

    if (action === 'send-code') {
      await handleSendCode(ctx, req, res, details);
      return;
    }
    if (action === 'verify') {
      await handleVerifyCode(ctx, req, res, details);
      return;
    }
    res.status(400).send(renderError(ctx.config, 'Invalid request', 'Unknown action.'));
  } catch (err) {
    handleInteractionError(ctx.config, req, res, err);
  }
}

export function interactionRouter(ctx: InteractionContext): Router {
  const router = Router();

  // Body parsing is scoped to this router (not app-level) so it doesn't
  // pre-parse oidc-provider's own POST bodies on the /token and /auth routes.
  router.use(express.urlencoded({ extended: false, limit: '10kb' }));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/:uid', (req, res) => handleInteractionGet(ctx, req, res));
  router.post('/:uid', (req, res) => handleInteractionSubmit(ctx, req, res));

  return router;
}

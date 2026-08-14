/**
 * Minimal type declarations for oidc-provider v9 (it ships no types). Covers
 * only the surface this project uses; keep it in sync if a new part of the
 * provider API is adopted.
 */
declare module 'oidc-provider' {
  /**
   * The error classes oidc-provider exports at runtime. Their `message` is the
   * short error code; the human-readable reason is in `error_description`.
   */
  export namespace errors {
    export class OIDCProviderError extends Error {
      error: string;
      error_description?: string;
      error_detail?: string;
      status: number;
      statusCode: number;
      expose: boolean;
      allow_redirect: boolean;
    }
    export class InvalidRequest extends OIDCProviderError {}
    export class SessionNotFound extends InvalidRequest {}
    export class InvalidGrant extends OIDCProviderError {}
  }

  export interface InteractionResult {
    login?: {
      accountId: string;
      remember?: boolean;
      amr?: string[];
      acr?: string;
    };
    consent?: {
      grantId?: string;
    };
    error?: string;
    error_description?: string;
  }

  export interface InteractionDetails {
    uid: string;
    params: {
      client_id: string;
      scope?: string;
    };
    session?: {
      accountId?: string;
      uid?: string;
    };
    prompt?: {
      name?: string;
      details?: {
        missingOIDCScope?: string[];
        missingOIDCClaims?: string[];
        missingResourceScopes?: Record<string, string[]>;
      };
    };
    grantId?: string;
  }

  export class Grant {
    constructor(payload: { accountId?: string; clientId: string });
    jti: string;
    accountId?: string;
    addOIDCScope(scope: string): void;
    addOIDCClaims(claims: string[]): void;
    addResourceScope(resource: string, scope: string): void;
    save(): Promise<string>;
    static find(id: string): Promise<Grant | undefined>;
  }

  export interface FindAccountResult {
    accountId: string;
    claims(
      use: string,
      scope: string,
      claims: unknown,
      rejected: unknown,
    ): Promise<Record<string, unknown>>;
  }

  export interface ProviderConfiguration {
    adapter?: (model: string) => unknown;
    clients?: Array<Record<string, unknown>>;
    jwks?: { keys: unknown[] };
    scopes?: string[];
    claims?: Record<string, unknown>;
    cookies?: { keys?: string[] };
    pkce?: { required?: () => boolean };
    features?: {
      devInteractions?: { enabled?: boolean };
    };
    renderError?: (ctx: unknown, out: unknown, error: unknown) => void;
    interactions?: {
      url?: (ctx: unknown, interaction: InteractionDetails) => string;
    };
    findAccount?: (
      ctx: unknown,
      sub: string,
      token: unknown,
    ) => Promise<FindAccountResult> | FindAccountResult;
    ttl?: Record<string, number>;
  }

  export default class Provider {
    constructor(issuer: string, config?: ProviderConfiguration);
    issuer: string;
    // Koa Application.proxy: trust X-Forwarded-* so discovery endpoints use
    // the external scheme/host when the provider sits behind a TLS proxy.
    proxy: boolean;
    Grant: typeof Grant;
    on(event: string, listener: (ctx: unknown, err: Error) => void): this;
    callback(): (req: unknown, res: unknown) => Promise<void>;
    interactionDetails(req: unknown, res: unknown): Promise<InteractionDetails>;
    interactionFinished(
      req: unknown,
      res: unknown,
      result: InteractionResult,
      opts?: { mergeWithLastSubmission?: boolean },
    ): Promise<void>;
  }
}

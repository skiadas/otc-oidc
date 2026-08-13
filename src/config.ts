import { existsSync } from 'node:fs';
import { bool, cleanEnv, makeValidator, num, port, str } from 'envalid';

export type NodeEnv = 'development' | 'production' | 'test';

export type Config = Readonly<{
  nodeEnv: NodeEnv;
  port: number;
  issuerUrl: string;
  cookieSecret: string;
  dataDir: string;
  allowedEmailDomains: string[];
  serviceName: string;
  fromAddress: string;
  mailDriver: 'console' | 'smtp';
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  codeTtlSeconds: number;
  codeLength: number;
  maxCodeAttempts: number;
  rateLimitSendPerEmail: number;
  rateLimitSendWindowMs: number;
  rateLimitSendPerIp: number;
  rateLimitIpWindowMs: number;
  lockoutMs: number;
  sessionTtlSeconds: number;
  accessTokenTtlSeconds: number;
  idTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
  grantTtlSeconds: number;
  interactionTtlSeconds: number;
  clientsPath: string;
  auditLogDir: string;
  auditRetentionDays: number;
}>;

function integerBetween(min: number, max: number) {
  return makeValidator<number>((input) => {
    const value = Number.parseInt(input, 10);
    if (Number.isNaN(value) || value < min || value > max) {
      throw new Error(`must be an integer between ${min} and ${max}`);
    }

    return value;
  });
}

// envalid's default reporter calls process.exit(1), which would kill test runs;
// throw instead so callers (and tests) see the collected errors. Like the
// default reporter, do nothing when validation passed.
function throwOnErrors({ errors }: { errors: Record<string, unknown> }): void {
  if (Object.keys(errors).length === 0) return;

  const messages = Object.entries(errors).map(
    ([key, err]) => `${key}: ${err instanceof Error ? err.message : String(err)}`,
  );
  throw new Error(`Invalid configuration:\n  - ${messages.join('\n  - ')}`);
}

export function loadConfig(): Config {
  const env = cleanEnv(
    process.env,
    {
      NODE_ENV: str({ choices: ['development', 'production', 'test'], default: 'development' }),
      PORT: port({ default: 3000 }),
      ISSUER_URL: str({ default: `http://localhost:${process.env.PORT ?? '3000'}` }),
      COOKIE_SECRET: str({
        devDefault: 'dev-cookie-secret',
        requiredWhen: (e) => e.NODE_ENV === 'production',
      }),
      DATA_DIR: str({ default: './data' }),
      ALLOWED_EMAIL_DOMAINS: str({ default: 'college.edu' }),
      SERVICE_NAME: str({ default: 'College SSO' }),
      FROM_ADDRESS: str({ default: 'no-reply@example.org' }),
      MAIL_DRIVER: str({ choices: ['console', 'smtp'], devDefault: 'console', default: 'smtp' }),
      SMTP_HOST: str({ default: '' }),
      SMTP_PORT: port({ default: 587 }),
      SMTP_SECURE: bool({ default: false }),
      SMTP_USER: str({ default: '' }),
      SMTP_PASS: str({ default: '' }),
      CODE_TTL_SECONDS: num({ default: 300 }),
      CODE_LENGTH: integerBetween(4, 10)({ default: 6 }),
      MAX_CODE_ATTEMPTS: num({ default: 5 }),
      RATE_LIMIT_SEND_PER_EMAIL: num({ default: 3 }),
      RATE_LIMIT_SEND_WINDOW_MS: num({ default: 5 * 60 * 1000 }),
      RATE_LIMIT_SEND_PER_IP: num({ default: 10 }),
      RATE_LIMIT_IP_WINDOW_MS: num({ default: 5 * 60 * 1000 }),
      LOCKOUT_MS: num({ default: 15 * 60 * 1000 }),
      SESSION_TTL_SECONDS: num({ default: 7 * 24 * 60 * 60 }),
      ACCESS_TOKEN_TTL_SECONDS: num({ default: 60 * 60 }),
      ID_TOKEN_TTL_SECONDS: num({ default: 60 * 60 }),
      REFRESH_TOKEN_TTL_SECONDS: num({ default: 14 * 24 * 60 * 60 }),
      AUTH_CODE_TTL_SECONDS: num({ default: 10 * 60 }),
      GRANT_TTL_SECONDS: num({ default: 30 * 24 * 60 * 60 }),
      INTERACTION_TTL_SECONDS: num({ default: 10 * 60 }),
      CLIENTS_PATH: str({ default: './clients.json' }),
      AUDIT_LOG_DIR: str({ default: './data' }),
      AUDIT_RETENTION_DAYS: num({ default: 30 }),
    },
    { reporter: throwOnErrors },
  );

  const allowedEmailDomains = env.ALLOWED_EMAIL_DOMAINS.split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);

  if (env.isProduction) {
    if (!/^https:\/\//.test(env.ISSUER_URL)) {
      throw new Error('ISSUER_URL must be an https URL in production');
    }

    if (!existsSync(env.CLIENTS_PATH)) throw new Error('CLIENTS_PATH does not exist');

    if (env.MAIL_DRIVER === 'console') {
      throw new Error('MAIL_DRIVER=console is not allowed in production');
    }

    if (env.MAIL_DRIVER === 'smtp' && !env.SMTP_USER) {
      throw new Error('SMTP_USER is required in production');
    }

    if (allowedEmailDomains.length === 0) {
      throw new Error('ALLOWED_EMAIL_DOMAINS must list at least one domain');
    }
  }

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    issuerUrl: env.ISSUER_URL,
    cookieSecret: env.COOKIE_SECRET,
    dataDir: env.DATA_DIR,
    allowedEmailDomains,
    serviceName: env.SERVICE_NAME,
    fromAddress: env.FROM_ADDRESS,
    mailDriver: env.MAIL_DRIVER,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
    codeTtlSeconds: env.CODE_TTL_SECONDS,
    codeLength: env.CODE_LENGTH,
    maxCodeAttempts: env.MAX_CODE_ATTEMPTS,
    rateLimitSendPerEmail: env.RATE_LIMIT_SEND_PER_EMAIL,
    rateLimitSendWindowMs: env.RATE_LIMIT_SEND_WINDOW_MS,
    rateLimitSendPerIp: env.RATE_LIMIT_SEND_PER_IP,
    rateLimitIpWindowMs: env.RATE_LIMIT_IP_WINDOW_MS,
    lockoutMs: env.LOCKOUT_MS,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS,
    accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    idTokenTtlSeconds: env.ID_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
    authCodeTtlSeconds: env.AUTH_CODE_TTL_SECONDS,
    grantTtlSeconds: env.GRANT_TTL_SECONDS,
    interactionTtlSeconds: env.INTERACTION_TTL_SECONDS,
    clientsPath: env.CLIENTS_PATH,
    auditLogDir: env.AUDIT_LOG_DIR,
    auditRetentionDays: env.AUDIT_RETENTION_DAYS,
  };
}

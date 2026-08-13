/**
 * One-time-code generation and verification.
 *
 * Codes are stored only as HMAC-SHA256 hashes (never plaintext) and compared
 * with `timingSafeEqual`. One live record exists per email: sending a new code
 * replaces the previous one, and a successful verify consumes the record, so a
 * code is always single-use. Repeated wrong guesses trigger a per-email
 * lockout that also blocks new sends. Records expire lazily and via `sweep`.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';

export type OtcConfig = Pick<
  Config,
  'codeLength' | 'codeTtlSeconds' | 'maxCodeAttempts' | 'lockoutMs'
>;

interface OtcRecord {
  hash: Buffer;
  expiresAt: number;
  attempts: number;
  lockedUntil: number;
}

export type VerifyFailureReason = 'locked' | 'expired' | 'invalid';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailureReason };

export function isAllowedEmail(email: string, domains: string[]): boolean {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(normalized)) return false;

  const domain = normalized.slice(normalized.indexOf('@') + 1);
  return domains.includes(domain);
}

export class OtcService {
  private readonly config: OtcConfig;
  private readonly hmacSecret: string;
  private records = new Map<string, OtcRecord>();

  constructor(config: OtcConfig, hmacSecret: string) {
    this.config = config;
    this.hmacSecret = hmacSecret;
  }

  private hash(code: string): Buffer {
    return createHmac('sha256', this.hmacSecret).update(code).digest();
  }

  private recordIsLocked(record: OtcRecord): boolean {
    return record.lockedUntil > Date.now();
  }

  private recordIsExpired(record: OtcRecord): boolean {
    return record.expiresAt <= Date.now();
  }

  generateCode(): string {
    const { codeLength } = this.config;
    const max = Math.pow(10, codeLength);
    return randomInt(0, max).toString().padStart(codeLength, '0');
  }

  isLocked(email: string): boolean {
    const record = this.records.get(email);
    return record !== undefined && this.recordIsLocked(record);
  }

  /**
   * Issue a fresh code for an email, replacing any prior record. Throws if the
   * email is locked out. The returned code must be delivered to the user (e.g.
   * by email); only its hash is retained.
   */
  sendCode(email: string): string {
    if (this.isLocked(email)) throw new Error('locked');

    const { codeTtlSeconds } = this.config;
    const code = this.generateCode();
    const now = Date.now();
    this.records.set(email, {
      hash: this.hash(code),
      expiresAt: now + codeTtlSeconds * 1000,
      attempts: 0,
      // 0 means "not locked".
      lockedUntil: 0,
    });
    return code;
  }

  /**
   * Verify a code for an email. A correct, unexpired code consumes the record
   * (single-use). A wrong code increments the attempt counter and locks the
   * email out for `lockoutMs` after `maxCodeAttempts` failures.
   */
  verifyCode(email: string, code: string): VerifyResult {
    const { lockoutMs, maxCodeAttempts } = this.config;
    const record = this.records.get(email);
    // A missing record is indistinguishable from a wrong code on purpose: it
    // would otherwise let an attacker probe whether a code was ever issued.
    if (!record) return { ok: false, reason: 'invalid' };

    if (this.recordIsLocked(record)) return { ok: false, reason: 'locked' };

    if (this.recordIsExpired(record)) {
      this.records.delete(email);
      return { ok: false, reason: 'expired' };
    }

    const candidate = this.hash(code);
    if (timingSafeEqual(record.hash, candidate)) {
      this.records.delete(email);
      return { ok: true };
    }

    record.attempts += 1;
    if (record.attempts >= maxCodeAttempts) {
      record.lockedUntil = Date.now() + lockoutMs;
      // Expire the record immediately so sweep removes it once the lock lifts.
      record.expiresAt = 0;
    }
    return { ok: false, reason: 'invalid' };
  }

  sweep(): void {
    const now = Date.now();
    for (const [email, record] of this.records) {
      if (record.expiresAt <= now && record.lockedUntil <= now) this.records.delete(email);
    }
  }
}

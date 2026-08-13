import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from './config.js';
import { minutesFromSeconds } from './duration.js';

export type MailerConfig = Pick<
  Config,
  'mailDriver' | 'smtp' | 'fromAddress' | 'serviceName' | 'codeTtlSeconds'
>;

export function composeCodeEmail(
  config: MailerConfig,
  code: string,
): { subject: string; text: string } {
  const minutes = minutesFromSeconds(config.codeTtlSeconds);
  return {
    subject: `Your ${config.serviceName} sign-in code`,
    text: [
      `You asked to sign in to ${config.serviceName}.`,
      '',
      `Your one-time code is: ${code}`,
      '',
      `This code expires in ${minutes} minutes. Enter it on the sign-in page to continue.`,
      '',
      "If you didn't request this code, you can safely ignore this email — it will expire on its own.",
      'Never share this code with anyone.',
      '',
    ].join('\n'),
  };
}

export class Mailer {
  private readonly config: MailerConfig;
  private transporter?: Transporter;

  constructor(config: MailerConfig) {
    this.config = config;
    if (config.mailDriver === 'smtp') {
      const { host, port, secure, user, pass } = config.smtp;
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user ? { user, pass } : undefined,
      });
    }
  }

  async sendCode(to: string, code: string): Promise<void> {
    const { subject, text } = composeCodeEmail(this.config, code);

    if (this.config.mailDriver === 'console') {
      process.stdout.write(`[mail:console] To: ${to}\nSubject: ${subject}\n\n${text}\n`);
      return;
    }

    if (!this.transporter) throw new Error('SMTP mailer not configured');

    await this.transporter.sendMail({
      from: this.config.fromAddress,
      to,
      subject,
      text,
    });
  }
}

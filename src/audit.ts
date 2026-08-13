import { createWriteStream, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { WriteStream } from 'node:fs';

export interface AuditEvent {
  ts: string;
  event: string;
  email?: string;
  ip?: string;
  clientId?: string;
  success?: boolean;
  detail?: string;
}

function dateFromFilename(name: string): string | null {
  const match = /^audit-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
  return match?.[1] ?? null;
}

export class AuditLogger {
  private readonly dir: string;
  private readonly retentionDays: number;
  private stream?: WriteStream;
  private currentFile = '';

  constructor(dir: string, retentionDays: number) {
    this.dir = dir;
    this.retentionDays = retentionDays;
    mkdirSync(dir, { recursive: true });
    this.sweep();
  }

  private fileFor(date: Date): string {
    return `audit-${date.toISOString().slice(0, 10)}.log`;
  }

  private open(): void {
    const file = this.fileFor(new Date());
    if (file === this.currentFile) return;

    this.stream?.end();
    this.currentFile = file;
    const stream = createWriteStream(join(this.dir, file), { flags: 'a' });
    stream.on('error', (err) => {
      process.stderr.write(`audit log write failed: ${err.message}\n`);
    });
    this.stream = stream;
  }

  log(event: Omit<AuditEvent, 'ts'> & { ts?: string }): void {
    this.open();
    const line = JSON.stringify({ ts: event.ts ?? new Date().toISOString(), ...event });
    this.stream?.write(`${line}\n`);
  }

  sweep(): void {
    const { dir, retentionDays } = this;
    if (!existsSync(dir)) return;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    for (const name of readdirSync(dir)) {
      const date = dateFromFilename(name);
      if (date && date < cutoff) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // ignore concurrent cleanup failures
        }
      }
    }
  }
}

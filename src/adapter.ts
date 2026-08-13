/**
 * SQLite-backed storage adapter for oidc-provider.
 *
 * Runs on an in-memory SQLite database (`:memory:`), so all provider state is
 * lost on restart — a deliberate tradeoff (see AGENTS.md). Switching to a
 * durable file later is a one-line change: pass a path instead of `:memory:`.
 *
 * A single generic table holds every model. `uid`, `user_code`, and `grant_id`
 * are indexed columns rather than hand-maintained maps, which is what lets
 * `findByUid` and `revokeByGrantId` be plain SQL. Entries expire lazily on
 * read and are purged by `sweep`.
 */
import { DatabaseSync } from 'node:sqlite';

function epochTime(): number {
  return Math.floor(Date.now() / 1000);
}

const NOT_EXPIRED = '(expires_at_ms IS NULL OR expires_at_ms > ?)';

export class SqliteAdapter {
  private readonly db: DatabaseSync;
  private readonly model: string;

  constructor(db: DatabaseSync, model: string) {
    this.db = db;
    this.model = model;
  }

  private findRow(id: string): Record<string, unknown> | undefined {
    const { db, model } = this;
    const row = db
      .prepare(`SELECT payload FROM entries WHERE model = ? AND id = ? AND ${NOT_EXPIRED}`)
      .get(model, id, Date.now()) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
  }

  async find(id: string): Promise<Record<string, unknown> | undefined> {
    return this.findRow(id);
  }

  /**
   * Resolve a model by its session uid. Used by `Session.findByUid`, which
   * `AuthorizationCode.find` relies on to enforce session binding for
   * `expiresWithSession` codes.
   */
  async findByUid(uid: string): Promise<Record<string, unknown> | undefined> {
    const { db, model } = this;
    const row = db
      .prepare(`SELECT payload FROM entries WHERE model = ? AND uid = ? AND ${NOT_EXPIRED}`)
      .get(model, uid, Date.now()) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
  }

  async findByUserCode(userCode: string): Promise<Record<string, unknown> | undefined> {
    const { db, model } = this;
    const row = db
      .prepare(`SELECT payload FROM entries WHERE model = ? AND user_code = ? AND ${NOT_EXPIRED}`)
      .get(model, userCode, Date.now()) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
  }

  async upsert(id: string, payload: Record<string, unknown>, expiresIn?: number): Promise<void> {
    const { db, model } = this;
    const expiresAtMs = typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : null;
    const uid = typeof payload.uid === 'string' ? payload.uid : null;
    const userCode = typeof payload.userCode === 'string' ? payload.userCode : null;
    const grantId = typeof payload.grantId === 'string' ? payload.grantId : null;
    db.prepare(
      `INSERT INTO entries (model, id, payload, expires_at_ms, uid, user_code, grant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model, id) DO UPDATE SET
         payload = excluded.payload,
         expires_at_ms = excluded.expires_at_ms,
         uid = excluded.uid,
         user_code = excluded.user_code,
         grant_id = excluded.grant_id`,
    ).run(model, id, JSON.stringify(payload), expiresAtMs, uid, userCode, grantId);
  }

  async destroy(id: string): Promise<void> {
    const { db, model } = this;
    db.prepare('DELETE FROM entries WHERE model = ? AND id = ?').run(model, id);
  }

  async consume(id: string): Promise<void> {
    const { db, model } = this;
    // oidc-provider reads `consumed` as an epoch-seconds timestamp, unlike the
    // millisecond `expires_at_ms` used for our own TTL bookkeeping.
    db.prepare(
      "UPDATE entries SET payload = json_set(payload, '$.consumed', ?) WHERE model = ? AND id = ?",
    ).run(epochTime(), model, id);
  }

  /**
   * Delete every entry recorded under a grant id. Called on logout and when a
   * consumed code is reused, so those tokens must not outlive their grant.
   */
  async revokeByGrantId(grantId: string): Promise<void> {
    const { db } = this;
    db.prepare('DELETE FROM entries WHERE grant_id = ?').run(grantId);
  }
}

export interface AdapterBundle {
  adapter: (model: string) => SqliteAdapter;
  sweep: () => void;
}

export function createSqliteAdapter(): AdapterBundle {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE entries (
      model TEXT NOT NULL,
      id TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at_ms INTEGER,
      uid TEXT,
      user_code TEXT,
      grant_id TEXT,
      PRIMARY KEY (model, id)
    );
    CREATE INDEX idx_entries_uid ON entries (model, uid);
    CREATE INDEX idx_entries_user_code ON entries (model, user_code);
    CREATE INDEX idx_entries_grant ON entries (grant_id);
  `);
  const sweep = db.prepare(
    'DELETE FROM entries WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?',
  );
  return {
    adapter: (model) => new SqliteAdapter(db, model),
    sweep: () => {
      sweep.run(Date.now());
    },
  };
}

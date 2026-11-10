// A small D1 stand-in on node:sqlite, so scans run end-to-end against the real migrations.
/// <reference types="node" />
// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

type Param = string | number | null;
const norm = (v: unknown): Param => (v === undefined || v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Param));

class Stmt {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly params: Param[] = []) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args.map(norm));
  }
  exec() {
    const s = this.db.prepare(this.sql);
    const isRead = /^\s*(SELECT|WITH)/i.test(this.sql);
    if (isRead) {
      const rows = s.all(...this.params) as Record<string, unknown>[];
      return { results: rows.map((r) => ({ ...r })), meta: { rows_read: rows.length, rows_written: 0 }, success: true };
    }
    const r = s.run(...this.params);
    return { results: [], meta: { rows_read: 0, rows_written: Number(r.changes) }, success: true };
  }
  async all() {
    return this.exec();
  }
  async run() {
    return this.exec();
  }
  async first(col?: string) {
    const row = this.exec().results[0] ?? null;
    return col ? (row?.[col] ?? null) : row;
  }
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f: string) => f.endsWith('.sql')).sort();

/** Applies migrations whose file name sorts before `stopBefore` (all when omitted). */
export function createD1(opts: { stopBefore?: string } = {}): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const f of migrationFiles().filter((f) => !opts.stopBefore || f < opts.stopBefore)) db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    exec: async (sql: string) => db.exec(sql),
    /** Test only: applies the migrations from `from` onwards, like a later deploy would. */
    migrateFrom: (from: string) => {
      for (const f of migrationFiles().filter((f) => f >= from)) db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    },
  };
  return d1 as unknown as D1Database;
}

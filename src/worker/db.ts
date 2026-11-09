// Small D1 helpers. Bulk writes go through json_each(?) so one statement handles
// any number of rows: D1 allows 50 queries per invocation on the Free plan.
// SPDX-License-Identifier: AGPL-3.0-only

export type Settings = Record<string, string>;

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export function setSettings(db: D1Database, values: Settings): D1PreparedStatement {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value }));
  return db
    .prepare(
      `INSERT INTO settings (key, value)
       SELECT json_extract(value, '$.key'), json_extract(value, '$.value') FROM json_each(?1) WHERE true
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(JSON.stringify(rows));
}

export function hourFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);
}

export function isoHour(d: Date): string {
  return hourFloor(d).toISOString().replace('.000Z', 'Z');
}

export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

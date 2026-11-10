// Counts D1 rows read and written in one invocation, for the Self-cost panel.
// Wraps a D1Database so every statement result's meta is added up; behaviour is unchanged.
// SPDX-License-Identifier: AGPL-3.0-only

export interface Meter {
  rowsRead: number;
  rowsWritten: number;
  queries: number;
}

type Meta = { rows_read?: number; rows_written?: number } | undefined;

export function metered(db: D1Database): { db: D1Database; meter: Meter } {
  const meter: Meter = { rowsRead: 0, rowsWritten: 0, queries: 0 };
  // `queries` counts calls the way D1's per-invocation limit does: a db.batch() is one query,
  // however many statements it holds (d1/platform/limits, "Batch limits").
  const add = (meta: Meta, count = true) => {
    if (count) meter.queries++;
    meter.rowsRead += meta?.rows_read ?? 0;
    meter.rowsWritten += meta?.rows_written ?? 0;
  };

  const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === 'bind') return (...args: unknown[]) => wrapStmt(target.bind(...args));
        if (prop === 'all' || prop === 'run') {
          return async () => {
            const r = await (target[prop] as () => Promise<D1Result>).call(target);
            add(r.meta as Meta);
            return r;
          };
        }
        if (prop === 'first') {
          return async (col?: string) => {
            const r = await target.all<Record<string, unknown>>();
            add(r.meta as Meta);
            const row = r.results[0] ?? null;
            return col ? (row?.[col] ?? null) : row;
          };
        }
        if (prop === '__inner') return target;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return (sql: string) => wrapStmt(target.prepare(sql));
      if (prop === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          const inner = stmts.map((s) => ((s as unknown as { __inner?: D1PreparedStatement }).__inner ?? s));
          const results = await target.batch(inner);
          meter.queries++;
          for (const r of results) add(r.meta as Meta, false);
          return results;
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db: proxy, meter };
}

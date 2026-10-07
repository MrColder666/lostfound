// 最小 D1 仿制：prepare().bind().first()/all()/run()、batch()、meta.changes
import { DatabaseSync } from 'node:sqlite';
export function fakeDb(schemaSql) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(schemaSql);
  const stmt = (q, params = []) => ({
    first: async () => sql.prepare(q).get(...params) ?? null,
    all: async () => sql.prepare(q).all(...params),
    run: async () => { const r = sql.prepare(q).run(...params);
      return { results: [], meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } }; },
  });
  return {
    prepare: (q) => ({ bind: (...params) => stmt(q, params) }),
    batch: async (ops) => {   // 顺序执行（简化：内存库无需真事务）
      const out = [];
      for (const op of ops) out.push(await op.run());
      return out;
    },
    _sql: sql,
  };
}

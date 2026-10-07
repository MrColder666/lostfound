// 最小 D1 仿制：prepare().bind().first()/all()/run()、batch()、meta.changes
import { DatabaseSync } from 'node:sqlite';
export function fakeDb(schemaSql) {
  // enableForeignKeyConstraints:false —— 简报测试直插引用行（先 claims 后 items），替身不模拟 FK；生产 D1 仍强制
  const sql = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  sql.exec(schemaSql);
  const stmt = (q, params = []) => ({
    bind: (...p) => stmt(q, p),   // D1：prepare(q) 本身即语句，bind 返回新语句
    first: async () => sql.prepare(q).get(...params) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...params) }),  // D1 形状 {results}
    run: async () => { const r = sql.prepare(q).run(...params);
      return { results: [], meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } }; },
  });
  return {
    prepare: (q) => stmt(q),
    batch: async (ops) => {   // 顺序执行（简化：内存库无需真事务）
      const out = [];
      for (const op of ops) out.push(await op.run());
      return out;
    },
    _sql: sql,
  };
}

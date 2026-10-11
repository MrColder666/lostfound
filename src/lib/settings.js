// src/lib/settings.js —— 后台可调参数（settings 表 + 默认值合并）
export const DEFAULTS = {
  slots: '12', pickup_ttl_hours: '48', claim_active_cap: '3', claim_daily_cap: '5',
  reward_normal: '10', reward_high: '25', month_cap: '100', snatch_min: '10',
  notice: '', notice_on: '0',
};
export async function getSettings(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const map = { ...DEFAULTS };
  for (const r of rows.results) if (r.key in DEFAULTS) map[r.key] = r.value;
  return map;
}
export async function setSettings(db, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue;
    await db.prepare(`INSERT INTO settings(key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`).bind(k, String(v)).run();
  }
}

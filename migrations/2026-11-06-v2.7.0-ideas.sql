-- v2.7.0 「加建议」建议箱：主站弹窗提交，后台 Ideas 标签查看
-- 同时需同步 schema.sql（测试用 fakeDb 直接读 schema.sql）
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  page TEXT,                                  -- 可选：board / report / rewards / kiosk / other
  contact TEXT,                               -- 可选：学号或邮箱，方便回复
  status TEXT NOT NULL DEFAULT 'new',         -- new | seen
  ip_hash TEXT,                               -- 仅用于溯源，不展示
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status, id DESC);

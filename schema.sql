CREATE TABLE IF NOT EXISTS identities (
  student_id TEXT PRIMARY KEY,            -- 7 位数字
  name TEXT NOT NULL,
  class TEXT NOT NULL,
  pin_hash TEXT,                          -- 可选：SHA-256(salt+pin)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,              -- LF-2026-0001
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,                 -- electronics|card|clothing|book|other
  location TEXT NOT NULL,
  photo_path TEXT,
  detail_photo_path TEXT,                 -- 非公开细节照（不公开）
  verify_q TEXT,                          -- 非公开核验问题
  verify_a TEXT,                          -- 非公开核验答案
  value_tier TEXT NOT NULL DEFAULT 'normal',
  slot_no INTEGER,                        -- confirm-drop 时才写入
  drop_code TEXT,                         -- 6 位投递凭证码
  drop_expires_at TEXT,                   -- 凭证过期时刻
  status TEXT NOT NULL DEFAULT 'registered', -- registered|voided|in_stock|claim_pending|ready|returned|expired
  registered_by TEXT NOT NULL REFERENCES identities(student_id),
  registered_via TEXT NOT NULL,           -- phone|kiosk
  found_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_drop ON items(drop_code) WHERE drop_code IS NOT NULL;
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  claimant_id TEXT NOT NULL REFERENCES identities(student_id),
  verify_answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|in_review|approved|rejected|fulfilled
  pickup_code TEXT UNIQUE,
  pickup_expires_at TEXT,
  review_reason TEXT,
  evidence_photo_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fulfilled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_item ON claims(item_id, status);
CREATE TABLE IF NOT EXISTS points_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL REFERENCES identities(student_id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,                   -- claim_reward|tip_in|tip_out|redeem|adjust
  ref_type TEXT,                          -- claim|redemption|admin
  ref_id INTEGER,
  month_key TEXT NOT NULL,                -- '2026-10'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_month ON points_ledger(student_id, month_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tip_once ON points_ledger(ref_type, ref_id, student_id) WHERE reason='tip_in';
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, name_en TEXT NOT NULL,
  cost INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL REFERENCES identities(student_id),
  reward_id INTEGER NOT NULL REFERENCES rewards(id),
  points_cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|fulfilled|cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fulfilled_at TEXT
);
CREATE TABLE IF NOT EXISTS risk_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,             -- item|claim|pair
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL, target TEXT, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

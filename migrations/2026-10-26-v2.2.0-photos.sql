-- L&F v2.2.0 · photo storage fallback
--
-- R2 is not enabled on this account, so `env.PHOTOS` is undefined and uploaded
-- photos used to be dropped silently. Photos now fall back to a BLOB table in D1.
--
-- Apply (production):
--   npx wrangler d1 execute lostfound --remote --file migrations/2026-10-26-v2.2.0-photos.sql
--
-- Idempotent; keep in sync with schema.sql.

CREATE TABLE IF NOT EXISTS photos (
  path TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

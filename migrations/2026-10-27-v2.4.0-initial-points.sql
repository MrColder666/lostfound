-- L&F v2.4.0 · initial 67 points per student
--
-- Points are never reset monthly: the only month-scoped rule is "earn at most
-- 100 points per month" (claim rewards + tips). Every student also starts with
-- 67 points, recorded as reason='initial' and NOT counted against that monthly
-- earning allowance.
--
-- This migration is idempotent: it only adds the starting balance to identities
-- that have no 'initial' entry yet.
--
-- Apply:
--   npx wrangler d1 execute lostfound --remote --file migrations/2026-10-27-v2.4.0-initial-points.sql

INSERT INTO points_ledger (student_id, delta, reason, ref_type, ref_id, month_key, created_at)
SELECT i.student_id, 67, 'initial', 'identity', i.student_id,
       strftime('%Y-%m','now'), datetime('now')
FROM identities i
WHERE NOT EXISTS (
  SELECT 1 FROM points_ledger p
  WHERE p.student_id = i.student_id AND p.reason = 'initial'
);

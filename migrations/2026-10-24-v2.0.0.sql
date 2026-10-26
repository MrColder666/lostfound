-- L&F v2.0.0 · student database + admin console
--
-- Indexes only. No table or column changes, so this file is safe to run on the
-- live D1 as many times as needed: every statement uses IF NOT EXISTS.
--
-- Apply (production):
--   npx wrangler d1 execute lostfound --remote --file migrations/2026-10-24-v2.0.0.sql
-- Or paste the statements into the D1 console.
--
-- Keep in sync with schema.sql.

-- Student search and sorting -------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_identities_name      ON identities(name);
CREATE INDEX IF NOT EXISTS idx_identities_class     ON identities(class);
CREATE INDEX IF NOT EXISTS idx_identities_created   ON identities(created_at);

-- Per-student counters and the protected-delete checks ------------------------
CREATE INDEX IF NOT EXISTS idx_items_finder         ON items(registered_by, status);
CREATE INDEX IF NOT EXISTS idx_claims_claimant      ON claims(claimant_id, status);
CREATE INDEX IF NOT EXISTS idx_redemptions_student  ON redemptions(student_id, status);
CREATE INDEX IF NOT EXISTS idx_redemptions_reward   ON redemptions(reward_id);

-- One refund row per cancelled order. Makes the cancel + refund path idempotent
-- even if two requests race or a retry arrives later.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_once   ON points_ledger(ref_type, ref_id) WHERE reason='redeem_refund';

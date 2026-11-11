-- v2.8.0 物品归档：归档时记住原状态，恢复时还原
-- 同时需同步 schema.sql（测试用 fakeDb 直接读 schema.sql）
ALTER TABLE items ADD COLUMN prev_status TEXT;

-- seed.sql, demo data for a fresh install
-- v1.8.0：公示板 14 件 + 已归还 4 件（供首页成果指标 / 最近归还使用），照片走静态 /img/items/。
-- 所有时间均为 UTC ISO，相对运行时刻生成。
INSERT INTO identities (student_id, name, class) VALUES
  ('9031622', 'Alex Wang',  '7B'),
  ('9031623', 'Leo Li',     '7B'),
  ('9031624', 'Mia Chen',   '8C');

-- Rewards catalog (icons shown on the rewards-shop cards)
INSERT INTO rewards (name, name_en, cost, stock, active, icon) VALUES
  ('Stationery set',              'Stationery set',              40, 20, 1, '✏️'),
  ('Printing credit · 20 pages',  'Printing credit · 20 pages',  25, 40, 1, '🖨️'),
  ('Snack bar voucher · ¥5',      'Snack bar voucher · ¥5',      50, 15, 1, '🍪'),
  ('Notebook + pen',              'Notebook + pen',              30, 25, 1, '📒'),
  ('Campus tote bag',             'Campus tote bag',             80,  6, 1, '👜'),
  ('Study room priority pass',    'Study room priority pass',    60, 10, 1, '📚');

-- 运营参数：24 格位（后台 Settings 可改）
INSERT INTO settings (key, value) VALUES
  ('slots', '24'), ('pickup_ttl_hours', '48'), ('claim_active_cap', '3'),
  ('claim_daily_cap', '5'), ('reward_normal', '10'), ('reward_high', '25'),
  ('month_cap', '100'), ('snatch_min', '10'), ('notice_on', '0');

-- ── 公示板（in_stock，14 件，带真实照片）────────────────────────────────
INSERT INTO items (code, title, description, category, location, photo_path, slot_no, status,
                   registered_by, registered_via, value_tier, found_at, created_at, updated_at) VALUES
  ('LF-2026-0101', 'Sport water bottle', 'Dark blue sport bottle, flip lid, red band near the cap', 'other', 'Gym, hallway by the equipment room', '/img/items/water-bottle.jpg', 14, 'in_stock', '9031623', 'kiosk', 'normal', strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-170 minutes'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-170 minutes')),
  ('LF-2026-0102', 'Wireless earbuds (black)', 'Right bud shows wear; white charging case, no cable', 'electronics', 'Library 3F, study area', '/img/items/earbuds.jpg', 3, 'in_stock', '9031624', 'kiosk', 'high', strftime('%Y-%m-%dT%H:%M:%SZ','now','-5 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-280 minutes'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-280 minutes')),
  ('LF-2026-0103', 'Student card', 'Name printed on the front; found beside the tray return', 'card', 'Canteen 2F, tray return', '/img/items/student-card.jpg', 2, 'in_stock', '9031622', 'kiosk', 'high', strftime('%Y-%m-%dT%H:%M:%SZ','now','-26 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-25 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-25 hours')),
  ('LF-2026-0104', 'Grey hoodie', 'Light grey pullover, size M, a pen mark on the left sleeve', 'clothing', 'Playground, by the east goal', '/img/items/hoodie.jpg', 7, 'in_stock', '9031623', 'phone', 'normal', strftime('%Y-%m-%dT%H:%M:%SZ','now','-29 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-28 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-28 hours')),
  ('LF-2026-0105', 'Scientific calculator', 'Model name scratched off the back; name sticker on the battery cover', 'electronics', 'Room 4B, Math classroom', '/img/items/calculator.jpg', 9, 'in_stock', '9031624', 'kiosk', 'high', strftime('%Y-%m-%dT%H:%M:%SZ','now','-31 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 hours')),
  ('LF-2026-0106', 'Black-frame glasses', 'Plain black frames, one arm slightly loose', 'other', 'Science Lab 2, bench by the window', '/img/items/glasses.jpg', 5, 'in_stock', '9031622', 'phone', 'normal', strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-47 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-47 hours')),
  ('LF-2026-0107', 'Canvas tote bag', 'Plain tote with a red drawstring inside', 'other', 'Main Gate, bike racks', '/img/items/tote-bag.jpg', 11, 'in_stock', '9031623', 'kiosk', 'normal', strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-50 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-50 hours')),
  ('LF-2026-0108', 'Notebook with class notes', 'Blue cover, name on the first page, half filled', 'book', 'Study Room 2A, table 6', '/img/items/notebook.jpg', 4, 'in_stock', '9031624', 'phone', 'normal', strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-71 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-71 hours')),
  ('LF-2026-0109', 'Black umbrella', 'Folding umbrella, wooden handle, one broken rib', 'other', 'Bus stop, by the crosswalk', '/img/items/umbrella.jpg', 6, 'in_stock', '9031623', 'kiosk', 'normal', strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-74 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-74 hours')),
  ('LF-2026-0110', 'Wired earphones', 'White cable, one bud wrapped in tape', 'electronics', 'Music Room, piano bench', '/img/items/earphones.jpg', 8, 'in_stock', '9031624', 'kiosk', 'normal', strftime('%Y-%m-%dT%H:%M:%SZ','now','-4 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-95 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-95 hours')),
  ('LF-2026-0111', 'PE kit (shirt + shorts)', 'White shirt and navy shorts, folded, in a plastic bag', 'clothing', 'Changing Room, bench 2', '/img/items/pe-kit.jpg', 10, 'in_stock', '9031623', 'phone', 'normal', strftime('%Y-%m-%dT%H:%M:%SZ','now','-4 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-98 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-98 hours')),
  ('LF-2026-0112', 'USB-C charger + cable', 'White 30W adapter with a braided cable', 'electronics', 'IT Room, desk 3', '/img/items/charger.jpg', 12, 'in_stock', '9031622', 'kiosk', 'normal', strftime('%Y-%m-%dT%H:%M:%SZ','now','-5 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-119 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-119 hours')),
  ('LF-2026-0113', 'Keys on a keyring', 'Three keys on a steel ring, one small locker key', 'other', 'Cafeteria, salad bar', '/img/items/keys.jpg', 1, 'in_stock', '9031624', 'kiosk', 'normal', strftime('%Y-%m-%dT%H:%M:%SZ','now','-5 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-122 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-122 hours')),
  ('LF-2026-0114', 'Brown leather wallet', 'Cards inside, cash untouched, handed in as found', 'other', 'Library 1F, sofa', '/img/items/wallet.jpg', 15, 'in_stock', '9031622', 'kiosk', 'high', strftime('%Y-%m-%dT%H:%M:%SZ','now','-6 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-143 hours'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-143 hours'));

-- ── 已归还（returned，用于首页成果指标 / 最近归还；无照片，公示板不展示）──
INSERT INTO items (code, title, description, category, location, slot_no, status,
                   registered_by, registered_via, value_tier, found_at, created_at, updated_at) VALUES
  ('LF-2026-0091', 'Grey backpack', 'Handed in at the west stairwell', 'other', 'West stairwell', NULL, 'returned', '9031623', 'kiosk', 'normal',
   strftime('%Y-%m-%dT%H:%M:%SZ','now','-8 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-8 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-8 days','+6 hours')),
  ('LF-2026-0092', 'Math workbook', 'Name written on the cover', 'book', 'Room 3C', NULL, 'returned', '9031624', 'phone', 'normal',
   strftime('%Y-%m-%dT%H:%M:%SZ','now','-12 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-12 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-12 days','+20 hours')),
  ('LF-2026-0093', 'Steel water bottle', 'Brushed steel, 750 ml', 'other', 'Sports hall', NULL, 'returned', '9031622', 'kiosk', 'normal',
   strftime('%Y-%m-%dT%H:%M:%SZ','now','-16 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-16 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-16 days','+30 hours')),
  ('LF-2026-0094', 'Phone case', 'Clear case with a card holder', 'other', 'Library 2F', NULL, 'returned', '9031623', 'kiosk', 'normal',
   strftime('%Y-%m-%dT%H:%M:%SZ','now','-22 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-22 days'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-22 days','+44 hours'));

-- ── 积分流水（成果指标「Points awarded」需要真实数据）──────────────────
-- v2.4.0：每位学生初始 67 分（reason=initial，不占当月「获得」额度）
INSERT INTO points_ledger (student_id, delta, reason, ref_type, ref_id, month_key, created_at) VALUES
  ('9031622', 67, 'initial', 'identity', '9031622', strftime('%Y-%m','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')),
  ('9031623', 67, 'initial', 'identity', '9031623', strftime('%Y-%m','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')),
  ('9031624', 67, 'initial', 'identity', '9031624', strftime('%Y-%m','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days'));
INSERT INTO points_ledger (student_id, delta, reason, ref_type, ref_id, month_key, created_at) VALUES
  ('9031623', 10, 'claim_reward', 'claim', 1, strftime('%Y-%m','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')),
  ('9031624', 10, 'claim_reward', 'claim', 2, strftime('%Y-%m','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-9 days')),
  ('9031622', 25, 'claim_reward', 'claim', 3, strftime('%Y-%m','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 days')),
  ('9031623', 10, 'claim_reward', 'claim', 4, strftime('%Y-%m','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now','-12 days'));

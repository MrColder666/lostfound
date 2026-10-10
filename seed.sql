-- seed.sql — demo data for a fresh install (all times are UTC ISO, relative to run time)
-- 3 identities
INSERT INTO identities (student_id, name, class) VALUES
  ('9031622', 'Alex Wang',  '7(3)'),
  ('9031623', 'Leo Li',     '7(3)'),
  ('9031624', 'Mia Chen',   '8(1)');

-- Rewards catalog (icons shown on the rewards-shop cards)
INSERT INTO rewards (name, name_en, cost, stock, active, icon) VALUES
  ('Stationery set',              'Stationery set',              40, 20, 1, '✏️'),
  ('Printing credit · 20 pages',  'Printing credit · 20 pages',  25, 40, 1, '🖨️'),
  ('Snack bar voucher · ¥5',      'Snack bar voucher · ¥5',      50, 15, 1, '🍪'),
  ('Notebook + pen',              'Notebook + pen',              30, 25, 1, '📒'),
  ('Campus tote bag',             'Campus tote bag',             80,  6, 1, '👜'),
  ('Study room priority pass',    'Study room priority pass',    60, 10, 1, '📚');

-- 3 items on the board (slots 1 / 3 / 5 occupied)
INSERT INTO items (code, title, description, category, location, slot_no, status,
                   registered_by, registered_via, found_at, created_at, updated_at) VALUES
  ('LF-2026-0001', 'Blue water bottle', 'Small scratch on the base, cat sticker on the side', 'other', 'Gym — hallway by the equipment room', 3, 'in_stock',
   '9031623', 'kiosk',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 hours'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-170 minutes'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-170 minutes')),
  ('LF-2026-0002', 'Wireless earbuds (black)', 'Right earbud shows wear; white charging case', 'electronics', 'Library 3F — study area', 5, 'in_stock',
   '9031624', 'kiosk',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-100 minutes'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-100 minutes')),
  ('LF-2026-0003', 'Student card', 'Name printed on the card; found near the canteen tray return', 'card', 'Canteen 2F — tray return', 1, 'in_stock',
   '9031622', 'kiosk',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hours'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-50 minutes'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-50 minutes'));

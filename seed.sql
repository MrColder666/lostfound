-- seed.sql：演示数据（时间均为相对执行时刻的 UTC ISO）
-- 3 个身份
INSERT INTO identities (student_id, name, class) VALUES
  ('9031622', '王小明', '7(3)'),
  ('9031623', '李思远', '7(3)'),
  ('9031624', '陈乐瑶', '8(1)');

-- 3 个奖品
INSERT INTO rewards (name, name_en, cost, stock, active) VALUES
  ('贴纸包', 'Sticker Pack', 20, 30, 1),
  ('文具套装', 'Stationery Kit', 60, 10, 1),
  ('校园咖啡券', 'Campus Coffee Voucher', 100, 5, 1);

-- 2 个 in_stock 物品：格号 3 / 5 已占
INSERT INTO items (code, title, description, category, location, slot_no, status,
                   registered_by, registered_via, found_at, created_at, updated_at) VALUES
  ('LF-2026-0001', '蓝色保温杯', '杯底有划痕，贴着猫咪贴纸', 'other', '体育馆一楼器材室旁走廊', 3, 'in_stock',
   '9031623', 'kiosk',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 hours'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-170 minutes'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-170 minutes')),
  ('LF-2026-0002', '黑色无线耳机', '装在白色充电盒内，右耳有使用痕迹', 'electronics', '图书馆三楼自习区', 5, 'in_stock',
   '9031624', 'kiosk',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-100 minutes'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-100 minutes'));

-- 1 个 registered 物品：投递凭证码 135790，15 分钟后过期
INSERT INTO items (code, title, description, category, location, drop_code, drop_expires_at, status,
                   registered_by, registered_via, found_at, created_at, updated_at) VALUES
  ('LF-2026-0003', '学生卡（王小明）', '卡面姓名：王小明，班级 7(3)', 'card', '食堂二楼餐具回收处', '135790',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+15 minutes'), 'registered',
   '9031623', 'phone',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-20 minutes'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-18 minutes'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-18 minutes'));

// tests/photo.test.js —— 照片链路：R2 未启用时必须落 D1，且 /api/photos 能取回原图
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fake-db.js';
import { report } from '../src/api/report.js';
import { getPhoto } from '../src/api/items.js';

const SCHEMA = readFileSync('schema.sql', 'utf8');
const env = { SLOT_COUNT: '12', FREEZE_MINUTES: '60', PICKUP_TTL_HOURS: '48', ADMIN_TOKEN: 'T0KEN' };  // 故意不给 PHOTOS

// 最小合法 JPEG（magic bytes 通过 checkImage）
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 7, 8]);

function mkForm(withPhoto = true) {
  const f = new FormData();
  f.set('title', 'Photo item');
  f.set('description', 'photo pipeline');
  f.set('category', 'other');
  f.set('location', 'Room 1');
  f.set('student_id', '9031622');
  f.set('name', 'Alex Wang');
  f.set('class', '7B');
  if (withPhoto) f.set('photo', new File([JPEG], 'p.jpg', { type: 'image/jpeg' }));
  return new Request('https://x/api/report', { method: 'POST', body: f });
}

async function seedIdentity(db) {
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031622','Alex Wang','7B')").run();
}

test('无 R2 时：上传照片落 D1 photos 表，且 getPhoto 能取回同样字节', async () => {
  const db = fakeDb(SCHEMA);
  await seedIdentity(db);
  const reg = await (await report(db, env, mkForm(true))).json();
  assert.equal(reg.ok, true);
  const item = await db.prepare('SELECT id, photo_path FROM items WHERE title=?').bind('Photo item').first();
  assert.ok(item.photo_path, 'photo_path 应写入');
  const stored = await db.prepare('SELECT size, mime FROM photos WHERE path=?').bind(item.photo_path).first();
  assert.ok(stored, '照片字节应落 D1 photos 表');
  assert.equal(stored.mime, 'image/jpeg');
  assert.equal(stored.size, JPEG.byteLength);

  const res = await getPhoto(db, env, new Request('https://x/api/photos/' + item.photo_path),
    item.photo_path.split('/'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  const back = new Uint8Array(await res.arrayBuffer());
  assert.equal(back.byteLength, JPEG.byteLength);
  assert.deepEqual([...back], [...JPEG]);
});

test('无照片登记：不写 photos 表，photo_path 为空', async () => {
  const db = fakeDb(SCHEMA);
  await seedIdentity(db);
  const reg = await (await report(db, env, mkForm(false))).json();
  assert.equal(reg.ok, true);
  const item = await db.prepare('SELECT photo_path FROM items WHERE title=?').bind('Photo item').first();
  assert.equal(item.photo_path, null);
  const n = await db.prepare('SELECT COUNT(*) c FROM photos').first();
  assert.equal(n.c, 0);
});

test('getPhoto：非法路径与不存在的照片都 404', async () => {
  const db = fakeDb(SCHEMA);
  const bad = await getPhoto(db, env, new Request('https://x/api/photos/../etc/passwd'), ['..', 'etc', 'passwd']);
  assert.equal(bad.status, 404);
  const missing = await getPhoto(db, env, new Request('https://x/api/photos/photos/none.jpg'), ['photos', 'none.jpg']);
  assert.equal(missing.status, 404);
});

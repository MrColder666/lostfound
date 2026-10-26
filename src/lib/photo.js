// src/lib/photo.js —— 照片存储：优先 R2（env.PHOTOS），未启用时落 D1（校内规模足够）
// 之前只写 R2，R2 未启用时 `env.PHOTOS?.put()` 静默跳过 → 照片永远 404（"上传不了"）。
const PHOTO_MAX = 1_100_000;   // 与 checkImage 的 1MB 上限留一点余量

export async function putPhoto(db, env, path, bytes, mime) {
  if (bytes.byteLength > PHOTO_MAX) throw new Error('PHOTO_TOO_LARGE');
  if (env && env.PHOTOS) {
    await env.PHOTOS.put(path, bytes, { httpMetadata: { contentType: mime } });
    return 'r2';
  }
  await db.prepare('INSERT OR REPLACE INTO photos(path, mime, size, bytes) VALUES (?,?,?,?)')
    .bind(path, mime, bytes.byteLength, bytes).run();
  return 'd1';
}

function toArrayBuffer(v) {
  if (!v) return null;
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  if (Array.isArray(v)) return new Uint8Array(v).buffer;
  return null;
}

export async function readPhoto(db, env, path) {
  if (env && env.PHOTOS) {
    const obj = await env.PHOTOS.get(path);
    if (!obj) return null;
    return { bytes: await obj.arrayBuffer(), mime: path.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }
  const row = await db.prepare('SELECT mime, bytes FROM photos WHERE path=?').bind(path).first();
  if (!row) return null;
  const ab = toArrayBuffer(row.bytes);
  if (!ab || ab.byteLength === 0) return null;
  return { bytes: ab, mime: row.mime || 'image/jpeg' };
}

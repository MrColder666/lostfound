// src/lib/image.js —— 服务端兜底校验；Exif 由前端 Canvas 重绘根除（public/js/canvas-image.js，T13）
export function sniffImage(u8) {
  if (u8?.length >= 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'jpeg';
  if (u8?.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'png';
  return null;
}
export function checkImage(u8, maxBytes = 1024 * 1024) {
  if (u8?.byteLength > maxBytes) return { ok: false, error: 'TOO_LARGE' }; // 体积先于类型：测试规格 big 全零 → TOO_LARGE
  const kind = sniffImage(u8);
  if (!kind) return { ok: false, error: 'NOT_IMAGE' };
  return { ok: true, kind };
}

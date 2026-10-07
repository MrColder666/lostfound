// public/js/canvas-image.js —— 唯一上传通道：所有照片经此处理，禁止直接 fetch 原文件
export async function sanitize(file, maxSide = 1600) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);   // 重绘 = 元数据全部丢失
  let blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  let q = 0.85;
  while (blob.size > 1024 * 1024 && q > 0.4) {                  // ≤1MB 保证
    q -= 0.15; blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); }
  return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
}

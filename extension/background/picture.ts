// A page's picture made smaller (background/hosted.ts `hostPicture`): at most `width` px wide, JPEG. A full-screen
// window's capture on a Retina display is ~3000 px wide (~22 MB once the card decodes it); the card is faded, so the
// smaller one looks the same there at a quarter of the memory. Where a background has no OffscreenCanvas or
// createImageBitmap (an older engine), the picture as it was.
export async function shrinkPicture(data: string, width: number, quality: number): Promise<string> {
  const g = globalThis as any;
  if (typeof g.OffscreenCanvas !== 'function' || typeof g.createImageBitmap !== 'function' || typeof g.fetch !== 'function') return data;
  const blob = await (await g.fetch(data)).blob();
  const bitmap = await g.createImageBitmap(blob);
  try {
    if (!(bitmap.width > width)) return data;
    const height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
    const canvas = new g.OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return data;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const out: Blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return await new Promise<string>((resolve, reject) => {
      const reader = new g.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(out);
    });
  } finally {
    bitmap.close?.();
  }
}

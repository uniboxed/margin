// Pure helpers for site icons fetched by the background (Safari gives
// extensions no tab.favIconUrl).

const MAX_DOWNLOAD = 512 * 1024; // don't download anything bigger
const MAX_STORED = 24 * 1024; // stored data: URL budget when it can't be shrunk
const SIZE = 32; // stored icons are shrunk to 32×32 when possible

// Image type from the bytes themselves (servers often send icons as
// text/plain or HTML error pages with 200). null = not an image.
function sniffType(bytes: Uint8Array<ArrayBuffer>) {
  const b = bytes;
  const starts = (...sig) => sig.every((v, i) => b[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  // Text formats: skip a UTF-8 byte-order mark (bytes EF BB BF) and whitespace.
  const head = String.fromCharCode(...b.slice(0, 256)).replace(/^\u00ef\u00bb\u00bf/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

function toBase64(bytes: Uint8Array<ArrayBuffer>) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const dataUrl = (type: string, bytes: Uint8Array<ArrayBuffer>) => `data:${type};base64,${toBase64(bytes)}`;

export { MAX_DOWNLOAD, MAX_STORED, SIZE, sniffType, toBase64, dataUrl };

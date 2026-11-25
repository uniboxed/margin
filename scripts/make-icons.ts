// Makes extension/icons/icon-<size>.png (the manifest's icons: Safari's and Chrome's extension lists, the converter's
// Margin.app icon before make-xcode.sh puts brand/margin-logo/macos/AppIcon.appiconset over it) from Margin's logo,
// brand/margin-logo/png (brand/margin-logo/README.md: the printed drawing at 64 px and up, the flat one below).
// The sizes the logo has are copied as they are; 48 and 96 are made with macOS's `sips` (so this runs on a Mac):
// 48 from the flat drawing, 96 from the printed 128. `npm run icons`.
import { copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const png = (name: string) => fileURLToPath(new URL(`../brand/margin-logo/png/${name}`, import.meta.url));
const out = (size: number) => fileURLToPath(new URL(`../extension/icons/icon-${size}.png`, import.meta.url));

for (const size of [16, 32, 128, 256, 512]) copyFileSync(png(`margin-icon-${size}.png`), out(size));
const scaled: [number, string][] = [[48, 'margin-icon-flat-1024.png'], [96, 'margin-icon-128.png']];
for (const [size, from] of scaled) {
  execFileSync('sips', ['-z', String(size), String(size), png(from), '--out', out(size)], { stdio: 'ignore' });
}

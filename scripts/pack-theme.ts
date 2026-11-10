// npm run theme:pack <folder> [out.margintheme]: a theme folder as one
// `.margintheme` file (a zip Margin reads: ui/theme-import.ts), checked
// first as Margin checks an import. Only what a package holds goes in:
// theme.json, theme.html, theme.css, fonts (.woff2), images and notes
// (.txt, .md); anything else is left out and said. Entries are sorted, with
// a fixed date, so the same folder always makes the same file.
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { packageFromFiles, crc32, IMPORT_LIMITS } from '../extension/ui/theme-import.ts';
import { checkPackage, sanitizeTheme } from '../extension/ui/theme-loader.ts';
import { motionAdvice, motionNotes } from './theme-motion.ts';

const KEEP = /^(theme\.(json|html|css)|.+\.(woff2|png|jpe?g|gif|webp|avif|svg|txt|md))$/i;

/** The folder's package files (path → bytes), and what was left out. */
export function folderFiles(dir: string) {
  const files = {};
  const left = [];
  const walk = (sub, depth) => {
    for (const name of readdirSync(join(dir, sub)).sort()) {
      if (name === '.DS_Store') continue;
      const rel = sub ? `${sub}/${name}` : name;
      const st = lstatSync(join(dir, rel));
      if (st.isSymbolicLink()) throw new Error(`${rel} is a link: Margin takes none`);
      if (st.isDirectory()) {
        if (name.startsWith('.')) { left.push(`${rel}/`); continue; }
        if (depth >= IMPORT_LIMITS.depth) throw new Error(`${rel}: more than ${IMPORT_LIMITS.depth} folders deep`);
        walk(rel, depth + 1);
      } else if (st.isFile()) {
        if (KEEP.test(name) && !name.startsWith('.') && (sub || /^theme\.|\.(txt|md)$/i.test(name))) files[rel] = new Uint8Array(readFileSync(join(dir, rel)));
        else left.push(rel);
      }
    }
  };
  walk('', 0);
  return { files, left };
}

/** Files (path → bytes) as zip bytes: deflated, sorted, dated 1 January 2026. */
export function zipFiles(files: Record<string, Uint8Array>) {
  const locals = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const path of Object.keys(files).sort()) {
    const data = files[path];
    const packed = deflateRawSync(data, { level: 9 });
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const name = Buffer.from(path, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE((3 << 8) | 20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(DOS_TIME, 12); cd.writeUInt16LE(DOS_DATE, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); cd.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBytes.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cdBytes, end]));
}

/** Packs a folder: { bytes, id, left, removed }, or throws with what's wrong. */
export function packTheme(dir: string) {
  const { files, left } = folderFiles(dir);
  const read = packageFromFiles(files);
  if (!read.ok) throw new Error(read.errors.join('\n'));
  const caps = checkPackage(read.pkg);
  if (caps.length) throw new Error(caps.join('\n'));
  const report = sanitizeTheme({ ...read.pkg, files: Object.keys(read.pkg.files) });
  if (!report.ok) throw new Error(report.errors.join('\n'));
  const bytes = zipFiles(files);
  if (bytes.length > IMPORT_LIMITS.zipBytes) throw new Error(`the file would be ${bytes.length} bytes, over ${IMPORT_LIMITS.zipBytes}`);
  return { bytes, id: report.manifest.id, version: report.manifest.version, left, removed: report.removed, motion: motionNotes(read.pkg.css) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dirArg, outArg] = process.argv.slice(2);
  if (!dirArg) { console.error('npm run theme:pack <theme folder> [out.margintheme]'); process.exit(2); }
  try {
    const dir = resolve(dirArg);
    const { bytes, id, version, left, removed, motion } = packTheme(dir);
    const out = resolve(outArg ?? `${basename(dir)}.margintheme`);
    writeFileSync(out, bytes);
    console.log(`${out}: ${id} ${version}, ${bytes.length} bytes`);
    if (left.length) console.log(`left out (not part of a theme package): ${left.join(', ')}`);
    if (motion.length) console.log(`Motion that may not be smooth (packed anyway):\n${motionAdvice(motion).join('\n')}`);
    if (removed.length) console.log(`Margin will remove ${removed.length} thing${removed.length === 1 ? '' : 's'} when it loads it:\n${removed.slice(0, 20).map((r) => `  ${r.file}: ${r.kind} ${r.name}: ${r.reason}`).join('\n')}`);
  } catch (err) {
    console.error(`not packed:\n${err.message}`);
    process.exit(1);
  }
}

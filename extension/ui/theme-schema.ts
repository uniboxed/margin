// theme.json, the manifest of a theme package (PLAN.md §3): its schema and
// the check every package goes through, built-in or a user's, on import and
// again at every load.
//
// The schema is data (THEME_SCHEMA, JSON Schema's vocabulary where it has a
// word for it) and `checkManifest` walks it. What JSON Schema can't say is
// written as named checks (`check`): a font file must be a .woff2 the
// package has, a setting's default must fit its type and be a safe CSS value
// (ui/sanitize.ts checkCssValue: no url(), strings, escapes or !important).
//
// What's wrong decides what happens: a missing or bad top-level field (id,
// name, version, format) refuses the theme; a bad entry in a list or map (one
// font, one setting) and an unknown field are removed and reported, so a
// theme from a newer Margin still loads. Pure: runs in Node.
import { LIMITS, checkCssValue, isBundledPath } from './sanitize.ts';

export const MODES = Object.freeze(['fullscreen', 'windowed', 'inpage']);
export const SETTING_TYPES = Object.freeze(['color', 'length', 'number', 'choice', 'toggle']);
const EDGES = ['left', 'right', 'top', 'bottom', 'none'];
// Text a theme shows about itself (Settings): no control characters, no
// markup, and none of the invisible characters that reorder or hide text
// (bidi controls and marks, zero-width characters, the BOM), so a name reads
// as it's stored.
const text = (min, max) => `^[^\\u0000-\\u001f\\u007f<>\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]{${min},${max}}$`;

/**
 * The first key an object of this JSON text has twice (JSON.parse keeps the
 * last, so a reader that takes the first sees another theme), or null.
 * */
export function duplicateKey(json: string): string | null {
  const stack: (Set<any> | null)[] = []; // per open object: its keys; per array: null
  let expectKey = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (expectKey && top) {
        let key;
        try { key = JSON.parse(json.slice(i, j + 1)); } catch { return null; }
        if (top.has(key)) return key;
        top.add(key);
        expectKey = false;
      }
      i = j;
    } else if (c === '{') { stack.push(new Set<any>()); expectKey = true; }
    else if (c === '[') { stack.push(null); expectKey = false; }
    else if (c === '}' || c === ']') { stack.pop(); expectKey = false; }
    else if (c === ',') expectKey = !!stack[stack.length - 1];
  }
  return null;
}

const FONT = Object.freeze({
  type: 'object',
  required: ['family', 'file'],
  properties: {
    family: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$' },
    file: { type: 'string', check: 'bundledFont' },
    weight: { type: ['string', 'number'], pattern: '^\\d{3}( \\d{3})?$', default: '400' },
    style: { enum: ['normal', 'italic'], default: 'normal' },
    unicodeRange: { type: 'string', maxLength: 1024, pattern: '^U\\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?(\\s*,\\s*U\\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?)*$' },
  },
});

const SETTING = Object.freeze({
  type: 'object',
  required: ['type', 'default'],
  check: 'setting',
  properties: {
    type: { enum: SETTING_TYPES },
    default: { type: ['string', 'number', 'boolean'] },
    label: { type: 'string', pattern: text(1, 60) },
    choices: { type: 'array', maxItems: 16, items: { type: ['string', 'number'] } },
    min: { type: 'number' },
    max: { type: 'number' },
    step: { type: 'number', exclusiveMinimum: 0 },
  },
});

/** The schema of theme.json, format 2. */
export const THEME_SCHEMA = Object.freeze({
  title: 'Margin theme manifest (theme.json), format 2',
  type: 'object',
  required: ['id', 'name', 'version'],
  properties: {
    format: { const: 2 },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,40}$' },
    name: { type: 'string', pattern: text(1, 60) },
    version: { type: 'string', pattern: '^\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}$' },
    author: { type: 'string', pattern: text(1, 80) },
    description: { type: 'string', pattern: text(0, 280) },
    licence: { type: 'string', pattern: text(1, 200) },
    // The modes it styles; one it leaves out gets the runtime's defaults.
    modes: { type: 'array', items: { enum: MODES }, maxItems: 3, uniqueItems: true },
    // What Margin needs before the theme renders (first paint, the in-page
    // fallback): where a hidden sidebar is revealed, and its widths.
    layout: {
      type: 'object',
      check: 'layout',
      properties: {
        reveal: { enum: EDGES },
        sidebarMin: { type: 'number', minimum: 0, maximum: 2000 },
        sidebarMax: { type: 'number', minimum: 0, maximum: 2000 },
        sidebarDefault: { type: 'number', minimum: 0, maximum: 2000 },
      },
    },
    // Loaded as FontFace from the package's bytes (no @font-face, no URL).
    fonts: { type: 'array', maxItems: 16, items: FONT, dropBadItems: true },
    // The images the package bundles (png, jpg, gif, webp, avif, svg),
    // which its template and stylesheet may name.
    images: { type: 'array', maxItems: 64, items: { type: 'string', check: 'bundledImage' }, dropBadItems: true, uniqueItems: true },
    // The theme's settings, as CSS variables (`--m-<name>`) and view model
    // values (`settings.<name>`).
    settings: { type: 'object', maxProperties: 32, propertyNames: { pattern: '^[a-z][A-Za-z0-9]{0,31}$' }, additionalProperties: SETTING, dropBadItems: true },
  },
});

const FONT_EXT = /\.woff2$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeOk = (want, v) => [].concat(want).some((t) => t === typeOf(v) || (t === 'number' && typeof v === 'number' && Number.isFinite(v)));

/**
 * Whether a setting's value is good for its spec: the right kind of value,
 * and safe as a CSS variable. Theme defaults and the user's saved values
 * both go through this.
 * */
export function settingValueOk(spec: { type: string, choices?: any[], min?: number, max?: number }, value: any) {
  switch (spec?.type) {
    case 'toggle': return typeof value === 'boolean';
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
      return Number.isFinite(n) && (spec.min == null || n >= spec.min) && (spec.max == null || n <= spec.max);
    }
    case 'length': {
      if (value === 0 || value === '0') return true;
      if (typeof value !== 'string' || !checkCssValue(value)) return false;
      const m = /^(-?\d+(?:\.\d+)?)(px|em|rem|%|vw|vh|vmin|vmax|ch)$/.exec(value.trim());
      if (!m) return false;
      const n = Number(m[1]);
      return (spec.min == null || n >= spec.min) && (spec.max == null || n <= spec.max);
    }
    case 'color':
      // A color: #hex, a color function, or a name. Checked as a CSS value
      // first (no url(), strings, escapes, !important).
      return typeof value === 'string' && checkCssValue(value)
        && /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(.*\)|[a-zA-Z]+)$/.test(value.trim());
    case 'choice':
      return (typeof value === 'string' || typeof value === 'number') && checkCssValue(value)
        && Array.isArray(spec.choices) && spec.choices.includes(value);
    default: return false;
  }
}

// The named checks: null when fine, else why not.
const CHECKS = {
  bundledFont: (v, ctx) => (isBundledPath(v, ctx.files) && FONT_EXT.test(v) ? null : 'must be a bundled .woff2'),
  bundledImage: (v, ctx) => (isBundledPath(v, ctx.files) && IMAGE_EXT.test(v) ? null : 'must be a bundled png, jpg, gif, webp, avif or svg'),
  setting: (v) => {
    if (v.type === 'choice') {
      if (!Array.isArray(v.choices) || !v.choices.length) return 'a choice needs choices';
      if (!v.choices.every((c) => checkCssValue(c))) return 'a choice must be a plain CSS value';
    }
    if (v.min != null && v.max != null && v.min > v.max) return 'min above max';
    return settingValueOk(v, v.default) ? null : 'bad default for its type (a plain CSS value: no url(), strings, escapes or !important)';
  },
  layout: (v) => {
    const { sidebarMin: lo, sidebarMax: hi, sidebarDefault: d } = v;
    if (lo != null && hi != null && lo > hi) return 'sidebarMin above sidebarMax';
    if (d != null && ((lo != null && d < lo) || (hi != null && d > hi))) return 'sidebarDefault outside sidebarMin…sidebarMax';
    return null;
  },
};

/**
 * Checks one value against a schema node. Returns the value as kept (unknown
 * fields and bad list or map entries removed, defaults filled in), or
 * `undefined` with a reason in `fail`.
 */
function walk(node, value, at, ctx, fail) {
  if ('const' in node && value !== node.const) return fail(`must be ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(value)) return fail(`must be one of ${node.enum.join(', ')}`);
  if (node.type && !typeOk(node.type, value)) return fail(`must be ${[].concat(node.type).join(' or ')}`);
  if (node.pattern && !new RegExp(node.pattern).test(String(value))) return fail('bad value');
  if (node.maxLength != null && String(value).length > node.maxLength) return fail('too long');
  if (node.minimum != null && value < node.minimum) return fail(`below ${node.minimum}`);
  if (node.maximum != null && value > node.maximum) return fail(`above ${node.maximum}`);
  if (node.exclusiveMinimum != null && value <= node.exclusiveMinimum) return fail(`must be above ${node.exclusiveMinimum}`);
  let out = value;
  if (Array.isArray(value)) {
    if (node.maxItems != null && value.length > node.maxItems) {
      if (!node.dropBadItems) return fail(`more than ${node.maxItems} entries`);
      for (let i = node.maxItems; i < value.length; i++) ctx.drop(`${at}[${i}]`, `more than ${node.maxItems} entries`);
    }
    out = [];
    const seen = new Set<any>();
    for (const [i, item] of value.slice(0, node.maxItems ?? value.length).entries()) {
      let why: string | null = null;
      const kept = node.items ? walk(node.items, item, `${at}[${i}]`, ctx, (reason) => { why = reason; }) : item;
      if (why == null && node.uniqueItems && seen.has(JSON.stringify(kept))) why = 'repeated';
      if (why != null) {
        if (!node.dropBadItems) return fail(`[${i}] ${why}`);
        ctx.drop(`${at}[${i}]`, why);
        continue;
      }
      seen.add(JSON.stringify(kept));
      out.push(kept);
    }
  } else if (value !== null && typeof value === 'object') {
    out = {};
    for (const key of node.required ?? []) if (!Object.prototype.hasOwnProperty.call(value, key)) return fail(`${key} missing`);
    const entries = Object.entries(value);
    let count = 0;
    for (const [key, v] of entries) {
      const name = at ? `${at}.${key}` : key;
      const known = node.properties && Object.prototype.hasOwnProperty.call(node.properties, key) ? node.properties[key] : null;
      const child = known ?? node.additionalProperties ?? null;
      if (!child) { ctx.drop(name, 'unknown field'); continue; }
      if (!known && node.propertyNames && !new RegExp(node.propertyNames.pattern).test(key)) {
        if (!node.dropBadItems) return fail(`bad name ${JSON.stringify(key)}`);
        ctx.drop(name, 'bad name');
        continue;
      }
      if (!known && node.maxProperties != null && count >= node.maxProperties) { ctx.drop(name, `more than ${node.maxProperties} entries`); continue; }
      let why: string | null = null;
      const kept = walk(child, v, name, ctx, (reason) => { why = reason; });
      if (why != null) {
        if (!known && node.dropBadItems) { ctx.drop(name, why); continue; }
        return fail(known ? `${key}: ${why}` : `${key}: ${why}`);
      }
      out[key] = kept;
      if (!known) count++;
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (!(key in out) && 'default' in child) out[key] = child.default;
    }
  }
  if (typeof out === 'number' && ([] as string[]).concat(node.type ?? []).includes('string') && node.pattern) out = String(out); // a font weight given as 400
  if (node.check) {
    const why = CHECKS[node.check](out, ctx);
    if (why) return fail(why);
  }
  return out;
}

/**
 * Checks a theme's manifest (the text of theme.json) against THEME_SCHEMA.
 * `files`: the package's file paths (fonts and images must be among them).
 * */
export function checkManifest(text: string, { files = [] }: { files?: string[] | Set<string> } = {}): { manifest: any, removed: { kind: string, name: string, reason: string }[], errors: string[] } {
  const removed: { kind: string; name: any; reason: any; }[] = [];
  const errors: string[] = [];
  let raw;
  try {
    if (typeof text !== 'string' || text.length > LIMITS.manifestBytes) throw new Error(`not text, or larger than ${LIMITS.manifestBytes} bytes`);
    raw = JSON.parse(text);
  } catch (e) {
    return { manifest: null, removed, errors: [`theme.json: ${e.message}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { manifest: null, removed, errors: ['theme.json: not an object'] };
  const twice = duplicateKey(text);
  if (twice !== null) return { manifest: null, removed, errors: [`theme.json: the key ${JSON.stringify(twice.slice(0, 40))} appears twice in one object`] };
  const kindOf = (name) => (/^fonts\[/.test(name) ? 'font' : /^settings\./.test(name) ? 'setting' : /^images\[/.test(name) ? 'image' : 'manifest');
  const ctx = { files, drop: (name, reason) => removed.push({ kind: kindOf(name), name, reason }) };
  // Field by field at the top, so every bad one is said, not just the first.
  const manifest: Record<string, any> = {};
  for (const key of THEME_SCHEMA.required) if (!(key in raw)) errors.push(`theme.json: ${key} missing`);
  for (const [key, value] of Object.entries(raw)) {
    const node = Object.prototype.hasOwnProperty.call(THEME_SCHEMA.properties, key) ? THEME_SCHEMA.properties[key] : null;
    if (!node) { ctx.drop(key, 'unknown field'); continue; }
    let why: string | null = null;
    const kept = walk(node, value, key, ctx, (reason) => { why = reason; });
    if (why != null) errors.push(`theme.json: bad ${key} (${why})`);
    else manifest[key] = kept;
  }
  manifest.fonts ??= [];
  manifest.images ??= [];
  manifest.settings ??= {};
  manifest.modes ??= [...MODES];
  manifest.layout ??= {};
  return { manifest: errors.length ? null : manifest, removed, errors };
}

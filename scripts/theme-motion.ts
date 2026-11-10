// Advice for theme authors (npm run theme:pack): motion that makes the browser lay the theme out again on every
// frame. Transitions and @keyframes of `transform`, `translate`, `scale`, `rotate` and `opacity` run on the
// compositor and stay smooth; `left`, `width`, `margin` and the like re-run layout each frame, which drops frames
// on a busy machine (issue #14). Nothing is refused: these are notes, the theme works either way.

// Properties whose animation re-runs layout (a property's longhands are matched by prefix: margin-left…).
const LAYOUT = ['left', 'right', 'top', 'bottom', 'inset', 'width', 'height', 'min-width', 'min-height', 'max-width',
  'max-height', 'margin', 'padding', 'border-width', 'font-size', 'line-height', 'flex', 'flex-basis', 'gap',
  'grid-template-columns', 'grid-template-rows', 'letter-spacing', 'word-spacing'];
const lays = (prop: string) => prop === 'all' || LAYOUT.some((p) => prop === p || prop.startsWith(`${p}-`));

export type MotionNote = { line: number, what: 'transition' | 'animation', property: string };

const lineAt = (css: string, index: number) => css.slice(0, index).split('\n').length;
// Comments out (kept as spaces, so indexes and lines stay where they were).
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

/** The transitions and keyframes of a theme's CSS that animate layout, each with its line. */
export function motionNotes(source: string): MotionNote[] {
  const css = uncommented(source);
  const notes: MotionNote[] = [];
  // transition / transition-property: the first word of each comma-separated item is its property.
  for (const m of css.matchAll(/(?:^|[;{\s])transition(-property)?\s*:\s*([^;}]+)/g)) {
    for (const item of m[2].split(',')) {
      const prop = item.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (prop && lays(prop)) notes.push({ line: lineAt(css, m.index! + m[0].indexOf('transition')), what: 'transition', property: prop });
    }
  }
  // @keyframes: every property set inside one.
  for (const m of css.matchAll(/@keyframes\s+[^{]+\{/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    const body = css.slice(start, i - 1);
    const seen = new Set<string>();
    for (const d of body.matchAll(/([a-z-]+)\s*:/g)) {
      const prop = d[1].toLowerCase();
      if (lays(prop) && !seen.has(prop)) {
        seen.add(prop);
        notes.push({ line: lineAt(css, start + d.index!), what: 'animation', property: prop });
      }
    }
  }
  return notes.sort((a, b) => a.line - b.line);
}

/** The notes as lines for the packer's output. */
export function motionAdvice(notes: MotionNote[], file = 'theme.css'): string[] {
  return notes.map((n) => `  ${file}:${n.line}: ${n.what === 'transition' ? 'a transition of' : 'keyframes that animate'} ${n.property === 'all' ? '`all` (every property, layout too)' : `\`${n.property}\``}: the browser lays the theme out again each frame; \`transform\`, \`translate\` or \`opacity\` stay smooth`);
}

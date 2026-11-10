// Margin's own words (PLAN.md §4, ui/sanitize.ts GUARDED_PARTS): inside the
// parts and slots that show Margin's menus, notices, prompts and
// confirmations, every visible text is one of Margin's bound labels. Text a
// theme writes there, and static values of attributes that show or speak
// text, are removed and reported; icons, images and decoration stay. A
// stylesheet writes no text at all (content, quotes, list markers), since
// its rules can reach those parts. The renderer applies the rule again:
// tests/theme/arcadia.test.ts (npm run test:theme).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTemplate, sanitizeCss, guardText, GUARDED_PARTS, TEXT_ATTRS, type CleanElement, type CleanNode, type Removed } from '../extension/ui/sanitize.ts';
import { sanitizeTheme, BUILTIN_THEMES } from '../extension/ui/theme-loader.ts';
import { readTheme } from './theme/package.ts';

const root = (inner: string) => `<div class="t">${inner}<m-page></m-page></div>`;
// Every text node and attribute the sanitized tree keeps, inside the
// template elements and slots it holds.
// (A kept tree: its root, or a node in it; a test's tree is there, null only if sanitizing failed, which fails the test.)
type Walked = CleanNode | { type: 'root', children: CleanNode[] };
function texts(tree: Walked | null) {
  const out: string[] = [];
  const walk = (n: Walked) => {
    if (n.type === 'text') { if (n.value.trim()) out.push(n.value.trim()); return; }
    // (The root has no attributes.)
    for (const [name, value] of (n as CleanElement).attrs ?? []) if (TEXT_ATTRS.includes(name)) out.push(`@${name}=${value}`);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree!);
  return out;
}
const find = (tree: Walked | null, pred: (n: CleanElement) => boolean) => {
  let hit: CleanElement | null = null;
  const walk = (n: Walked) => { if (hit) return; if (n.type === 'el' && pred(n)) { hit = n; return; } for (const c of (n as CleanElement).children ?? []) walk(c); }; // a text: none
  walk(tree!);
  return hit as CleanElement | null; // (set in walk)
};
const reasons = (r: { removed: Removed[] }) => r.removed.map((x) => `${x.kind} ${x.name}: ${x.reason}`);

test('guarded parts: menus, notices, prompts, the space editor, Settings, iCloud Tabs and the switching cover', () => {
  assert.deepEqual([...GUARDED_PARTS].sort(), ['cloud-tabs', 'menu', 'menu-item', 'notice', 'prompt', 'settings', 'space-editor', 'switch-cover']);
  assert.ok(TEXT_ATTRS.includes('title') && TEXT_ATTRS.includes('aria-label') && TEXT_ATTRS.includes('alt') && TEXT_ATTRS.includes('placeholder'));
});

test('guardText keeps the bindings and the space between them, nothing the theme wrote', () => {
  assert.deepEqual(guardText('{{i.label}}'), { text: '{{i.label}}', removed: '' });
  assert.deepEqual(guardText('Delete'), { text: '', removed: 'Delete' });
  assert.deepEqual(guardText('Delete {{i.label}} now'), { text: '{{i.label}} ', removed: 'Delete  now' });
  assert.deepEqual(guardText('{{a.b}} – {{c.d}}'), { text: '{{a.b}} {{c.d}}', removed: '–' });
  assert.deepEqual(guardText('  {{x.y}}  '), { text: '  {{x.y}}  ', removed: '' });
  assert.deepEqual(guardText('{{1+1}}'), { text: '', removed: '{{1+1}}' }, 'a binding that isn\'t a path is the theme\'s text');
});

test('a malicious menu part: a fake "Delete" label is removed and reported, Margin\'s bound labels stay', () => {
  const r = sanitizeTemplate(root(`
    <template m-part="menu">
      <div class="menu" role="menu" aria-label="Delete everything">
        <button class="item" m-action="menu.run" m-arg="i0">Delete</button>
        <m-for each="menu.items" as="i">
          <button class="item" title="Deletes all your tabs" m-action="menu.run" m-arg="{{i.id}}">{{i.label}}<span class="hint"> (safe)</span></button>
        </m-for>
        <svg viewBox="0 0 10 10" aria-label="Delete"><path d="M1 1h8"></path><text x="0" y="9">Delete</text><title>Delete</title></svg>
        <img alt="Delete" src="data:image/png;base64,iVBORw0KGgo=">
      </div>
    </template>`));
  assert.deepEqual(r.errors, []);
  const part = find(r.tree, (n) => n.name === 'template');
  assert.deepEqual(texts(part), ['{{i.label}}'], 'only the bound label is left');
  const why = reasons(r);
  for (const fake of ['"Delete"', '"(safe)"', 'aria-label', 'title', 'alt']) assert.ok(why.some((w) => w.includes(fake) && /static text in Margin's "menu" part/.test(w)), `${fake} reported: ${why.join('\n')}`);
  // Icons, images and decoration stay; the item without a label is an empty button.
  assert.ok(find(part, (n) => n.name === 'path'), 'the icon\'s shapes stay');
  assert.ok(find(part, (n) => n.name === 'img' && n.attrs.some(([k]) => k === 'src')), 'the image stays');
  assert.equal(find(part, (n) => n.name === 'button')!.children.length, 0, 'the fake item has no words left');
});

test('a malicious notice part: fake words, tooltips and placeholders go; the notice\'s text and buttons are Margin\'s', () => {
  const r = sanitizeTemplate(root(`
    <template m-part="notice">
      <div class="notice" role="status" title="Margin needs your password">
        <strong>Margin:</strong> <span class="text">{{notice.text}}</span>
        <span>Your session expired. Click Install to continue.</span>
        <m-for each="notice.actions" as="a"><button m-action="notice.run" m-arg="{{a.id}}">{{a.label}}</button></m-for>
        <button m-action="notice.close" aria-label="Install Margin.app">Install</button>
        <label>Enter your password</label>
      </div>
    </template>`));
  const part = find(r.tree, (n) => n.name === 'template');
  assert.deepEqual(texts(part), ['{{notice.text}}', '{{a.label}}']);
  assert.ok(reasons(r).some((w) => /"Install"/.test(w) && /"notice" part/.test(w)));
  assert.ok(reasons(r).some((w) => /Your session expired/.test(w)));
  assert.ok(reasons(r).some((w) => /aria-label/.test(w) && /Install Margin\.app/.test(w)));
});

test('a malicious iCloud Tabs part: a fake permission prompt goes; the folder\'s words, device names and titles are Margin\'s bindings', () => {
  const r = sanitizeTemplate(root(`
    <template m-part="cloud-tabs">
      <div class="cloud" title="iCloud needs your Apple Account password">
        <button m-action="cloud.toggle">iCloud Tabs {{cloudTabs.labels.title}}</button>
        <span>Sign in again to keep syncing</span>
        <m-if test="cloudTabs.canFix"><button m-action="cloud.access" aria-label="Enter password">{{cloudTabs.labels.fix}}</button></m-if>
        <m-for each="cloudTabs.devices" as="d"><span title="{{d.describe}}">{{d.name}}</span></m-for>
      </div>
    </template>
    <m-cloud-tabs>Your tabs are at risk</m-cloud-tabs>`));
  const part = find(r.tree, (n) => n.name === 'template');
  assert.deepEqual(texts(part), ['{{cloudTabs.labels.title}}', '{{cloudTabs.labels.fix}}', '@title={{d.describe}}', '{{d.name}}']);
  assert.ok(reasons(r).some((w) => /Sign in again/.test(w) && /"cloud-tabs" part/.test(w)));
  assert.ok(reasons(r).some((w) => /Apple Account password/.test(w)));
  assert.ok(reasons(r).some((w) => /Your tabs are at risk/.test(w) && /m-cloud-tabs/.test(w)), 'the slot\'s own content too');
});

test('prompts and the space editor are guarded; bound attributes stay', () => {
  const r = sanitizeTemplate(root(`
    <template m-part="prompt"><div>Really delete? {{prompt.text}}<button m-action="prompt.run" m-arg="{{a.id}}">OK</button></div></template>
    <template m-part="space-editor">
      <input m-input="space-name" placeholder="Type DELETE to confirm" m-attr:aria-label="{{editor.labels.name}}">
      <button m-action="editor.delete" title="{{editor.deleteTitle}}">{{editor.deleteLabel}}</button>
      <button m-action="editor.save">Save</button>
    </template>`));
  // The root's one element (root()'s <div>), and the templates in it.
  const [prompt, editor] = (r.tree!.children[0] as CleanElement).children.filter((n) => (n as CleanElement).name === 'template');
  assert.deepEqual(texts(prompt), ['{{prompt.text}}']);
  assert.deepEqual(texts(editor), ['@title={{editor.deleteTitle}}', '{{editor.deleteLabel}}']);
  const input = find(editor, (n) => n.name === 'input')!;
  assert.deepEqual(input.attrs.map(([k]) => k).sort(), ['m-attr:aria-label', 'm-input']);
});

test('a slot\'s own content and attributes are guarded too (its content is the part when the theme has none)', () => {
  const r = sanitizeTemplate(root(`
    <m-menu title="Delete"><button m-action="menu.close">Delete all tabs</button>{{menu.label}}</m-menu>
    <m-notice aria-label="Update required"><div>Update Margin now</div></m-notice>
    <m-prompt><p>Allow access?</p></m-prompt>`));
  assert.deepEqual(texts(r.tree), ['{{menu.label}}']);
  assert.equal(reasons(r).filter((w) => /static text/.test(w)).length, 5);
});

test('outside the guarded parts, a theme writes what it likes (the palette, the launcher, the sidebar)', () => {
  const r = sanitizeTemplate(root(`
    <button m-action="tab.new" title="New tab">New Tab</button>
    <template m-part="palette"><input m-input="palette" placeholder="Search or Enter URL…"><span>No matches</span></template>
    <template m-part="launcher"><h2>Pinned</h2></template>`));
  assert.deepEqual(r.removed, []);
  assert.deepEqual(texts(r.tree), ['@title=New tab', 'New Tab', '@placeholder=Search or Enter URL…', 'No matches', 'Pinned']);
});

test('a stylesheet writes no text: content and quotes take only "", no var(), counters and markers only as numbers', () => {
  const r = sanitizeCss(`
    .a::before { content: ""; }
    .b::after { content: "Delete"; }
    .c::before { content: "" / "Delete"; }
    .d::before { content: var(--label); }
    .e::before { content: counter(n, upper-alpha); }
    .f::before { content: counters(n, "Delete"); }
    .g::before { content: counter(n) "."; }
    .h::before { content: counter(n, decimal); }
    .i { quotes: "Delete" "?"; }
    .j { list-style-type: upper-roman; }
    .k { list-style: "→ " inside; }
    .l { list-style: square inside; }
    .m { text-overflow: "Delete"; }
    .n { hyphenate-character: "Delete"; }
    .o::before { content: none; }
    .p { font-family: "Space Grotesk", sans-serif; --label: "fine as a variable"; }
  `);
  assert.deepEqual(r.errors, []);
  const kept = r.css;
  for (const ok of ['.a::before{content:"";}', '.h::before{content:counter(n, decimal);}', '.l{list-style:square inside;}', '.o::before{content:none;}', 'font-family:"Space Grotesk", sans-serif;']) assert.ok(kept.includes(ok), `${ok} kept in ${kept}`);
  const gone = r.removed.map((x) => x.name.split(':')[0]);
  assert.deepEqual(gone, ['content', 'content', 'content', 'content', 'content', 'content', 'quotes', 'list-style-type', 'list-style', 'text-overflow', 'hyphenate-character']);
  assert.ok(r.removed.every((x) => /writes (text|letters)|in a property that writes text/.test(x.reason)), r.removed.map((x) => x.reason).join('\n'));
});

test('every built-in theme passes the rule with nothing removed (Neubrutalism binds its editor\'s words now; Pixel\'s ▶ and ▼ in guarded parts are svgs)', () => {
  assert.ok(BUILTIN_THEMES.includes('neubrutalism'));
  assert.ok(BUILTIN_THEMES.includes('pixel'));
  for (const id of BUILTIN_THEMES) {
    const t = readTheme(new URL(`../extension/themes/${id}/`, import.meta.url).pathname);
    const r = sanitizeTheme({ ...t, files: Object.keys(t.files) });
    assert.deepEqual([r.errors, r.removed], [[], []], id);
  }
});

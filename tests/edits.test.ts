// content/edits.ts: what the user typed into a page and hasn't sent, which
// keeps its tab awake (background/sleep.ts). Against a small fake of a page:
// its fields, its window's events, its readyState.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchEdits } from '../extension/content/edits.ts';

// A field: 'text' (a textarea or a text input), 'select', 'checkbox' or 'editor'.
type Kind = 'text' | 'select' | 'checkbox' | 'editor';
// What content/edits.ts reads of a field.
interface FakeField {
  kind: Kind, value: string, defaultValue: string, textContent: string, checked: boolean, defaultChecked: boolean, options: unknown[],
  isConnected: boolean, isContentEditable: boolean, hasAttribute(name: string): boolean, matches(selector: string): boolean,
  closest(selector: string): FakeField | null,
}
function field(kind: Kind, props: { value?: string, defaultValue?: string, textContent?: string } = {}) {
  const el: FakeField = {
    kind,
    value: '',
    defaultValue: '',
    textContent: '',
    checked: false,
    defaultChecked: false,
    options: [],
    isConnected: true,
    isContentEditable: kind === 'editor',
    hasAttribute: (name: string) => kind === 'editor' && name === 'contenteditable',
    matches(selector: string) {
      if (selector === 'select') return kind === 'select';
      if (selector.startsWith('input[type=checkbox]')) return kind === 'checkbox';
      if (selector.startsWith('textarea, select, input')) return kind !== 'editor'; // FIELDS
      return false;
    },
    closest: (selector: string) => (kind === 'editor' && selector.startsWith('[contenteditable]') ? el : null),
    ...props,
  };
  return el;
}
// A page: its fields, `readyState` as the watch starts.
function page({ readyState = 'loading', fields = [] }: { readyState?: string, fields?: FakeField[] } = {}) {
  const listeners: Record<string, ((event: object) => void)[]> = {};
  const win = { addEventListener: (type: string, fn: (event: object) => void) => (listeners[type] ??= []).push(fn) };
  const doc = {
    readyState,
    querySelectorAll(selector: string) {
      if (selector.startsWith('iframe')) return [];
      if (selector.startsWith('textarea, input')) return fields.filter((f) => f.kind === 'text');
      if (selector.startsWith('[contenteditable]')) return fields.filter((f) => f.kind === 'editor');
      if (selector === 'select') return fields.filter((f) => f.kind === 'select');
      if (selector.startsWith('input[type=checkbox]')) return fields.filter((f) => f.kind === 'checkbox');
      return [];
    },
  };
  const fire = (type: string, target: FakeField, trusted = true) => (listeners[type] ?? []).forEach((fn) => fn({ type, isTrusted: trusted, target, composedPath: () => [target] }));
  // As the watch takes them: a fake can't be a whole Window or Document (it has what edits.ts reads).
  return { win: win as unknown as Window, doc: doc as unknown as Document, fire };
}
// The user types `text` into a field, as a browser reports it: focus, then
// beforeinput (the field as it was), the value, input.
function type(p: ReturnType<typeof page>, el: FakeField, text: string, { focus = true } = {}) {
  if (focus) p.fire('focusin', el);
  p.fire('beforeinput', el);
  el.value = text;
  p.fire('input', el);
}

test('a React-controlled field (its value attribute kept in step with its value): a draft typed into it still counts', () => {
  const p = page();
  const box = field('text');
  const edited = watchEdits(p.win, p.doc);
  type(p, box, 'Dear Sam,');
  box.defaultValue = box.value; // React's sync of the value attribute
  assert.equal(edited(), true, 'the draft is there, whatever its defaultValue says');
  box.value = '';
  assert.equal(edited(), false, 'sent and emptied: no draft');
});

test('a field the page filled: only focusing it isn\'t a draft; typing into it is; typed back to what the page had isn\'t', () => {
  const p = page();
  const search = field('text', { value: 'the page\'s query', defaultValue: 'the page\'s query' });
  const edited = watchEdits(p.win, p.doc);
  p.fire('focusin', search);
  assert.equal(edited(), false);
  type(p, search, 'the page\'s query, then mine', { focus: false });
  search.defaultValue = search.value;
  assert.equal(edited(), true);
  type(p, search, 'the page\'s query', { focus: false });
  assert.equal(edited(), false, 'what it held when the user came to it');
  // Focused again later: what it held then doesn't replace the first look.
  type(p, search, 'mine again', { focus: false });
  p.fire('focusin', search);
  assert.equal(edited(), true);
});

test('a field typed into with no focus or beforeinput seen first (the watch started meanwhile, autofill): any text counts', () => {
  const p = page();
  const box = field('text');
  const edited = watchEdits(p.win, p.doc);
  box.value = 'filled';
  box.defaultValue = 'filled';
  p.fire('input', box);
  assert.equal(edited(), true);
});

test('events a page sends itself, and its own values, aren\'t the user\'s; choices count from what they were when the user came to them; editors while they hold text', () => {
  const p = page();
  const box = field('text');
  const choice = field('checkbox');
  const editor = field('editor');
  const edited = watchEdits(p.win, p.doc);
  p.fire('focusin', box, false);
  box.value = 'set by the page';
  p.fire('input', box, false);
  assert.equal(edited(), false, 'untrusted');
  p.fire('focusin', choice);
  choice.checked = true;
  choice.defaultChecked = true; // (as React may keep it)
  p.fire('change', choice);
  assert.equal(edited(), true, 'changed from what it was');
  choice.checked = false;
  assert.equal(edited(), false);
  editor.textContent = 'notes';
  p.fire('input', editor);
  assert.equal(edited(), true);
  editor.textContent = '  ';
  assert.equal(edited(), false);
});

test('a watch started after the page loaded (Margin installed or updated into an open page): text already typed there counts, judged generously, but not the page\'s own text in a field the cursor isn\'t in; one from the page\'s start doesn\'t look at fields not typed into', () => {
  const draft = field('text', { value: 'typed before Margin came', defaultValue: '' });
  const late = page({ readyState: 'complete', fields: [draft] });
  const lateEdited = watchEdits(late.win, late.doc);
  assert.equal(lateEdited.late, true);
  assert.equal(lateEdited(), true, 'no input seen, but text in a field');
  draft.value = '';
  assert.equal(lateEdited(), false);
  // A results page's query in its search box (Google's): the page's own.
  const query = field('text', { value: 'what was searched', defaultValue: 'what was searched' });
  const results = page({ readyState: 'complete', fields: [query] });
  assert.equal(watchEdits(results.win, results.doc)(), false, 'the page\'s own text');
  // A React app's draft typed before Margin came (its value attribute kept in
  // step): kept awake while the cursor is in it.
  (results.doc as { activeElement?: unknown }).activeElement = query; // a plain field on the fake (Document's is read-only)
  assert.equal(watchEdits(results.win, results.doc)(), true, 'the field with the focus');
  const editor = field('editor', { textContent: 'a draft in an editor' });
  const lateEditor = page({ readyState: 'interactive', fields: [editor] });
  assert.equal(watchEdits(lateEditor.win, lateEditor.doc)(), true);
  const early = page({ readyState: 'loading', fields: [field('text', { value: 'the page\'s own' })] });
  const earlyEdited = watchEdits(early.win, early.doc);
  assert.equal(earlyEdited.late, false);
  assert.equal(earlyEdited(), false);
});

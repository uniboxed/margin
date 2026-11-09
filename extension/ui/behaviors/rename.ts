// A name edited in place (themes/arcadia/sidebar.js, "renaming a folder in
// place"): `m-rename="folder"` on the element showing a folder's name,
// `m-rename="space"` on a space's (its chip's, or the space shown's when
// it's in no list). A double-click on it, or on its folder's row (whose
// first click toggled the folder: undone), the menu's Rename, or a folder
// just made, edits it there: the element itself becomes editable (plain
// text, the theme's own look, with the class `m-renaming`), its name
// selected. Enter or leaving the field saves (renameFolder / renameSpace,
// trimmed, at most 40 characters, not when empty or unchanged), Escape
// puts it back. Saved, the new name shows at once (ui/runtime.ts), not the
// old one until storage comes back. A double-click on a space's chip opens
// the space editor (as today).
import type { Rt } from '../runtime.ts';
import { NAME_MAX } from '../actions.ts';

const UNDO_TOGGLE_MS = 800;

export function installRename(rt: Rt) {
  const { view, doc, container } = rt;
  let editing: { kind: 'folder' | 'space', id: string, el: HTMLElement, saved: Node[], was: string, ending: boolean } | null = null;
  let wanted: { kind: 'folder' | 'space', id: string, until: number } | null = null; // one to edit once it's drawn (a folder just made)

  // The m-rename element for a folder or space, if it's drawn.
  function elementFor(kind: 'folder' | 'space', id: string) {
    for (const el of view.marked('m-rename', kind)) {
      const item = view.subjectOf(el);
      if (kind === 'folder' ? item?.id === id : (item?.id ?? rt.vm?.space?.id) === id) return (el as HTMLElement);
    }
    return null;
  }
  const nameOf = (kind: 'folder' | 'space', id: string) => {
    const state = rt.viewState();
    const list = kind === 'folder' ? state?.folders : state?.spaces;
    return list?.find((x) => x.id === id)?.name ?? null;
  };

  function start(kind: 'folder' | 'space', id: string) {
    if (editing) commit();
    const el = elementFor(kind, id);
    const name = nameOf(kind, id);
    if (name == null) return false;
    if (!el) { wanted = { kind, id, until: Date.now() + 3000 }; return true; }
    wanted = null;
    rt.behaviors.menus?.close();
    const saved = [...el.childNodes];
    editing = { kind, id, el, saved, was: name, ending: false };
    el.replaceChildren(doc.createTextNode(name));
    try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.spellcheck = false;
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-label', kind === 'folder' ? 'Folder name' : 'Space name');
    el.classList.add('m-renaming');
    el.addEventListener('keydown', onKey);
    el.addEventListener('blur', onBlur);
    el.addEventListener('paste', onPaste);
    el.focus({ preventScroll: true });
    try { (container as any).getSelection?.()?.selectAllChildren?.(el) ?? doc.getSelection()?.selectAllChildren(el); } catch {}
    rt.setUi({ editing: { kind, id } });
    return true;
  }
  function stop() {
    const e = editing;
    if (!e) return null;
    editing = null;
    e.ending = true;
    e.el.removeEventListener('keydown', onKey);
    e.el.removeEventListener('blur', onBlur);
    e.el.removeEventListener('paste', onPaste);
    const typed = e.el.textContent ?? '';
    e.el.removeAttribute('contenteditable');
    e.el.removeAttribute('role');
    e.el.removeAttribute('aria-label');
    e.el.removeAttribute('spellcheck');
    e.el.classList.remove('m-renaming');
    e.el.replaceChildren(...e.saved);
    if (e.el.isConnected && (container as any).activeElement === e.el) e.el.blur();
    rt.setUi({ editing: null });
    return { ...e, typed };
  }
  function commit() {
    const e = stop();
    if (!e) return;
    const name = e.typed.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    if (!name || name === e.was) return;
    if (e.kind === 'folder') rt.dispatch('folder.setName', { folder: e.id, name }, 'behavior');
    else rt.dispatch('space.setName', { space: e.id, name }, 'behavior');
  }
  const cancel = () => { stop(); };
  function onKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  }
  function onBlur() { if (editing && !editing.ending) commit(); }
  // Plain text only, on one line, where 'plaintext-only' isn't supported.
  function onPaste(event: ClipboardEvent) {
    const text = event.clipboardData?.getData('text/plain');
    if (text == null) return;
    event.preventDefault();
    doc.execCommand?.('insertText', false, text.replace(/\s+/g, ' '));
  }

  rt.listen(container, 'dblclick', (e: MouseEvent) => {
    if (!view.owns(e.target) || (editing && editing.el.contains((e.target as Node)))) return;
    const own = view.behaviorAt(e.target, 'm-rename');
    if (own) {
      const item = view.subjectOf(own.el);
      const kind = own.value;
      const id = kind === 'space' ? item?.id ?? rt.vm?.space?.id : item?.id;
      if ((kind === 'folder' || kind === 'space') && id != null) {
        e.stopPropagation();
        if (kind === 'folder') undoToggle(id);
        start(kind, id);
      }
      return;
    }
    const hit = view.actionAt(e.target);
    if (hit?.name === 'folder.toggle') {
      // A folder's row: its name.
      const el = view.marked('m-rename', 'folder').find((r) => hit.el.contains(r) || r.contains(hit.el));
      if (!el) return;
      e.stopPropagation();
      undoToggle(hit.arg);
      start('folder', hit.arg as string); // (its folder's id; none: no folder has it)
    } else if (hit?.name === 'space.switch' || hit?.name === 'space.edit') {
      e.stopPropagation();
      rt.dispatch('space.edit', hit.arg, 'behavior');
    }
  });
  // Its first click toggled it: back as it was.
  function undoToggle(folderId: unknown) {
    const t = rt.lastToggle;
    if (t && t.folderId === folderId && Date.now() - t.at < UNDO_TOGGLE_MS) void rt.host.send('setFolderOpen', { folderId, open: t.wasOpen });
  }

  return {
    start,
    /** Edit it once it's drawn (a folder just made: sidebar.js pendingRename). */
    startWhenThere(kind: 'folder' | 'space', id: string) {
      if (nameOf(kind, id) != null && elementFor(kind, id)) return start(kind, id);
      wanted = { kind, id, until: Date.now() + 3000 };
      return true;
    },
    /** Whether a node is in the name being edited (its clicks aren't the row's). */
    // (`node`: an event's target in Margin's UI.)
    editingContains: (node: EventTarget | null | undefined) => !!editing && !!node && editing.el.contains(node as Node),
    active: () => editing != null,
    afterRender() {
      if (editing && (!editing.el.isConnected || nameOf(editing.kind, editing.id) == null)) { cancel(); return; }
      if (wanted && !editing) {
        if (Date.now() > wanted.until) wanted = null;
        else if (nameOf(wanted.kind, wanted.id) != null && elementFor(wanted.kind, wanted.id)) start(wanted.kind, wanted.id);
      }
    },
    busy: () => editing != null || wanted != null,
    destroy() { if (editing) cancel(); },
  };
}

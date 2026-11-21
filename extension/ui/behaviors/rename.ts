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
type RenameKind = 'folder' | 'space' | 'tab' | 'pin';

export function installRename(rt: Rt) {
  const { view, doc, container } = rt;
  let editing: { kind: RenameKind, id: string | number, el: HTMLElement, saved: Node[], was: string, hadCustom: boolean, ending: boolean } | null = null;
  let wanted: { kind: RenameKind, id: string | number, until: number } | null = null; // one to edit once it's drawn (a folder just made)

  // The m-rename element for a folder, space, tab or pin, if it's drawn.
  function elementFor(kind: RenameKind, id: string | number) {
    for (const el of view.marked('m-rename', kind)) {
      const item = view.subjectOf(el);
      if (kind === 'space' ? (item?.id ?? rt.vm?.space?.id) === id : item?.id === id) return (el as HTMLElement);
    }
    return null;
  }
  const infoOf = (kind: RenameKind, id: string | number): { name: string, hadCustom: boolean } | null => {
    const state = rt.viewState();
    if (!state) return null;
    if (kind === 'folder') {
      const f = state.folders?.find((x) => x.id === id);
      return f ? { name: f.name ?? '', hadCustom: false } : null;
    }
    if (kind === 'space') {
      const sp = state.spaces?.find((x) => x.id === id);
      return sp ? { name: sp.name ?? '', hadCustom: false } : null;
    }
    if (kind === 'pin') {
      const p = state.pins?.find((x) => x.id === id);
      return p ? { name: (p.customTitle || p.title || ''), hadCustom: !!p.customTitle } : null;
    }
    const t = typeof id === 'string' ? state.keptTabs?.[id] : state.tabs?.[id];
    return t ? { name: (t.customTitle || t.title || ''), hadCustom: !!t.customTitle } : null;
  };
  const labelFor = (kind: RenameKind) => (kind === 'folder' ? 'Folder name' : kind === 'space' ? 'Space name' : kind === 'pin' ? 'Pin name' : 'Tab name');

  function start(kind: RenameKind, id: string | number) {
    if (editing) commit();
    const el = elementFor(kind, id);
    const info = infoOf(kind, id);
    if (info == null) return false;
    if (!el) { wanted = { kind, id, until: Date.now() + 3000 }; return true; }
    wanted = null;
    rt.behaviors.menus?.close();
    const saved = [...el.childNodes];
    editing = { kind, id, el, saved, was: info.name, hadCustom: info.hadCustom, ending: false };
    el.replaceChildren(doc.createTextNode(info.name));
    try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.spellcheck = false;
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-label', labelFor(kind));
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
    if (e.kind === 'folder') {
      if (!name || name === e.was) return;
      rt.dispatch('folder.setName', { folder: e.id, name }, 'behavior');
    } else if (e.kind === 'space') {
      if (!name || name === e.was) return;
      rt.dispatch('space.setName', { space: e.id, name }, 'behavior');
    } else if (e.kind === 'pin') {
      if (name === e.was && (!e.hadCustom || name !== '')) return;
      if (!name && !e.hadCustom) return;
      rt.dispatch('pin.setTitle', { pin: e.id, name }, 'behavior');
    } else {
      if (name === e.was && (!e.hadCustom || name !== '')) return;
      if (!name && !e.hadCustom) return;
      rt.dispatch('tab.setTitle', { tab: e.id, name }, 'behavior');
    }
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
      if ((kind === 'folder' || kind === 'space' || kind === 'tab' || kind === 'pin') && id != null) {
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
    startWhenThere(kind: RenameKind, id: string | number) {
      if (infoOf(kind, id) != null && elementFor(kind, id)) return start(kind, id);
      wanted = { kind, id, until: Date.now() + 3000 };
      return true;
    },
    /** Whether a node is in the name being edited (its clicks aren't the row's). */
    // (`node`: an event's target in Margin's UI.)
    editingContains: (node: EventTarget | null | undefined) => !!editing && !!node && editing.el.contains(node as Node),
    active: () => editing != null,
    afterRender() {
      if (editing && (!editing.el.isConnected || infoOf(editing.kind, editing.id) == null)) { cancel(); return; }
      if (wanted && !editing) {
        if (Date.now() > wanted.until) wanted = null;
        else if (infoOf(wanted.kind, wanted.id) != null && elementFor(wanted.kind, wanted.id)) start(wanted.kind, wanted.id);
      }
    },
    busy: () => editing != null || wanted != null,
    destroy() { if (editing) cancel(); },
  };
}

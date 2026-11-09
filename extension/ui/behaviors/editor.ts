// The space editor (themes/arcadia/sidebar.js, "space editor"): its name,
// emoji and color, and deleting it. The theme draws it: its
// `<template m-part="space-editor">` goes in `<m-editor>` while `editor` is
// set, with the fields `m-input="space-name"` and `m-input="space-emoji"`,
// the swatches (`editor.colors`, each `editor.color` with its id), and
// buttons for `editor.save`, `editor.cancel` and `editor.delete`. It opens
// from `space.edit` (a double-click on a chip, the space's menu), and for a
// space just made (`space.new`), which is shown once the editor closes, as
// Arc shows a new space. The name field is focused with its text selected;
// Enter saves, Escape cancels. Delete asks first ("Really delete?"), and the
// last space can't be deleted. With several profiles (Margin.app), the same
// part edits a profile's name, emoji and color (`profile.edit`: the editor's
// `isProfile`), saved by the app (host.perform 'profile.rename'); a name
// that's Safari's (`nameLocked`) is shown, not changed: the app keeps it.
import { SPACE_COLORS } from './menu-items.ts';

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function installEditor(rt: any) {
  const { view, container } = rt;
  let focusName = false; // just opened: the name field focused once drawn
  let wanted: { spaceId: string, fresh: boolean, until: number } | null = null;

  const spaceOf = (id: string) => rt.state?.spaces?.find((s) => s.id === id) ?? null;
  const isEditorField = (el: EventTarget | null) => { const name = el && view.inputs.get(el); return name === 'space-name' || name === 'space-emoji'; };

  function open(spaceId: string, { fresh = false } = {}) {
    const space = spaceOf(spaceId);
    if (!space) return false;
    rt.behaviors.menus?.close();
    focusName = true;
    rt.setUi({ editor: { spaceId, name: space.name ?? '', emoji: space.emoji ?? '', color: space.color ?? '', confirmDelete: false, fresh } });
    return true;
  }
  function openProfile(profileId) {
    const p = rt.state?.across?.profiles?.find((x) => x.id === profileId);
    if (!p) return false;
    rt.behaviors.menus?.close();
    focusName = true;
    const name = p.nameFrom === 'safari' || p.named ? p.name : '';
    rt.setUi({ editor: { profileId, name, emoji: p.emoji ?? '', color: p.color ?? '', confirmDelete: false, fresh: false } });
    return true;
  }
  // `deleted`: it's gone (no showing it).
  function close({ deleted = false } = {}) {
    const e = rt.ui.editor;
    if (!e) return true;
    rt.setUi({ editor: null });
    if (e.fresh && !deleted && e.spaceId) void rt.host.send('setSpace', { windowId: rt.windowId() ?? undefined, spaceId: e.spaceId });
    return true;
  }

  rt.listen(container, 'keydown', (e: KeyboardEvent) => {
    if (!rt.ui.editor || e.isComposing) return;
    const inEditor = isEditorField(e.target) || !!view.rootElement()?.querySelector('m-editor')?.contains((e.target as Node));
    if (!inEditor) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && isEditorField(e.target)) { e.preventDefault(); api.save(); }
  });

  const api = {
    open,
    openProfile,
    /** Open it once the space is there (a new space can reach us after its reply). */
    openWhenThere(spaceId: string, { fresh = false } = {}) {
      if (spaceOf(spaceId)) return open(spaceId, { fresh });
      wanted = { spaceId, fresh, until: Date.now() + 3000 };
      return true;
    },
    save() {
      const e = rt.ui.editor;
      if (!e) return false;
      const name = view.input('space-name')?.value ?? e.name;
      const emoji = view.input('space-emoji')?.value ?? e.emoji;
      close();
      if (e.profileId) {
        rt.host.perform?.('profile.rename', { profile: e.profileId, name: String(name).slice(0, 40), emoji: [...String(emoji)].slice(0, 8).join(''), color: HEX.test(e.color) ? e.color : null });
        return true;
      }
      return rt.dispatch('space.update', { space: e.spaceId, name: String(name).slice(0, 40), emoji: [...String(emoji)].slice(0, 8).join(''), color: HEX.test(e.color) ? e.color : null }, 'behavior');
    },
    cancel: () => close(),
    remove() {
      const e = rt.ui.editor;
      if (!e || e.profileId || (rt.state?.spaces?.length ?? 0) < 2) return false;
      if (!e.confirmDelete) { rt.setUi({ editor: { ...e, confirmDelete: true } }); return true; }
      close({ deleted: true });
      return rt.dispatch('space.delete', e.spaceId, 'behavior');
    },
    color(id) {
      const e = rt.ui.editor;
      const color = SPACE_COLORS[Number(String(id).slice(1))];
      if (!e || !color) return false;
      rt.setUi({ editor: { ...e, color } });
      return true;
    },
    onInput(name, value) {
      const e = rt.ui.editor;
      if (!e) return;
      if (name === 'space-name') rt.setUi({ editor: { ...e, name: value } });
      if (name === 'space-emoji') rt.setUi({ editor: { ...e, emoji: value } });
    },
    afterRender(vm) {
      if (rt.ui.editor && !vm.editor) { rt.setUi({ editor: null }); return; } // its space is gone
      if (wanted && !rt.ui.editor) {
        if (Date.now() > wanted.until) wanted = null;
        else if (spaceOf(wanted.spaceId)) { const w = wanted; wanted = null; open(w.spaceId, { fresh: w.fresh }); return; }
      }
      if (!vm.editor) return;
      const name = view.input('space-name');
      const emoji = view.input('space-emoji');
      if (focusName) {
        // Opened: the fields show the space as it is, the name selected (Safari's name: the emoji).
        if (name) name.value = vm.editor.name;
        if (emoji) emoji.value = vm.editor.emoji;
        const first = vm.editor.nameLocked ? emoji : name;
        if (first) { focusName = false; first.focus({ preventScroll: true }); first.select(); }
      }
    },
    busy: () => rt.ui.editor != null,
  };
  return api;
}

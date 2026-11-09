// The command palette's field (`m-input="palette"`) and keys, as Arcadia's
// palette (themes/arcadia/palette.js): the field shows `palette.query`, is
// focused as the palette opens and emptied as it closes (a theme's `m-if`
// keeps its block, field and all, for the next time); typing re-ranks the
// rows (the view model ranks them: shared/search.ts); ↓/↑ (and ⌃N/⌃P) move
// the selection, wrapping; Enter runs the selected row (palette.run); Escape
// closes. The pointer resting on a row selects it, and pressing one keeps
// the focus in the field. The new-tab palette (`palette.newTab`) is the same.
// Closed, the focus goes back where it was, unless what was chosen opens a
// new tab (what's typed meanwhile would go into the page left).
// Also the new-tab launcher's field (`m-input="launcher"`): Enter runs it.
// It has the focus as the launcher shows, except at the runtime's first
// drawing in a host that says not to (`focusLauncherAtMount` false: Margin.app's
// overlay, not on screen yet then); that host says when (`focusLauncher`).

export function installPalette(rt: any) {
  const { view, container } = rt;
  let wasOpen = false;
  let field: HTMLInputElement | null = null; // the field last shown (it stays in its block while closed)
  let restoreFocus: any = null;
  let reveal = false; // the selection moved by a key: keep it in view
  let launcherShown = false;
  let drawn = false; // the runtime's first drawing is past
  const editable = (el) => !!el && (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select' || el.isContentEditable);

  const isField = (el) => !!el && view.inputs.get(el) === 'palette';
  const active = () => {
    const root = ((container.nodeType === 9 ? container : container) as any);
    return root.activeElement ?? rt.doc.activeElement;
  };

  function move(delta: number) {
    const rows = rt.vm?.palette.rows ?? [];
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.selected);
    const next = ((at < 0 ? 0 : at) + delta + rows.length) % rows.length;
    reveal = true;
    rt.setUi({ palette: { ...rt.ui.palette, selected: next } });
  }

  // The new-tab launcher's field (`m-input="launcher"`, Arcadia's #query):
  // Enter goes to what's typed (an address) or searches for it, as the
  // palette's first row would, in this tab.
  rt.listen(container, 'keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.isComposing || view.inputs.get(e.target) !== 'launcher') return;
    e.preventDefault();
    rt.runQuery((e.target as HTMLInputElement).value);
  });

  rt.listen(container, 'keydown', (e: KeyboardEvent) => {
    if (!isField(e.target) || e.isComposing || !rt.ui.palette.open) return;
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) move(1);
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) move(-1);
    else if (e.key === 'Enter') {
      const id = rt.vm?.palette.selected;
      if (id != null) rt.dispatch('palette.run', id, 'behavior');
    } else if (e.key === 'Escape') rt.dispatch('palette.close', undefined, 'behavior');
    else return;
    e.preventDefault();
  });
  // The pointer over a row selects it; a press on one keeps the field focused.
  rt.listen(container, 'pointermove', (e: PointerEvent) => {
    if (!rt.ui.palette.open) return;
    const hit = view.actionAt(e.target);
    if (hit?.name !== 'palette.run') return;
    const index = (rt.vm?.palette.rows ?? []).findIndex((r) => r.id === hit.arg);
    if (index >= 0 && index !== rt.ui.palette.selected) rt.setUi({ palette: { ...rt.ui.palette, selected: index } });
  });
  rt.listen(container, 'pointerdown', (e: PointerEvent) => {
    if (rt.ui.palette.open && view.actionAt(e.target)?.name === 'palette.run') e.preventDefault();
  });

  return {
    onInput(name, value) {
      if (name === 'palette' && rt.ui.palette.open) rt.setUi({ palette: { ...rt.ui.palette, query: value, selected: 0 } });
    },
    afterRender(vm) {
      // The launcher's field has the focus as the new-tab page shows it
      // (Arcadia's newtab.ts; Safari focuses its address bar instead). Not as
      // the app's overlay first draws (Margin.app starting, a link back, a page
      // reloaded: the overlay isn't on screen, and the window may not be the
      // one the person is in); a launcher that comes later (a new tab) does.
      const atMount = !drawn && rt.host.focusLauncherAtMount === false;
      if (vm.launcher && !launcherShown && !vm.palette.open && !atMount) view.input('launcher')?.focus({ preventScroll: true });
      launcherShown = !!vm.launcher;
      drawn = true;
      const open = !!vm.palette.open;
      if (open) {
        const input = view.input('palette');
        if (input) {
          field = input;
          if (input.value !== vm.palette.query) input.value = vm.palette.query;
          if (!wasOpen) {
            const was = active();
            restoreFocus = was && !isField(was) ? was : null;
            input.focus({ preventScroll: true });
          }
        }
        if (reveal) {
          reveal = false;
          const row = view.actionElements('palette.run').find((el) => view.actionOf(el)?.arg === vm.palette.selected);
          row?.scrollIntoView?.({ block: 'nearest' });
        }
      } else if (wasOpen && field) {
        field.value = '';
      }
      wasOpen = open;
    },
    /** The palette closed: `opensNewTab`, what was chosen opens a new tab (the focus stays out of the page). */
    closed(opensNewTab) {
      if (field) field.value = '';
      const back = restoreFocus;
      restoreFocus = null;
      if (!opensNewTab && back?.isConnected) back.focus?.({ preventScroll: true });
      else if (field && active() === field) field.blur();
    },
    /** The host's word (the app showed a new window's overlay): the launcher's field takes the focus, if it shows and nothing else of Margin's has it. */
    focusLauncher() {
      if (!rt.vm?.launcher || rt.ui.palette.open || editable(active())) return false;
      const input = view.input('launcher');
      input?.focus({ preventScroll: true });
      return !!input;
    },
    busy: () => false,
  };
}

// The command palette's field (`m-input="palette"`) and keys, as Arcadia's
// palette (themes/arcadia/palette.js): the field shows `palette.query`, is
// focused as the palette opens and emptied as it closes (a theme's `m-if`
// keeps its block, field and all, for the next time); typing re-ranks the
// rows (the view model ranks them: shared/search.js); ↓/↑ (and ⌃N/⌃P) move
// the selection, wrapping; Enter runs the selected row (palette.run); Escape
// closes. The pointer resting on a row selects it, and pressing one keeps
// the focus in the field. The new-tab palette (`palette.newTab`) is the same.
// Closed, the focus goes back where it was, unless what was chosen opens a
// new tab (what's typed meanwhile would go into the page left).
// Also the new-tab launcher's field (`m-input="launcher"`): Enter runs it.

/** @param {any} rt */
export function installPalette(rt) {
  const { view, container } = rt;
  let wasOpen = false;
  /** @type {HTMLInputElement | null} */
  let field = null; // the field last shown (it stays in its block while closed)
  /** @type {any} */
  let restoreFocus = null;
  let reveal = false; // the selection moved by a key: keep it in view
  let launcherShown = false;

  const isField = (el) => !!el && view.inputs.get(el) === 'palette';
  const active = () => {
    const root = /** @type {any} */ (container.nodeType === 9 ? container : container);
    return root.activeElement ?? rt.doc.activeElement;
  };

  function move(delta) {
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
  rt.listen(container, 'keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Enter' || e.isComposing || view.inputs.get(e.target) !== 'launcher') return;
    e.preventDefault();
    rt.runQuery(/** @type {HTMLInputElement} */ (e.target).value);
  });

  rt.listen(container, 'keydown', (/** @type {KeyboardEvent} */ e) => {
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
  rt.listen(container, 'pointermove', (/** @type {PointerEvent} */ e) => {
    if (!rt.ui.palette.open) return;
    const hit = view.actionAt(e.target);
    if (hit?.name !== 'palette.run') return;
    const index = (rt.vm?.palette.rows ?? []).findIndex((r) => r.id === hit.arg);
    if (index >= 0 && index !== rt.ui.palette.selected) rt.setUi({ palette: { ...rt.ui.palette, selected: index } });
  });
  rt.listen(container, 'pointerdown', (/** @type {PointerEvent} */ e) => {
    if (rt.ui.palette.open && view.actionAt(e.target)?.name === 'palette.run') e.preventDefault();
  });

  return {
    onInput(name, value) {
      if (name === 'palette' && rt.ui.palette.open) rt.setUi({ palette: { ...rt.ui.palette, query: value, selected: 0 } });
    },
    afterRender(vm) {
      // The launcher's field has the focus as the new-tab page shows it
      // (Arcadia's newtab.js; Safari focuses its address bar instead).
      if (vm.launcher && !launcherShown && !vm.palette.open) view.input('launcher')?.focus({ preventScroll: true });
      launcherShown = !!vm.launcher;
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
    busy: () => false,
  };
}

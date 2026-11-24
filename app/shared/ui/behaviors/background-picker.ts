// Edit Theme Color (M2.9 step 4, docs/SPACE-BACKGROUNDS.md Part B §4): the picker for a space's background, opened
// by `space.editBackground` (the space's menu: "Edit Theme Color…"; a theme's button may name it too) at the point it
// was asked from. The panel is Margin's own (ui/picker/panel.ts); this saves what it does:
// - while a gesture runs, the background is drawn ahead of the state (the runtime's `previewBackground`: Margin's
//   layer redrawn, nothing saved, nothing else drawn again);
// - each gesture's end (a click, a drag let go, a burst of scrolling or keys at rest) is one `space.setBackground`
//   (its key colour as the space's colour with it), drawn ahead until the state has it;
// - ⌘Z goes back a saved step (each saved again); Escape puts back what the space had when the panel opened and
//   closes; Done, a press outside it, another space shown or the space gone close it, what's saved kept;
// - Use for All Spaces saves it to every space (one request each).
// While it's open the runtime says so (`onPanel`): Margin.app gives the page the keys and is told the panel takes the
// pointer (app/shared/host/overlay.ts), as for Margin's menus.
import type { Rt } from '../runtime.ts';
import type { ViewModel } from '../view-model.ts';
import type { SpaceBackground } from '../../../../types/margin';
import { backgroundOf } from '../../../../extension/shared/space-background.ts';
import { backgroundFrom, stateOf } from '../picker/model.ts';
import { createPickerPanel } from '../picker/panel.ts';
import type { PickerPanel, TickKind } from '../picker/panel.ts';

const same = (a: SpaceBackground | null, b: SpaceBackground | null) => JSON.stringify(a) === JSON.stringify(b);

export function installBackgroundPicker(rt: Rt, { onTick }: { onTick?: (kind: TickKind) => void } = {}) {
  let open: { spaceId: string, panel: PickerPanel, origin: SpaceBackground | null, saved: SpaceBackground | null, undo: (SpaceBackground | null)[] } | null = null;

  const stored = (spaceId: string): SpaceBackground | null => backgroundOf((rt.state?.spaces?.find((s) => s.id === spaceId) as { background?: unknown } | undefined)?.background) ?? null;

  /** Saved, its key colour the space's colour too; the panel's own space drawn ahead until the state has it (one is:
   *  the others aren't shown here). */
  function save(spaceId: string, bg: SpaceBackground | null, { ahead = true } = {}) {
    if (ahead) rt.previewBackground(spaceId, bg, { held: false });
    rt.dispatch('space.setBackground', { space: spaceId, background: bg, color: bg?.colors[0] ?? null }, 'behavior');
  }

  function close() {
    if (!open) return false;
    const { panel, spaceId, saved } = open;
    open = null;
    panel.destroy();
    // (Nothing held any more: what's saved is drawn until the state has it, whichever way it closed.)
    rt.previewBackground(spaceId, saved, { held: false });
    rt.panelChanged();
    return true;
  }

  function show(spaceId: string, info: { point?: { x: number, y: number }, element?: Element } | null) {
    close();
    if (!rt.state?.spaces?.some((s) => s.id === spaceId)) return false;
    // (Asked from a menu: where it was; from a theme's button: beside it; else near the window's top left.)
    const box = info?.element?.getBoundingClientRect?.();
    const point = info?.point ?? (box ? { x: box.right + 8, y: box.top } : { x: 24, y: 56 });
    const origin = stored(spaceId);
    const panel = createPickerPanel({
      doc: rt.doc, container: rt.container, state: stateOf(origin), point,
      events: {
        preview: (s) => rt.previewBackground(spaceId, backgroundFrom(s), { held: true }),
        commit: (s) => {
          if (!open) return;
          const bg = backgroundFrom(s);
          if (same(bg, open.saved)) { rt.previewBackground(spaceId, bg, { held: false }); return; }
          open.undo.push(open.saved);
          open.saved = bg;
          save(spaceId, bg);
        },
        undo: () => {
          if (!open || !open.undo.length) return;
          const bg = open.undo.pop()!;
          open.saved = bg;
          open.panel.set(stateOf(bg));
          save(spaceId, bg);
        },
        escape: () => {
          if (!open) return;
          if (!same(open.saved, open.origin)) save(spaceId, open.origin);
          open.saved = open.origin;
          close();
        },
        done: () => { close(); },
        all: (s) => {
          if (!open) return;
          const bg = backgroundFrom(s);
          if (!same(bg, open.saved)) { open.undo.push(open.saved); open.saved = bg; }
          for (const sp of rt.state?.spaces ?? []) save(sp.id, bg, { ahead: sp.id === spaceId });
        },
        tick: (kind) => onTick?.(kind),
      },
    });
    open = { spaceId, panel, origin, saved: origin, undo: [] };
    rt.panelChanged();
    return true;
  }

  // A press anywhere but the panel closes it (as Margin's menus: ui/behaviors/menus.ts; from the container, the panel is
  // its host; from the document, a press in a shadow root container is its host).
  rt.listen(rt.container, 'pointerdown', (e: PointerEvent) => { if (open && !open.panel.owns(e.target)) close(); }, true);
  rt.listen(rt.doc, 'pointerdown', (e: PointerEvent) => {
    if (!open) return;
    const inside = rt.container.nodeType === 9 ? open.panel.owns(e.target) : e.target === (rt.container as ShadowRoot).host;
    if (!inside) close();
  }, true);

  return {
    open: (spaceId: string, info: any) => show(spaceId, info),
    close,
    /** Open (for which space), or null. */
    get openFor() { return open?.spaceId ?? null; },
    /** Its box in the window's pixels, [x, y, width, height], null while closed. */
    rect: () => open?.panel.rect() ?? null,
    /** Its parts, for the tests. */
    parts: () => open?.panel.parts() ?? null,
    /** Another space shown, or the space gone: closed (what's saved kept). */
    afterRender(vm: ViewModel) {
      if (open && (vm.space?.id !== open.spaceId || !rt.state?.spaces?.some((s) => s.id === open!.spaceId))) close();
    },
    busy: () => !!open,
    destroy() { close(); },
  };
}

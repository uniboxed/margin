// Edit Theme Color (M2.9 step 4, docs/SPACE-BACKGROUNDS.md Part B §4): the picker for a space's background, opened
// by `space.editBackground` (the space's menu: "Edit Theme Color…"; a theme's button may name it too) at the point it
// was asked from. The panel is Margin's own (ui/picker/panel.ts); this saves what it does:
// - while a gesture runs, the background is drawn ahead of the state (the runtime's `previewBackground`: Margin's
//   layer redrawn, nothing saved, nothing else drawn again);
// - each gesture's end (a click, a drag let go, a burst of scrolling or keys at rest) is one `space.setBackground`
//   (its key colour as the space's colour with it), drawn ahead until the state has it;
// - ⌘Z goes back a saved step (each saved again); Escape puts back what the space had when the panel opened and
//   closes; Done, a press outside it, another space shown or the space gone close it, what's saved kept;
// - Use for All Spaces saves it to every space (one request each);
// - a picture (M2.9 step 7, where the host serves them: Margin.app): its file picker asked for (`backgroundChoose`), or
//   a file dropped on the picker sent (`backgroundAdd`, its bytes), and the id that comes back saved as any edit is
//   (⌘Z takes it back); a refusal's words shown in the picker. One at a time; one that comes after the picker closed
//   (or opened again) isn't saved (the file it kept goes as Margin.app next opens).
// While it's open the runtime says so (`onPanel`): Margin.app gives the page the keys and is told the panel takes the
// pointer (app/shared/host/overlay.ts), as for Margin's menus.
// Its glass (M2.9 step 5, DECISIONS.md "M2.9 step 5 spike"): with a host that has the system's materials (`materials`:
// Margin.app on macOS 26 and later, through WebKit's system appearance), they're asked for as it opens and the panel
// is made once the answer is back (its sheet keeps `-apple-visual-effect` only if read with them on), and given back
// as it closes. Not asked for while Margin's Settings page is on screen (their one visible effect: its native controls
// in a dark appearance) or with more contrast asked for: the panel is drawn solid then. Settings coming while it holds
// them closes it. A theme that asks for them itself (Liquid Glass) has them on throughout, so its picker is glass
// always (nothing else changes there).
import type { Rt } from '../runtime.ts';
import type { ViewModel } from '../view-model.ts';
import type { SpaceBackground } from '../../../../types/margin';
import { backgroundOf } from '../../../../extension/shared/space-background.ts';
import { backgroundFrom, setPicture, stateOf } from '../picker/model.ts';
import { droppedProblem, readBase64 } from '../picker/picture.ts';
import type { PictureRequests } from '../picker/picture.ts';
import { WORDS } from '../picker/words.ts';
import { createPickerPanel } from '../picker/panel.ts';
import type { PanelEvents, TickKind } from '../picker/panel.ts';
import { createPickerPart, themeHasPicker } from '../picker/part.ts';
import type { PickerState } from '../picker/model.ts';

// What the panel (Margin's own) and a theme's part (its `background-picker`, M2.9 step 5b) both give this.
type Picker = {
  set(next: PickerState): void, readonly state: PickerState, rect(): number[] | null, owns(target: EventTarget | null): boolean,
  parts(): unknown, finish(): void, destroy(): void, run?(id: string): boolean, afterRender?(): void,
  apply(next: PickerState): void, note(text: string | null): void,
};

const same = (a: SpaceBackground | null, b: SpaceBackground | null) => JSON.stringify(a) === JSON.stringify(b);

export function installBackgroundPicker(rt: Rt, { onTick, materials }: {
  onTick?: (kind: TickKind) => void,
  /** The system's materials asked for (true) or given back (false); resolves once the page has the answer. */
  materials?: (on: boolean) => Promise<unknown>,
} = {}) {
  // (`color`: the space's own colour as it opened, put back with the background it had: Escape, ⌘Z to the start.)
  let open: { spaceId: string, panel: Picker, origin: SpaceBackground | null, color: string | null, saved: SpaceBackground | null, undo: (SpaceBackground | null)[] } | null = null;
  // Asked for a space not shown: switched to first, opened once it's shown (3 s at most).
  let wanted: { spaceId: string, info: { point?: { x: number, y: number }, element?: Element } | null, until: number } | null = null;
  // Each open and close is a turn: an open waiting for the materials makes its panel only if it's still the last turn.
  let turn = 0;
  // The space an open is waiting for the materials for (no panel yet), or null.
  let waitingFor: string | null = null;
  // The materials held for the panel: asked for and not given back; `answer`, the ask for them still on its way.
  let holding = false;
  let answer: Promise<unknown> | null = null;
  // A picture being added (Margin.app's file picker open, or a dropped one on its way): the turn it was asked in.
  let adding: number | null = null;

  const settingsShown = () => !!(rt.host.settingsAsked || rt.ui.settingsPage);
  const moreContrast = () => !!rt.win.matchMedia?.('(prefers-contrast: more)').matches;
  const hasSpace = (id: string) => !!rt.state?.spaces?.some((s) => s.id === id);
  /**
   * Asked for (on) or given back, once each way. Asking: the answer to wait for (this ask's, or one still on its way),
   * or null when they're held and answered already (or no host has them). Giving back: nothing to wait for.
   */
  function hold(on: boolean): Promise<unknown> | null {
    if (!materials) return null;
    if (holding === on) return on ? answer : null;
    holding = on;
    const asked: Promise<unknown> = materials(on).catch(() => null).finally(() => { if (answer === asked) answer = null; });
    answer = on ? asked : null;
    return answer;
  }

  const stored = (spaceId: string): SpaceBackground | null => backgroundOf((rt.state?.spaces?.find((s) => s.id === spaceId) as { background?: unknown } | undefined)?.background) ?? null;

  /** Saved, with the space's colour (`color`: its key colour, or what the space had); the panel's own space drawn ahead
   *  until the state has it (one is: the others aren't shown here). */
  function save(spaceId: string, bg: SpaceBackground | null, color: string | null, { ahead = true } = {}) {
    if (ahead) rt.previewBackground(spaceId, bg, { held: false });
    rt.dispatch('space.setBackground', { space: spaceId, background: bg, color }, 'behavior');
  }
  /** The space's colour with a background: what it had as the panel opened, with that background back; else the key colour. */
  const colorWith = (bg: SpaceBackground | null) => (open && same(bg, open.origin) ? open.color : bg?.colors[0] ?? open?.color ?? null);

  /** The panel (or an open still waiting) ended; the materials given back unless another open follows (`keep`). What
   *  it drew and hadn't saved yet (a burst at rest's wait, a drag cut off) is saved first, however it closes (Escape
   *  drops it before it comes here). */
  function end({ keep = false } = {}) {
    turn++;
    waitingFor = null;
    open?.panel.finish();
    const was = open;
    open = null;
    if (was) {
      was.panel.destroy();
      // (Nothing held any more: what's saved is drawn until the state has it, whichever way it closed.)
      rt.previewBackground(was.spaceId, was.saved, { held: false });
    }
    // (After the panel's gone: its glass never outlives the switch.)
    if (!keep) void hold(false);
    if (was) rt.panelChanged();
    return !!was;
  }
  const close = () => end();

  function show(spaceId: string, info: { point?: { x: number, y: number }, element?: Element } | null) {
    end({ keep: true });
    wanted = null;
    if (!hasSpace(spaceId)) { void hold(false); return false; }
    // (A space not shown: its background isn't drawn here, so it's switched to first, as Arc does, and opened then.)
    if (rt.vm?.space?.id !== spaceId) {
      void hold(false);
      wanted = { spaceId, info, until: Date.now() + 3000 };
      rt.dispatch('space.switch', spaceId, 'behavior');
      return true;
    }
    // (Asked from a menu: where it was; from a theme's button: beside it; else near the window's top left.)
    const box = info?.element?.getBoundingClientRect?.();
    const point = info?.point ?? (box ? { x: box.right + 8, y: box.top } : { x: 24, y: 56 });
    // (A theme's own picker is the theme's look: no glass asked for.)
    const themed = themeHasPicker(rt);
    const glass = !!materials && !themed && !settingsShown() && !moreContrast();
    const mine = turn;
    const make = () => {
      if (mine !== turn) return; // closed, or opened again, meanwhile (that turn saw to the materials)
      waitingFor = null;
      // (The space gone, or Settings come, while waiting: not opened.)
      if (!hasSpace(spaceId) || (glass && settingsShown())) { void hold(false); return; }
      makePanel(spaceId, point, themed);
    };
    if (!glass) { void hold(false); make(); return true; }
    const asked = hold(true);
    if (!asked) { make(); return true; } // held and answered already (opened again while open)
    waitingFor = spaceId;
    void asked.then(make); // (opened again before the answer: that same answer)
    return true;
  }

  /** How a picture comes in, where the host serves them (Margin.app); none elsewhere. */
  function picturesFor(spaceId: string): PictureRequests | null {
    if (!rt.host.pictureUrl) return null;
    return {
      url: (id) => rt.host.pictureUrl?.(id) ?? null,
      choose: () => { void addPicture(spaceId, null); },
      drop: (file) => { void addPicture(spaceId, file); },
    };
  }
  /** Margin.app's file picker (`file` null), or a dropped file sent: the id that comes back saved on the open picker. */
  async function addPicture(spaceId: string, file: File | null) {
    if (!open || open.spaceId !== spaceId || adding === turn) return;
    const mine = turn, panel = open.panel;
    const problem = file ? droppedProblem(file) : null;
    if (problem) { panel.note(problem); return; }
    adding = mine;
    panel.note(file ? WORDS.pictureAdding : null);
    let result: unknown;
    let why: string | null = null;
    try {
      if (file) {
        const bytes = await readBase64(file, rt.win);
        if (bytes === null) why = WORDS.pictureUnreadable;
        else if (mine === turn) result = await rt.host.send('backgroundAdd', { bytes });
      } else {
        result = await rt.host.send('backgroundChoose');
      }
    } catch {
      result = undefined;
    } finally {
      if (adding === mine) adding = null;
    }
    // (Closed, or opened again, meanwhile: not saved.)
    if (mine !== turn || open?.panel !== panel) return;
    const id = (result as { id?: unknown } | null | undefined)?.id;
    if (typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) { panel.note(null); panel.apply(setPicture(panel.state, id)); return; }
    if (result === null && !why) { panel.note(null); return; } // (the file picker cancelled)
    panel.note(why ?? (rt.host.takeFailure?.()?.error || WORDS.pictureFailed));
  }

  function makePanel(spaceId: string, point: { x: number, y: number }, themed: boolean) {
    const origin = stored(spaceId);
    const color = (rt.state?.spaces?.find((s) => s.id === spaceId) as { color?: unknown } | undefined)?.color;
    const events: PanelEvents = {
      preview: (s) => rt.previewBackground(spaceId, backgroundFrom(s), { held: true }),
      commit: (s) => {
        if (!open) return;
        const bg = backgroundFrom(s);
        if (same(bg, open.saved)) { rt.previewBackground(spaceId, bg, { held: false }); return; }
        open.undo.push(open.saved);
        open.saved = bg;
        save(spaceId, bg, colorWith(bg));
      },
      undo: () => {
        if (!open || !open.undo.length) return;
        const bg = open.undo.pop()!;
        open.saved = bg;
        open.panel.set(stateOf(bg));
        save(spaceId, bg, colorWith(bg));
      },
      escape: () => {
        if (!open) return;
        if (!same(open.saved, open.origin)) save(spaceId, open.origin, open.color);
        open.saved = open.origin;
        close();
      },
      done: () => { close(); },
      all: (s) => {
        if (!open) return;
        const bg = backgroundFrom(s);
        if (!same(bg, open.saved)) { open.undo.push(open.saved); open.saved = bg; }
        for (const sp of rt.state?.spaces ?? []) save(sp.id, bg, sp.id === spaceId ? colorWith(bg) : bg?.colors[0] ?? null, { ahead: sp.id === spaceId });
      },
      tick: (kind) => onTick?.(kind),
    };
    const pictures = picturesFor(spaceId);
    const panel: Picker = themed
      ? createPickerPart({ rt, spaceId, state: stateOf(origin), point, events, pictures })
      : createPickerPanel({ doc: rt.doc, container: rt.container, state: stateOf(origin), point, events, scale: () => rt.scale?.() || 1, pictures });
    // (Only a colour the action takes, `#rgb` or `#rrggbb`: another would have every save refused.)
    open = { spaceId, panel, origin, color: typeof color === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : null, saved: origin, undo: [] };
    rt.panelChanged();
  }

  // A press anywhere but the panel closes it (as Margin's menus: ui/behaviors/menus.ts; from the container, the panel is
  // its host; from the document, a press in a shadow root container is its host). A press while an open still waits
  // for the materials ends that open.
  rt.listen(rt.container, 'pointerdown', (e: PointerEvent) => { if (open ? !open.panel.owns(e.target) : waitingFor) close(); }, true);
  rt.listen(rt.doc, 'pointerdown', (e: PointerEvent) => {
    if (!open) { if (waitingFor) close(); return; }
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
    /** A theme's button in its own picker (`picker.run`, the item checked first): what that item does. Only a button in
     *  the picker (a theme's button elsewhere can't, say, Use for All Spaces, which no undo takes back). */
    run(id: string, info?: { element?: Element } | null) {
      if (!open || (info?.element && !open.panel.owns(info.element))) return false;
      return open.panel.run?.(id) ?? false;
    },
    /** Another space shown, or the space gone: closed (what's saved kept); so is an open still waiting. Settings come
     *  while the materials are held for it: closed too. */
    afterRender(vm: ViewModel) {
      // (Switched to the space it was asked for: opened now.)
      if (wanted && !open && !waitingFor) {
        if (Date.now() > wanted.until || !hasSpace(wanted.spaceId)) wanted = null;
        else if (vm.space?.id === wanted.spaceId) { const w = wanted; wanted = null; show(w.spaceId, w.info); return; }
      }
      const id = open?.spaceId ?? waitingFor;
      if (id && (vm.space?.id !== id || !hasSpace(id))) close();
      else if (open && holding && settingsShown()) close();
      else open?.panel.afterRender?.();
    },
    busy: () => !!open,
    destroy() { close(); },
  };
}

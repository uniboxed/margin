// The ends of the spaces, as Arc's (docs/ARC-SIDEBAR.md "The ends of the spaces"): its Library before the first space
// and its Create a Space after the last. A swipe reaches them (ui/behaviors/swipe.ts, for a theme that asks:
// `--m-swipe-ends: arc`); this keeps what they show.
//
// The Library (`library.open`, `library.close`, `library.section`; its search field `m-input="library-search"`): open
// or not, the rail's section shown (Archived Tabs first; Media, Downloads, Easels, Spaces and Boosts aren't in Margin
// yet: drawn with their words), what's typed in its search. Escape in it closes it.
//
// Create a Space (`newSpace.open`, `newSpace.cancel`, `newSpace.create`, `newSpace.theme`; its fields
// `m-input="new-space-name"` and `m-input="new-space-emoji"`; its profile from the `profile` menu): nothing is made
// until Create Space, as Arc. Its colour is picked as it opens (the page is drawn in it, and the space gets it). Create
// Space asks for the space with its name, icon, colour and profile (the host's createSpace: shown in the window as it's
// made); Choose a Theme does the same, then opens Edit Theme Color for it once it's there. Enter in its name creates,
// Escape cancels.
import type { Rt } from '../runtime.ts';
import { SPACE_COLORS } from './menu-items.ts';
import { LIBRARY_SECTIONS } from '../view-model.ts';

export function installEnds(rt: Rt) {
  const { view, container } = rt;
  // A space just made, its Edit Theme Color opened once the state has it.
  let themeFor: { spaceId: string, until: number } | null = null;
  let focusName = false;

  const lib = () => rt.ui.library ?? {};
  const fieldOf = (el: EventTarget | null) => (el ? view.inputs.get(el as Element) : undefined);

  function openLibrary() {
    rt.behaviors.menus?.close();
    rt.setUi({ library: { ...lib(), open: true, peek: false, query: '' }, newSpace: null });
    return true;
  }
  function closeLibrary() {
    if (!lib().open) return true;
    rt.setUi({ library: { ...lib(), open: false, peek: false, query: '' } });
    return true;
  }
  function section(id: string) {
    if (!(LIBRARY_SECTIONS as readonly string[]).includes(id)) return false;
    rt.setUi({ library: { ...lib(), section: id, query: '' } });
    return true;
  }

  function openNewSpace() {
    rt.behaviors.menus?.close();
    const color = SPACE_COLORS[Math.floor(Math.random() * SPACE_COLORS.length)];
    focusName = true;
    rt.setUi({ newSpace: { name: '', emoji: '', color, profile: null }, library: { ...lib(), open: false, query: '' } });
    return true;
  }
  function cancelNewSpace() {
    if (!rt.ui.newSpace) return true;
    rt.setUi({ newSpace: null });
    return true;
  }
  // `theme`: Edit Theme Color for it next (Choose a Theme). The fields as typed, the name required for Create Space.
  function createNewSpace({ theme = false } = {}) {
    const ns = rt.ui.newSpace;
    const v = rt.vm?.newSpace;
    if (!ns || !v) return false;
    const name = String(view.input('new-space-name')?.value ?? ns.name ?? '').trim().slice(0, 40);
    if (!name && !theme) return false;
    const emoji = String(view.input('new-space-emoji')?.value ?? ns.emoji ?? '').trim().slice(0, 8);
    const payload: Record<string, unknown> = { windowId: rt.windowId() ?? undefined, name, color: ns.color };
    if (emoji) payload.emoji = emoji;
    if (v.hasProfiles && v.profileId) payload.profile = v.profileId;
    rt.setUi({ newSpace: null });
    void Promise.resolve(rt.send('createSpace', payload)).then((res: any) => {
      if (theme && typeof res?.spaceId === 'string') { themeFor = { spaceId: res.spaceId, until: Date.now() + 3000 }; openThemeWhenThere(); }
    }).catch(() => {});
    return true;
  }
  function openThemeWhenThere() {
    const t = themeFor;
    if (!t) return;
    if (Date.now() > t.until) { themeFor = null; return; }
    if (rt.state?.spaces?.some((s: { id: string }) => s.id === t.spaceId)) {
      themeFor = null;
      rt.behaviors.backgroundPicker?.open(t.spaceId, null);
    }
  }
  function setProfile(id: string) {
    const ns = rt.ui.newSpace;
    if (!ns || typeof id !== 'string') return false;
    rt.setUi({ newSpace: { ...ns, profile: id } });
    return true;
  }

  rt.listen(container, 'keydown', (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const field = fieldOf(e.target);
    if (rt.ui.newSpace && (field === 'new-space-name' || field === 'new-space-emoji')) {
      if (e.key === 'Enter') { e.preventDefault(); createNewSpace(); } else if (e.key === 'Escape') { e.preventDefault(); cancelNewSpace(); }
    } else if (lib().open && field === 'library-search' && e.key === 'Escape') {
      e.preventDefault();
      if (lib().query) rt.setUi({ library: { ...lib(), query: '' } });
      else closeLibrary();
    }
  });

  return {
    openLibrary, closeLibrary, section, openNewSpace, cancelNewSpace, createNewSpace, setProfile,
    /** The Library's rows drawn while a swipe shows it (not open yet): ui/behaviors/swipe.ts. */
    peek(on: boolean) {
      if (!!lib().peek === on) return;
      rt.setUi({ library: { ...lib(), peek: on } });
    },
    onInput(name: string, value: string) {
      if (name === 'library-search' && lib().open) rt.setUi({ library: { ...lib(), query: String(value ?? '').slice(0, 200) } });
      else if ((name === 'new-space-name' || name === 'new-space-emoji') && rt.ui.newSpace) {
        rt.setUi({ newSpace: { ...rt.ui.newSpace, [name === 'new-space-name' ? 'name' : 'emoji']: String(value ?? '').slice(0, name === 'new-space-name' ? 40 : 8) } });
      }
    },
    afterRender() {
      openThemeWhenThere();
      if (focusName && rt.ui.newSpace) {
        const el = view.input('new-space-name') as HTMLInputElement | null;
        if (el) { focusName = false; el.focus({ preventScroll: true }); }
      } else if (!rt.ui.newSpace) focusName = false;
    },
    busy: () => false,
    destroy() { themeFor = null; },
  };
}

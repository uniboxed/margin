// The launcher's Settings form (ui/settings-form.ts): Margin's own inputs in
// the theme's `settings` part. A theme writes `<input m-input="setting-
// number">`, `setting-toggle`, `setting-shortcut`, `<select m-input=
// "setting-choice">` and `<textarea m-input="setting-list">` inside an
// `<m-for>` over `settingsForm.fields`; Margin keeps each in step with its
// field (value, checked, options, bounds, disabled, placeholder) and saves
// a change through the field's own rule, never the theme's. A shortcut
// field records the next key combination pressed in it (Escape cancels;
// a combination another shortcut has is refused with a word saying which),
// and Margin's own shortcuts wait meanwhile (`ui.recording`).
import { spaceThemesOn } from '../space-theme.ts';
import type { Rt } from '../runtime.ts';
import { saveField, saveThemeField, runField, removePrompt, storePrompt, shortcutTaken, wokeText, SHORTCUT_HELP, UNLINK_PREFIX, STORE_TRY } from '../settings-form.ts';
import * as shortcuts from '../../../../extension/shared/shortcuts.ts';
import { appKeyValue, isAppKey } from '../../../../extension/shared/app-keys.ts';

const NAMES: Set<string | undefined> = new Set(['setting-number', 'setting-toggle', 'setting-choice', 'setting-list', 'setting-shortcut', 'setting-color']); // (asked of any element's)
// A colour well shows #rrggbb only: a theme's other colours show as their nearest it can.
const wellColor = (v: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : /^#[0-9a-f]{3}$/i.test(v) ? `#${[...v.slice(1)].map((c) => c + c).join('')}`.toLowerCase() : '#000000');

export function installSettings(rt: Rt) {
  const { view, container, doc } = rt;
  // (`el`: an event's target, or an element: one of Margin's inputs if the view knows it.)
  const nameOf = (el: EventTarget | null) => view.inputs.get(el as Element);
  const isSetting = (el: Element | null) => !!el && NAMES.has(nameOf(el));
  // The field as the form has it now (not what the theme's scope says).
  const fieldOf = (el: EventTarget | null) => {
    const id = view.subjectOf(el as Element)?.id;
    return rt.vm?.settingsForm?.fields.find((f) => f.id === id) ?? null;
  };
  const focused = () => (container as any).activeElement ?? doc.activeElement;
  const status = (key: string, text: string, error = false) => rt.setUi({ settingsStatus: { ...(rt.ui.settingsStatus ?? {}), [key]: text == null ? undefined : { text, error } } });

  function sync() {
    const root = view.rootElement();
    if (!root || !rt.vm?.settingsForm) return;
    for (const el of root.querySelectorAll('[m-input^="setting-"]')) {
      if (!isSetting(el)) continue;
      const f = fieldOf(el);
      if (!f) continue;
      const input = (el as any);
      if (input.disabled !== f.disabled) input.disabled = f.disabled;
      if (f.placeholder && input.placeholder !== f.placeholder) input.placeholder = f.placeholder;
      switch (nameOf(el)) {
        case 'setting-number':
          if (f.min != null) input.min = String(f.min);
          if (f.max != null) input.max = String(f.max);
          if (f.step) input.step = f.step;
          if (focused() !== el && input.value !== f.value) input.value = f.value;
          break;
        case 'setting-toggle':
          if (input.checked !== f.checked) input.checked = f.checked;
          break;
        case 'setting-choice': {
          const key = f.options.map((o) => `${o.id}=${o.label}`).join('\n');
          if (input.__options !== key) {
            input.__options = key;
            input.replaceChildren(...f.options.map((o) => Object.assign(doc.createElement('option'), { value: o.id, textContent: o.label })));
          }
          if (input.value !== f.value) input.value = f.value;
          break;
        }
        case 'setting-list':
          input.rows ||= 3;
          if (focused() !== el && input.value !== f.value) input.value = f.value;
          break;
        case 'setting-color':
          if (input.type !== 'color') input.type = 'color';
          if (focused() !== el && input.value !== wellColor(f.value)) input.value = wellColor(f.value);
          break;
        case 'setting-shortcut':
          input.readOnly = true;
          input.classList.toggle('m-recording', f.recording);
          if (!f.recording && input.value !== f.value) input.value = f.value;
          if (f.recording && input.value) input.value = '';
          break;
        default: break;
      }
    }
  }

  function save(el: Element, value: string | boolean) {
    const f = fieldOf(el);
    // Theme, with a space shown: that space's theme (each space has its own, 2026-11-20; ui/space-theme.ts), checked as
    // any action against the themes Margin has. Without one: the profile's, as before.
    const spaceId = rt.vm?.space?.id;
    if (f?.id === 'theme' && !f.fromTheme && spaceThemesOn((rt.host.platform as any)?.features) && typeof spaceId === 'string' && spaceId && rt.state?.spaces?.some((sp) => sp.id === spaceId)) {
      const ok = rt.dispatch('space.setTheme', { space: spaceId, theme: String(value) }, 'behavior') !== false;
      if (!ok) sync();
      return ok;
    }
    // The active theme's own settings (fields Margin made from its theme.json) save only updateThemeSettings for it.
    const request = f?.fromTheme ? saveThemeField(f, value, rt.themeInfo ?? null) : saveField(f, value, rt.state?.settings);
    if (!request) { sync(); return false; } // back to what's saved
    void rt.host.send(request.type, request.payload);
    return true;
  }

  rt.listen(container, 'change', (e: Event) => {
    const el = (e.target as any);
    if (!isSetting(el)) return;
    const name = nameOf(el);
    if (name === 'setting-shortcut') return;
    save(el, name === 'setting-toggle' ? !!el.checked : el.value);
  });
  // A shortcut field: recording while it has the focus.
  rt.listen(container, 'focusin', (e: FocusEvent) => {
    const el = e.target;
    if (nameOf(el) !== 'setting-shortcut') return;
    const f = fieldOf(el);
    if (f) rt.setUi({ recording: f.id });
  });
  rt.listen(container, 'focusout', (e: FocusEvent) => {
    if (nameOf(e.target) === 'setting-shortcut' && rt.ui.recording) rt.setUi({ recording: null });
  });
  // Capture phase, so recording wins over Margin's shortcuts themselves.
  rt.listen(container, 'keydown', (e: KeyboardEvent) => {
    const el = (e.target as any);
    if (!rt.ui.recording || nameOf(el) !== 'setting-shortcut') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') return void el.blur();
    const f = fieldOf(el);
    if (!f) return;
    // Delete (or Backspace), alone: one of Margin.app's keys off.
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey && isAppKey(f.id)) {
      status('shortcuts', SHORTCUT_HELP);
      save(el, '');
      return void el.blur();
    }
    const combo = shortcuts.fromEvent(e);
    if (!combo || !shortcuts.parse(combo)) return;
    if (isAppKey(f.id) && appKeyValue(f.id, combo) == null) return void status('shortcuts', 'This one takes a digit with ⌘, ⌥ or ⌃: it stands for 1 to 9.', true);
    const taken = shortcutTaken(f.id, combo, rt.state?.settings);
    if (taken) return void status('shortcuts', taken, true);
    status('shortcuts', SHORTCUT_HELP);
    save(el, combo);
    el.blur();
  }, true);

  // Settings' Themes drawn for the first time (its Refresh shown, the store not asked yet): Margin.app asked for its list.
  let storeAsked = false;
  function askStore() {
    if (storeAsked || !rt.vm?.settingsForm?.fields.some((x) => x.id === 'storeRefresh')) return;
    if (rt.host.themeStore?.state) return; // (told already)
    storeAsked = true;
    rt.host.perform?.('theme.store.open');
  }

  return {
    afterRender() { sync(); askStore(); },
    /** A button of the form (settings.run). */
    run(id: string) {
      const f = rt.vm?.settingsForm?.fields.find((x) => x.id === id && x.isButton);
      // Themes (Margin.app): Import asks the app for its file picker; Remove asks first, in Margin's prompt.
      if (id === 'themeImport') {
        status('themeImport', 'Choose a theme’s folder or a .margintheme file…');
        return rt.host.perform?.('theme.import') === true;
      }
      // Load Unpacked asks for the app's folder picker; Unlink stops following a linked theme's folder (it stays).
      if (id === 'themeLink') {
        status('themeLink', 'Choose a theme’s folder…');
        return rt.host.perform?.('theme.link') === true;
      }
      if (id.startsWith(UNLINK_PREFIX) && f) {
        const themeId = id.slice(UNLINK_PREFIX.length);
        const done = rt.host.perform?.('theme.unlink', { id: themeId }) === true;
        if (done) status('themeLink', 'Unlinked: the theme stays as it was last drawn, now a copy; its folder isn’t followed any more.');
        return done;
      }
      // The theme store (Margin.app): its list asked again; a theme tried (downloaded, then previewed as an import is,
      // Use Theme installing it) or updated the same way. Report and Share ask first, in Margin's prompt.
      if (id === 'storeRefresh' && f) {
        storeAsked = true;
        status('storeRefresh', 'Loading the store’s themes…');
        return rt.host.perform?.('theme.store.open') === true;
      }
      if (id.startsWith(STORE_TRY) && f) {
        status(id, 'Downloading it…');
        return rt.host.perform?.('theme.store.try', { id: id.slice(STORE_TRY.length) }) === true;
      }
      const prompt = f ? removePrompt(id, rt.host.userThemes ?? []) ?? storePrompt(id, { userThemes: rt.host.userThemes ?? [], themeStore: rt.host.themeStore }) : null;
      if (prompt) { rt.setUi({ prompt }); return true; }
      const request = runField(f);
      if (!request) return false;
      if (id === 'wakeAll') {
        status('wakeAll', 'Waking…');
        void Promise.resolve(rt.host.send(request.type, request.payload)).then((woke) => status('wakeAll', wokeText(woke)));
      } else {
        status('shortcuts', SHORTCUT_HELP);
        void rt.host.send(request.type, request.payload);
      }
      return true;
    },
    busy: () => false,
  };
}

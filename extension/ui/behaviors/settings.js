// The launcher's Settings form (ui/settings-form.js): Margin's own inputs in
// the theme's `settings` part. A theme writes `<input m-input="setting-
// number">`, `setting-toggle`, `setting-shortcut`, `<select m-input=
// "setting-choice">` and `<textarea m-input="setting-list">` inside an
// `<m-for>` over `settingsForm.fields`; Margin keeps each in step with its
// field (value, checked, options, bounds, disabled, placeholder) and saves
// a change through the field's own rule, never the theme's. A shortcut
// field records the next key combination pressed in it (Escape cancels;
// a combination another shortcut has is refused with a word saying which),
// and Margin's own shortcuts wait meanwhile (`ui.recording`).
import { saveField, runField, shortcutTaken, wokeText, SHORTCUT_HELP } from '../settings-form.js';
import * as shortcuts from '../../shared/shortcuts.js';

const NAMES = new Set(['setting-number', 'setting-toggle', 'setting-choice', 'setting-list', 'setting-shortcut']);

/** @param {any} rt */
export function installSettings(rt) {
  const { view, container, doc } = rt;
  const nameOf = (el) => view.inputs.get(el);
  const isSetting = (el) => !!el && NAMES.has(nameOf(el));
  // The field as the form has it now (not what the theme's scope says).
  const fieldOf = (el) => {
    const id = view.subjectOf(el)?.id;
    return rt.vm?.settingsForm?.fields.find((f) => f.id === id) ?? null;
  };
  const focused = () => /** @type {any} */ (container).activeElement ?? doc.activeElement;
  const status = (key, text, error = false) => rt.setUi({ settingsStatus: { ...(rt.ui.settingsStatus ?? {}), [key]: text == null ? undefined : { text, error } } });

  function sync() {
    const root = view.rootElement();
    if (!root || !rt.vm?.settingsForm) return;
    for (const el of root.querySelectorAll('[m-input^="setting-"]')) {
      if (!isSetting(el)) continue;
      const f = fieldOf(el);
      if (!f) continue;
      const input = /** @type {any} */ (el);
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

  function save(el, value) {
    const f = fieldOf(el);
    const request = saveField(f, value, rt.state?.settings);
    if (!request) { sync(); return false; } // back to what's saved
    // Margin.app's own setting: the app saves it, and its next `across` says so.
    if ('perform' in request) return rt.host.perform?.(request.perform, request.arg) !== false;
    void rt.host.send(request.type, request.payload);
    return true;
  }

  rt.listen(container, 'change', (/** @type {Event} */ e) => {
    const el = /** @type {any} */ (e.target);
    if (!isSetting(el)) return;
    const name = nameOf(el);
    if (name === 'setting-shortcut') return;
    save(el, name === 'setting-toggle' ? !!el.checked : el.value);
  });
  // A shortcut field: recording while it has the focus.
  rt.listen(container, 'focusin', (/** @type {FocusEvent} */ e) => {
    const el = e.target;
    if (nameOf(el) !== 'setting-shortcut') return;
    const f = fieldOf(el);
    if (f) rt.setUi({ recording: f.id });
  });
  rt.listen(container, 'focusout', (/** @type {FocusEvent} */ e) => {
    if (nameOf(e.target) === 'setting-shortcut' && rt.ui.recording) rt.setUi({ recording: null });
  });
  // Capture phase, so recording wins over Margin's shortcuts themselves.
  rt.listen(container, 'keydown', (/** @type {KeyboardEvent} */ e) => {
    const el = /** @type {any} */ (e.target);
    if (!rt.ui.recording || nameOf(el) !== 'setting-shortcut') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') return void el.blur();
    const combo = shortcuts.fromEvent(e);
    if (!combo || !shortcuts.parse(combo)) return;
    const f = fieldOf(el);
    if (!f) return;
    const taken = shortcutTaken(f.id, combo, rt.state?.settings);
    if (taken) return void status('shortcuts', taken, true);
    status('shortcuts', SHORTCUT_HELP);
    save(el, combo);
    el.blur();
  }, true);

  return {
    afterRender() { sync(); },
    /** A button of the form (settings.run). */
    run(id) {
      const f = rt.vm?.settingsForm?.fields.find((x) => x.id === id && x.isButton);
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

// The system's materials for Margin.app's page (macOS's Liquid Glass: `-apple-visual-effect`). WebKit knows the
// property only in a web view with its system appearance on, which Margin.app turns on and off when the page asks
// (the `appearance` message: app/platforms/macos/shell/OverlayWebView.swift OverlaySystemAppearance). It changes more
// than the property (links' colours, and in a dark appearance `color-scheme: light` is no longer honoured: Settings'
// native controls), so it's on only while something drawn asks for it:
// - the theme drawn, when its theme.json says `systemMaterials` (DECISIONS.md "Liquid Glass");
// - Edit Theme Color's panel while it's open (M2.9 step 5: ui/behaviors/background-picker.ts, which doesn't ask while
//   Settings is on screen; DECISIONS.md "M2.9 step 5 spike").
// A sheet keeps or drops the property as it's read, so each asks before its sheet is made and waits for the answer. A
// theme is never read with them on for the panel: a theme that doesn't ask for them would keep the property (the
// sanitizer lets it through; the switch is what keeps it out). So reading a theme drops the panel's want first (the
// panel goes with the runtime that theme replaces), and a want the panel says while a theme is being read waits (that
// panel is drawn solid). Without the app's answer (Windows, the extension, an older Margin.app) nothing turns on.
// Pure but for `ask` and `known`: tests/host-materials.test.ts.

export type Materials = ReturnType<typeof createMaterials>;

/**
 * @param ask the app asked to turn them on or off; resolves to `true` when they're on
 * @param known whether this page knows the property now (`CSS.supports`)
 */
export function createMaterials(ask: (on: boolean) => Promise<unknown>, known: () => boolean) {
  let asked: boolean | null = null; // as last asked (null: not yet)
  let answered: Promise<void> = Promise.resolve(); // the last ask's answer (an ask the same way waits for it)
  let theme = false;
  let panel = false;
  let reading = false;

  function follow(): Promise<void> {
    const on = theme || (panel && !reading);
    if (on === asked) return answered;
    asked = on;
    answered = (async () => {
      let answer: unknown = null;
      try { answer = await ask(on); } catch { return; }
      if (!on || answer !== true) return;
      // On, as the app says: the page knows it by the time the answer comes (seen every time, off screen); if a
      // WebKit ever tells the page later, wait for that, 160 ms at most.
      for (let i = 0; i < 10 && !known(); i++) await new Promise((resolve) => setTimeout(resolve, 16));
    })();
    return answered;
  }

  return {
    /**
     * A theme read (`read`: its sheets made) with what it asks for (`wants`: theme.json `systemMaterials`) on or off,
     * the panel's want dropped first and held off while it's read.
     */
    async readTheme<T>(wants: boolean, read: () => Promise<T>): Promise<T> {
      theme = wants;
      panel = false;
      reading = true;
      try {
        await follow();
        return await read();
      } finally { reading = false; }
    },
    /** Edit Theme Color's panel: they're wanted while it's open; resolves once the page has the answer. */
    panel(on: boolean): Promise<void> {
      panel = on;
      return follow();
    },
    /** As last asked of the app (for the tests). */
    get asked() { return asked; },
  };
}

// Registered before content/page.bundle.js where Margin works only in full
// screen (background/registered.ts): that script leaves a window showing the
// browser's toolbar alone. Plain script, not bundled.
// (The page's world's start options, by a symbol only Margin knows: main.ts reads them. No variable: this runs
// in the page's own world, where one would be the page's global.)
(window as any)[Symbol.for('margin.page.start')] = { ...(window as any)[Symbol.for('margin.page.start')], fullscreenOnly: true };

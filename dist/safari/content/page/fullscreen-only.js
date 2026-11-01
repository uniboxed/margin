// Registered before content/page.bundle.js where Margin works only in full
// screen (background/registered.js): that script leaves a window showing the
// browser's toolbar alone. Plain script, not bundled.
window[Symbol.for('margin.page.start')] = { ...window[Symbol.for('margin.page.start')], fullscreenOnly: true };

// Registered before content/shell.js (background/registered.js) while
// Margin works only in full screen (Chrome): the shell then skips windows
// that still show the toolbar.
(globalThis.Margin ??= {}).shellFullscreenOnly = true;

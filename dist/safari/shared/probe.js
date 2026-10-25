// Empty on purpose. The injection probe (removed) registered a content script
// with this file. Safari keeps registered scripts across reloads, and if any
// stored one names a missing file it loads none of the extension's
// registered scripts (WebKit WebExtensionContext::loadRegisteredContentScripts),
// which also stopped the docked placeholder and the fitted layout. With the
// file present they all load, and the background unregisters the probe's
// leftover (background.js dropProbe). Delete after a release or two.

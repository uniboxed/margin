// Content script entry (bundled into content/content.bundle.js): Margin's
// core on the page, then the palette's keys once the UI is there. Nothing
// when Margin already runs in this page (WebKit runs content scripts again,
// in the same world, when Margin's site permissions change), so the
// palette's shortcut isn't added twice.
import { startCore } from './core.js';
import { wirePalette } from './palette.js';

startCore({ onTheme: () => wirePalette(globalThis.Margin.content) });

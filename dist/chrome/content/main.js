// Content script entry (bundled into content/content.bundle.js): the sidebar,
// then the palette on top of it. Nothing when Margin already runs in this
// page (WebKit runs content scripts again, in the same world, when Margin's
// site permissions change), so the palette's shortcut isn't added twice.
import { startSidebar } from './sidebar.js';
import { wirePalette } from './palette.js';

if (startSidebar()) wirePalette(globalThis.Margin.content);

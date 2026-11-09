// Content script entry (bundled into content/content.bundle.js): Margin's
// core on the page (content/core.ts). Nothing when Margin already runs in
// this page (WebKit runs content scripts again, in the same world, when
// Margin's site permissions change), so its keys aren't added twice.
import { startCore } from './core.ts';

startCore();

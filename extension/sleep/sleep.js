// A sleeping tab's page (shared/sleep.js startSleepPage). A module of its
// own, not bundled: it loads only the sleep helpers.
import { startSleepPage } from '../shared/sleep.js';

startSleepPage({ win: window, doc: document, api: globalThis.browser ?? globalThis.chrome });

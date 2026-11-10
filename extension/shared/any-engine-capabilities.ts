// `#engine/capabilities` unbuilt (unit tests in Node: package.json "imports"): either engine's capabilities, by the
// extension's own URL scheme. A build resolves `#engine/capabilities` to its own engine's alone (scripts/build.ts).
import { capabilities as safari } from '../engines/webkit/safari/capabilities.ts';
import { capabilities as chrome } from '../engines/chromium/capabilities.ts';

// Each build's, by its name.
export const CAPABILITIES = { safari, chrome };
const detect = () => {
  try {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api?.runtime?.getURL?.('').startsWith('safari-web-extension:') ? 'safari' : 'chrome';
  } catch {
    return 'chrome';
  }
};
export const capabilities = CAPABILITIES[detect()];

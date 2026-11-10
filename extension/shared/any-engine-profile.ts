// `#engine/profile` unbuilt (unit tests in Node: package.json "imports"): either engine's profile, by the
// extension's own URL scheme. A build resolves `#engine/profile` to its own engine's alone (scripts/build.ts).
import { profile as safari } from '../engines/webkit/safari/profile.ts';
import { profile as chrome } from '../engines/chromium/profile.ts';

export const PROFILES = { safari, chrome };
const detect = () => {
  try {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api?.runtime?.getURL?.('').startsWith('safari-web-extension:') ? 'safari' : 'chrome';
  } catch {
    return 'chrome';
  }
};
export const profile = PROFILES[detect()];

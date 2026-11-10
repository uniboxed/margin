// `#engine` unbuilt (unit tests in Node: package.json "imports"): the modules of the engine whose profile
// applies (any-engine-profile.ts). A build resolves `#engine` to its own engine's alone (scripts/build.ts).
import { profile } from '#engine/profile';
import { engine as safari } from '../engines/webkit/safari/engine.ts';
import { engine as chromium } from '../engines/chromium/engine.ts';

export const engine = profile.name === 'safari' ? safari : chromium;

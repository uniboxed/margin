// `#engine` unbuilt (unit tests in Node: package.json "imports"): the modules of the engine whose capabilities
// apply (any-engine-capabilities.ts). A build resolves `#engine` to its own engine's alone (scripts/build.ts).
import { capabilities } from '#engine/capabilities';
import { engine as safari } from '../engines/webkit/safari/engine.ts';
import { engine as chromium } from '../engines/chromium/engine.ts';

export const engine = capabilities.name === 'safari' ? safari : chromium;

// The recorder's hooks (tests/library-vectors/record.ts runs each test file as `node --import ./hooks.ts file`): every
// import of app/shared/library/library.ts from a test goes to wrap.ts (the same module, its calls recorded), and every
// import of node:test to node-test.ts (the same, the running test's name kept for the recording). What's recorded is
// written, one call a line, to LIBRARY_VECTORS_OUT when the process ends.
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
import { calls } from './log.ts';

const LIBRARY = new URL('../../app/shared/library/library.ts', import.meta.url).href;
const WRAP = new URL('./wrap.ts', import.meta.url).href;
const NODE_TEST = new URL('./node-test.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    const own = parent === WRAP || parent === NODE_TEST;
    if (specifier === 'node:test' && !own && parent.includes('/tests/')) return { url: NODE_TEST, shortCircuit: true };
    const resolved = nextResolve(specifier, context);
    if (resolved.url === LIBRARY && !own && parent.includes('/tests/')) return { url: WRAP, shortCircuit: true };
    return resolved;
  },
});

const out = process.env.LIBRARY_VECTORS_OUT;
if (out) process.on('exit', () => writeFileSync(out, calls.map((c) => JSON.stringify(c)).join('\n')));

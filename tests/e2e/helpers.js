import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// Resolve playwright from local node_modules or the globally installed copy.
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export const EXTENSION_PATH = fileURLToPath(new URL('../../extension', import.meta.url));

export async function launch() {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  return { context, worker, extensionId };
}

// Tiny local site so content scripts have an http(s) page to match.
export async function startServer() {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1).split('?')[0]) || 'home';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>${name}</title><body style="margin:0"><h1>${name}</h1></body>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Closed shadow roots are invisible to page JS and Playwright locators, but
// the DevTools protocol can pierce them. Runs `fn` with `this` = shadow root.
export async function evalInShadow(page, hostTag, fn, ...args) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = findNode(root, (n) => n.localName === hostTag);
    if (!host?.shadowRoots?.length) return undefined;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: host.shadowRoots[0].backendNodeId });
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fn.toString(),
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  } finally {
    await cdp.detach();
  }
}

function findNode(node, pred) {
  if (pred(node)) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = findNode(child, pred);
    if (found) return found;
  }
  return null;
}

export async function waitFor(check, { timeout = 5000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out (last value: ${JSON.stringify(last)})`);
}

// The overlay page's bridge to its shell (extension/ui/overlay-bridge.ts): WebKit's handler on the Mac, used as
// it was; WebView2's on Windows, its replies matched to requests by `rid`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBridge } from '../extension/ui/overlay-bridge.ts';

function fakeWebView2() {
  const posted: any[] = [];
  const listeners: ((event: { data: unknown }) => void)[] = [];
  return {
    posted,
    answer: (data: unknown) => { for (const l of listeners) l({ data }); },
    webview: {
      postMessage: (m: unknown) => { posted.push(m); },
      addEventListener: (_type: 'message', l: (event: { data: unknown }) => void) => { listeners.push(l); },
    },
  };
}

test('no shell: no bridge', () => {
  assert.equal(pickBridge({}), null);
  assert.equal(pickBridge(null), null);
  assert.equal(pickBridge({ chrome: { webview: { postMessage: 1 } } }), null);
});

test("WebKit's handler is called as before, its promise passed on", async () => {
  const seen: unknown[] = [];
  const handler = { postMessage(m: unknown) { seen.push([this === handler, m]); return Promise.resolve('{"hello":1}'); } };
  const post = pickBridge({ webkit: { messageHandlers: { margin: handler } }, chrome: { webview: fakeWebView2().webview } });
  assert.ok(post);
  assert.equal(await post({ op: 'hello' }), '{"hello":1}');
  assert.deepEqual(seen, [[true, { op: 'hello' }]]);
});

test("WebView2: each message gets a rid, and the shell's replies settle their own requests", async () => {
  const fake = fakeWebView2();
  const post = pickBridge({ chrome: { webview: fake.webview } });
  assert.ok(post);
  const hello = post({ op: 'hello' });
  const log = post({ op: 'log', level: 'note', text: 'x' });
  assert.deepEqual(fake.posted, [{ op: 'hello', rid: 1 }, { op: 'log', level: 'note', text: 'x', rid: 2 }]);
  fake.answer({ reply: 2, ok: false, error: 'no' });
  fake.answer({ reply: 1, ok: true, value: '{"windowId":7}' });
  fake.answer({ reply: 1, ok: true, value: 'again' }); // already settled: ignored
  fake.answer({ reply: 'x', ok: true }); // not a reply
  fake.answer(null);
  assert.equal(await hello, '{"windowId":7}');
  await assert.rejects(log, /^Error: no$/);
});

test('WebView2: a post that throws rejects, and leaves nothing waiting', async () => {
  const fake = fakeWebView2();
  fake.webview.postMessage = () => { throw new Error('gone'); };
  const post = pickBridge({ chrome: { webview: fake.webview } });
  assert.ok(post);
  await assert.rejects(post({ op: 'ready' }), /gone/);
});

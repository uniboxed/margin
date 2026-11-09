// How the overlay page reaches the shell that shows it: `post(message)` gives a promise of the shell's reply.
// - Margin.app on the Mac (WKWebView, app/shell/OverlayWebView.swift): `webkit.messageHandlers.margin.postMessage`
//   returns that promise itself (a handler with reply).
// - Margin for Windows (WebView2, native/margin-windows/src/webview.rs): `chrome.webview.postMessage` returns
//   nothing, so each message carries a request id, `rid`, and the shell answers every one with
//   `PostWebMessageAsJson({ reply: rid, ok, value })` or `{ reply: rid, ok: false, error }`, heard here as the
//   webview's `message` event. A reply with no request waiting is ignored.
// The shell talks to the page the same way on both: it runs `marginApp.receive(json)` (app/overlay/overlay.ts).
export type Post = (message: Record<string, unknown>) => Promise<unknown>;

type WebKitHandler = { postMessage(message: unknown): Promise<unknown> };
type WebView2 = {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
};

export function pickBridge(scope: unknown): Post | null {
  const g = scope as { webkit?: { messageHandlers?: { margin?: WebKitHandler } }, chrome?: { webview?: WebView2 } } | null;
  const webkit = g?.webkit?.messageHandlers?.margin;
  if (webkit) return (message) => webkit.postMessage(message);
  const webview = g?.chrome?.webview;
  if (webview && typeof webview.postMessage === 'function' && typeof webview.addEventListener === 'function') return webView2Bridge(webview);
  return null;
}

export function webView2Bridge(webview: WebView2): Post {
  let last = 0;
  const waiting = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>();
  webview.addEventListener('message', (event) => {
    const data = event?.data as { reply?: unknown, ok?: unknown, value?: unknown, error?: unknown } | null;
    if (!data || typeof data !== 'object' || typeof data.reply !== 'number') return;
    const request = waiting.get(data.reply);
    if (!request) return;
    waiting.delete(data.reply);
    if (data.ok === true) request.resolve(data.value);
    else request.reject(new Error(typeof data.error === 'string' ? data.error : 'the app refused it'));
  });
  return (message) => new Promise((resolve, reject) => {
    const rid = ++last;
    waiting.set(rid, { resolve, reject });
    try {
      webview.postMessage({ ...message, rid });
    } catch (error) {
      waiting.delete(rid);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

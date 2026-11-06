// The lab's stand-in for Margin's background page (tools/handoff-lab): it polls the lab's local
// server for commands and runs them with the windows and tabs APIs, as Margin's copy does. It
// also reports focus changes and new tabs (gate G9), as ids and times only.
const base = 'http://127.0.0.1:47944';

async function run(c) {
  try {
    if (c.op === 'getAll') return (await browser.windows.getAll({})).map(w => ({ id: w.id, state: w.state, focused: w.focused, left: w.left, top: w.top, width: w.width, height: w.height }));
    if (c.op === 'get') { const w = await browser.windows.get(c.id); return { id: w.id, state: w.state, focused: w.focused, left: w.left, top: w.top, width: w.width, height: w.height }; }
    if (c.op === 'update') { const t = Date.now(); const w = await browser.windows.update(c.id, c.props); return { id: w.id, state: w.state, focused: w.focused, calledAt: t, answeredAt: Date.now() }; }
    if (c.op === 'create') { const w = await browser.windows.create(c.props); return { id: w.id, state: w.state, tabId: w.tabs && w.tabs[0] ? w.tabs[0].id : null }; }
    if (c.op === 'remove') { await browser.windows.remove(c.id); return { removed: c.id }; }
    // any windows or tabs function: { op: 'call', api: 'tabs', fn: 'query', args: [{ windowId: 3 }] }
    if (c.op === 'call' && ['windows', 'tabs'].includes(c.api)) {
      const r = await browser[c.api][c.fn](...(c.args || []));
      return JSON.parse(JSON.stringify(r === undefined ? null : r));
    }
    if (c.op === 'ping') return 'pong';
    return { error: 'unknown op' };
  } catch (e) { return { error: String(e) }; }
}

function report(id, body) {
  fetch(base + '/r?id=' + id, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
}

// Focus and new tabs: ids and times only, never an address or a title.
const events = [];
function event(e) { events.push(Object.assign({ at: Date.now() }, e)); if (events.length > 200) events.shift(); report('events', { list: events }); }
browser.windows.onFocusChanged.addListener(id => event({ k: 'focus', windowId: id }));
browser.tabs.onCreated.addListener(t => event({ k: 'tab', windowId: t.windowId, tabId: t.id }));

async function loop() {
  for (;;) {
    try {
      const r = await fetch(base + '/cmd?for=ext', { cache: 'no-store' });
      const c = r.status === 200 ? await r.json() : null;
      if (c) { const t = Date.now(); const res = await run(c); fetch(base + '/res?id=' + c.cid, { method: 'POST', body: JSON.stringify({ res, ms: Date.now() - t }) }); continue; }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 15));
  }
}
// Said again every 2 s, so a lab that starts its server later still hears it.
report('ext', { hello: true, t: Date.now() });
setInterval(() => report('ext', { hello: true, t: Date.now() }), 2000);
loop();

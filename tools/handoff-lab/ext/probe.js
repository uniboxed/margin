// The lab's frame probe, in every page of the lab's server (tools/handoff-lab, gate G2). It is
// the probe docs/HANDOFF.md §3.2 describes (R3), so the gate measures that signal:
// - `probe { frames, nudgeMs, timeoutMs }`: a 1×1 fixed element outside the layout, its alpha
//   flipped between 0.01 and 0.02 each frame for nudgeMs, and an answer after `frames`
//   requestAnimationFrames: { frames, firstAt, lastAt, width, height, hasFocus, visible, visibleAt }.
// - `arm`: from now on, every rAF's time and every visibilitychange is kept (a ring), so the lab
//   can see when rAF resumed and when the page turned visible, against its own R1/R2 times.
// - `dump`: posts what was kept. Times are Date.now() (ms since 1970), the lab's clock too.
// Commands come from the server's queue for `probe-<id>` (the page's ?id=). Answers go to the
// server's reports as `probe-<id>` (a probe), `dump-<id>` and `armed-<id>`. Nothing about the
// page (address, title, text) is ever sent: numbers only.
(() => {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return;
  const base = 'http://127.0.0.1:47944';
  const kept = { raf: [], vis: [], armedAt: 0 };
  let visibleAt = document.visibilityState === 'visible' ? Date.now() : 0;
  document.addEventListener('visibilitychange', () => {
    const at = Date.now();
    if (document.visibilityState === 'visible') visibleAt = at;
    if (kept.armedAt) { kept.vis.push([at, document.visibilityState]); if (kept.vis.length > 50) kept.vis.shift(); }
  });
  function tick() {
    if (kept.armedAt) { kept.raf.push(Date.now()); if (kept.raf.length > 600) kept.raf.shift(); requestAnimationFrame(tick); }
  }
  function post(kind, body) { fetch(base + '/r?id=' + kind + '-' + id, { method: 'POST', body: JSON.stringify(body) }).catch(() => {}); }

  function probe(c) {
    const frames = c.frames || 6, nudgeMs = c.nudgeMs || 80, timeoutMs = c.timeoutMs || 400;
    const asked = Date.now();
    const dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:2147483647;background:#000;opacity:0.01;contain:strict';
    (document.body || document.documentElement).appendChild(dot);
    let n = 0, firstAt = 0, lastAt = 0, done = false;
    const finish = (none) => {
      if (done) return; done = true; dot.remove();
      post('probe', none ? { probe: c.n, none, askedAt: asked, visibleAt }
        : { probe: c.n, frames: n, firstAt, lastAt, askedAt: asked, width: innerWidth, height: innerHeight, hasFocus: document.hasFocus(), visible: document.visibilityState === 'visible', visibleAt });
    };
    const frame = () => {
      if (done) return;
      const at = Date.now();
      if (!firstAt) firstAt = at;
      lastAt = at; n++;
      if (at - asked <= nudgeMs) dot.style.opacity = n % 2 ? '0.02' : '0.01';
      if (n >= frames && at - asked >= nudgeMs) return finish();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    setTimeout(() => finish('no frames'), timeoutMs);
  }

  async function poll() {
    for (;;) {
      try {
        const r = await fetch(base + '/cmd?for=probe-' + id, { cache: 'no-store' });
        if (r.status === 200) {
          const c = await r.json();
          if (c.op === 'probe') probe(c);
          if (c.op === 'arm') { kept.raf = []; kept.vis = []; kept.armedAt = Date.now(); requestAnimationFrame(tick); post('armed', { armed: kept.armedAt }); }
          if (c.op === 'dump') { post('dump', { dump: c.n, armedAt: kept.armedAt, raf: kept.raf, vis: kept.vis, visibleAt }); kept.armedAt = 0; }
          continue;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 40));
    }
  }
  poll();
})();

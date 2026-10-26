// The frames to try, shared by the extension page and the web-page test.
// Each says what you see if Safari strips the headers (rule 1) and if not.
globalThis.DNR_FRAMES = [
  { label: 'Baseline: example.com (sends no framing headers)', url: 'https://example.com/?frame', ifStripped: 'shows', ifNot: 'shows' },
  { label: 'Control: request-header rule (rule 2)', url: 'https://httpbin.org/headers', ifStripped: 'JSON with "Accept-Language": "xx-DNR-WORKS"', ifNot: 'same: request rules work either way' },
  { label: 'httpbin sending X-Frame-Options: DENY', url: 'https://httpbin.org/response-headers?X-Frame-Options=DENY', ifStripped: 'JSON shows', ifNot: 'blank' },
  { label: "httpbin sending CSP frame-ancestors 'none'", url: "https://httpbin.org/response-headers?Content-Security-Policy=frame-ancestors%20'none'", ifStripped: 'JSON shows', ifNot: 'blank' },
  { label: 'GitHub (XFO deny + frame-ancestors none)', url: 'https://github.com/', ifStripped: 'GitHub shows', ifNot: 'blank' },
  { label: 'Google (XFO SAMEORIGIN)', url: 'https://www.google.com/', ifStripped: 'Google shows', ifNot: 'blank' },
  { label: 'MDN (XFO DENY)', url: 'https://developer.mozilla.org/en-US/', ifStripped: 'MDN shows', ifNot: 'blank' },
];
globalThis.dnrGrid = (doc) => {
  const grid = doc.createElement('div');
  grid.className = 'dnr-grid';
  for (const f of globalThis.DNR_FRAMES) {
    const cell = doc.createElement('section');
    const h = doc.createElement('h3');
    h.textContent = f.label;
    const p = doc.createElement('p');
    p.textContent = `Stripped: ${f.ifStripped}. Not stripped: ${f.ifNot}.`;
    const frame = doc.createElement('iframe');
    frame.src = f.url;
    cell.append(h, p, frame);
    grid.append(cell);
  }
  return grid;
};

// When the box (box.ts) reads what the page says about <body> again
// (box-body.ts): what was read before for the same attributes, how often a read
// may run, and what makes one due: the page's styles or attributes changing, a
// new <body> or <html>, things put directly under <html>, and the window resizing.

// Reading what a page says about <body>: at most this often, twice as far apart
// after each read that found nothing new and back at once after one that did,
// at most 1/MEASURE_SHARE of the time, and never put off for longer than MEASURE_WAIT_MS.
const MEASURE_GAP_MS = 200;
const MEASURE_SHARE = 20;
const MEASURE_WAIT_MS = 1000;
// Readings kept by the attributes of <html> and <body>, for a class that comes and goes.
const KNOWN_READINGS = 16;

/** @param ctx the box's shared parts (box.ts) */
export function startWatch(ctx: any) {
  const { box, own } = ctx;
  const attributesOf = (node) => (node ? Array.from(node.attributes, ({ name, value }) => `${name}=${value}`).join(' ') : '');

  // What a page has said for these attributes, as long as nothing but the
  // attributes changed: a class that comes and goes costs two reads, and then
  // none. Sheets, rules, the first child, `:has()` or the box's width changing
  // forgets all of it (stale).
  const known = new Map();
  let readAt = { attributes: '', sheets: -1, first: (null as Element | null), stale: true };
  const attributesNow = () => `${attributesOf(ctx.html)} ${attributesOf(document.body)}`;
  function remember(said) {
    const attributes = attributesNow();
    readAt = { attributes, sheets: document.styleSheets.length, first: document.body.firstElementChild, stale: false };
    if (said.plain) {
      if (known.size >= KNOWN_READINGS) known.clear();
      known.set(attributes, { said, key: ctx.lastSaid });
    }
    for (const fn of box.onRead) fn();
  }
  function stale() {
    known.clear();
    readAt.stale = true;
    measureGap = MEASURE_GAP_MS;
  }
  function useKnown({ said, key }) {
    ctx.lastSaid = key;
    ctx.lastPage = JSON.stringify({ ...said, whole: 0 });
    readAt.attributes = attributesNow();
    own.setRootZoom(said.rootZoom);
    ctx.body.applyKnown(said);
  }
  // At the end of parsing and at `load`: a page that needs a layout always, as
  // its width follows the content, and any other only if something changed.
  const nothingSince = () => !readAt.stale && readAt.attributes === attributesNow() && readAt.first === document.body?.firstElementChild && readAt.sheets === document.styleSheets.length;
  function loaded() {
    if (!box.on || !document.body) return;
    bodyArrived();
    if (!ctx.plainPage || !nothingSince()) ctx.body.measureBody();
    ctx.locks.checkLocks();
  }

  // Apps bring their styles after `load`, by a script, so what was read may no
  // longer be what the page says: read again when its styles change, before
  // the next paint. Out of sight it waits to be shown.
  let measureDue = false;
  let measureTimer = 0;
  let measureFrame = 0;
  let measureAt = 0;
  let measureCost = 0;
  let measureGap = MEASURE_GAP_MS;
  function runMeasure() {
    measureFrame = 0;
    measureDue = false;
    if (nothingSince()) return; // a read came first: the end of parsing, `load`, a moved box
    const reading = known.get(attributesNow());
    if (reading && document.fullscreenElement !== document.body) return useKnown(reading);
    const started = performance.now();
    ctx.pageNew = false;
    const changed = ctx.body.measureBody(false);
    ctx.moves.found(ctx.pageNew);
    measureGap = changed ? MEASURE_GAP_MS : Math.min(MEASURE_WAIT_MS, measureGap * 2);
    ctx.locks.checkLocks();
    measureAt = performance.now();
    measureCost = measureAt - started;
  }
  function measureSoon() {
    if (!box.on || measureFrame) return;
    const reading = known.get(attributesNow());
    if (reading?.key === ctx.lastSaid) return; // these attributes say what's already in force
    measureDue = true;
    if (document.hidden) return;
    clearTimeout(measureTimer);
    const wait = reading ? 0 : Math.max(0, measureAt + Math.min(MEASURE_WAIT_MS, Math.max(measureGap, measureCost * MEASURE_SHARE)) - performance.now());
    measureTimer = setTimeout(() => { measureFrame = requestAnimationFrame(forFrame(runMeasure)); }, wait);
  }
  function bodyMayHaveChanged() {
    stale();
    measureSoon();
  }

  // What <html>'s and <body>'s class and style say can lock the page. At most
  // once a frame, and not if neither changed.
  let lockKey = '';
  let lockFrame = 0;
  const lockChanged = () => {
    const key = `${attributesOf(ctx.html)} ${attributesOf(document.body)}`;
    if (key === lockKey) return;
    lockKey = key;
    measureSoon(); // any attribute can select what <body>'s size and margins are
    lockFrame ||= requestAnimationFrame(locksCheck);
  };
  function locksCheck() {
    lockFrame = 0;
    ctx.locks.checkLocks();
  }
  const attributeWatch = new MutationObserver(lockChanged);
  const ATTRIBUTES = { attributes: true };
  attributeWatch.observe(ctx.html, ATTRIBUTES);

  // An absolute element a page puts directly under <html> is placed against
  // the document, which scrolls: it would stay put here, so it goes in <body>.
  const adoptChild = (node) => {
    if (!box.on || !document.body || node === document.body || node.nodeType !== 1 || node.parentNode !== ctx.html) return;
    if (/^(head|body|script|style|link|meta|margin-.*)$/.test(node.localName)) return;
    if (getComputedStyle(node).position === 'absolute') document.body.append(node);
  };
  // A read of <body> while the page's sheets that hold its first paint are still loading waits for the frame
  // (box-body.ts measureBody asks): nothing is drawn before they're in, and no script of the page's after them
  // runs, so a read before them only read the browser's own margins (GitHub: 8px written as padding, taken back
  // once its sheets came: a second restyle of the whole page in WebKit). A sheet's arrival asks for a read for
  // that frame anyway (sheets.ts); whichever comes second finds nothing new. A tab out of sight has no frames:
  // its reads go on as they come (`loaded` makes one), as a tab loaded behind is ready when it's shown.
  let firstRead = 0;
  const holdsPaint = (link) => !link.sheet && !link.disabled && link.relList.contains('stylesheet') && !link.relList.contains('alternate') && (!link.media || matchMedia(link.media).matches);
  function sheetsPending() {
    for (const link of document.getElementsByTagName('link')) if (holdsPaint(link)) return true;
    return false;
  }
  // A read made for a frame (this one, runMeasure's, a resize's) never waits: the frame is being drawn, sheets
  // in or not (a browser draws without them once they're slow enough).
  let inFrame = 0;
  const forFrame = (fn) => (...args) => {
    inFrame += 1;
    try {
      return fn(...args);
    } finally {
      inFrame -= 1;
    }
  };
  const holdsRead = () => !inFrame && !document.hidden && sheetsPending();
  function readAtFrame() {
    firstRead ||= requestAnimationFrame(readFirst);
  }
  function readBody() {
    cancelAnimationFrame(firstRead);
    firstRead = 0;
    // Its scroll first: its sheet then comes in the restyle the read starts with, not one after it (WebKit
    // styles the whole page again for each sheet edited). Neither looks at what the other writes.
    ctx.locks.checkLocks();
    ctx.body.measureBody();
  }
  const readFirst = forFrame(() => {
    firstRead = 0;
    if (!nothingSince()) readBody();
  });

  // The <body> in the page: the first one, or one the page swapped in (Turbo
  // and the like), with a margin and locks of its own.
  let bodyNow = null;
  function bodyArrived() {
    const { body } = document;
    if (!body || body === bodyNow) return;
    if (body.localName !== 'body') { // a frameset
      ctx.off();
      ctx.refused = true;
      return;
    }
    bodyNow = body;
    attributeWatch.observe(body, ATTRIBUTES);
    ctx.locks.forgetBody(); // what's said about the old one mustn't read as the new one's
    stale();
    readBody();
    for (const fn of box.onBody) fn();
  }
  function childrenAdded(records) {
    bodyArrived();
    if (!bodyNow) return;
    for (const record of records) for (const node of record.addedNodes) queueMicrotask(() => adoptChild(node));
  }
  const children = new MutationObserver(childrenAdded);
  const CHILDREN = { childList: true };
  children.observe(ctx.html, CHILDREN);
  // A new <html>: `document.write`, `document.open`, a framework that rendered
  // the whole document again. Margin's rules go by selector, so they hold; what
  // was watched on the old one has to be watched on this one.
  function rootArrived() {
    const root = document.documentElement;
    if (!root || root === ctx.html) return;
    ctx.html = root;
    attributeWatch.observe(root, ATTRIBUTES);
    children.observe(root, CHILDREN);
    bodyArrived();
  }
  // A body sized in percent, or centred, follows the window, at most once a
  // frame. Any other can be crossing a media query or changing with `vw`.
  let resizeFrame = 0;
  addEventListener('resize', (event) => {
    if (!event.isTrusted) return;
    if (!ctx.sized) return bodyMayHaveChanged();
    stale();
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(forFrame(resized));
  });
  function resized() {
    resizeFrame = 0;
    ctx.body.measureBody();
  }

  return {
    remember,
    stale,
    loaded,
    bodyMayHaveChanged,
    measureSoon,
    /** The page's sheets that hold its first paint are still loading: a read now would be thrown away. */
    holdsRead,
    /** A read at the next frame (one asked for once). */
    readAtFrame,
    /** A read that waited out of sight, as the page is shown. */
    measureIfDue: () => { if (measureDue) measureSoon(); },
    /** A length a read saw was on its way (box-body.ts moves): only this reading of its attributes is in doubt. */
    settleRead: () => {
      known.delete(attributesNow());
      readAt.stale = true;
      measureSoon();
    },
    /** A rule was edited, whether or not it reaches <body> now: it might once a class changes. */
    rulesEdited: () => known.clear(),
    bodyArrived,
    rootArrived,
  };
}

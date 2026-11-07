// Client coordinates: the page's origin is its box, not the window (the
// transform on <html> counts in what the browser reports; its scale is 1 since
// Margin's own pinch went, 2026-11-07). So what the page places by a rectangle (menus, tooltips) lands where
// it means, and points it asks about find what's there. One transform: where
// the box's corner is in the window, and its scale (box.x, box.y, box.scale).

const find = (object, name) => {
  for (let at = object; at; at = Object.getPrototypeOf(at)) {
    const descriptor = Object.getOwnPropertyDescriptor(at, name);
    if (descriptor) return descriptor;
  }
  return undefined;
};

export function startCoords(box) {
  const html = document.documentElement;
  const element = Element.prototype;
  const range = Range.prototype;
  const doc = Document.prototype;
  const shadow = ShadowRoot.prototype;
  const native = {
    elementRect: element.getBoundingClientRect, elementRects: element.getClientRects,
    rangeRect: range.getBoundingClientRect, rangeRects: range.getClientRects,
    fromPoint: doc.elementFromPoint, allFromPoint: doc.elementsFromPoint,
    caret: doc.caretRangeFromPoint, caretPosition: doc.caretPositionFromPoint,
    shadowFromPoint: shadow.elementFromPoint, shadowAllFromPoint: shadow.elementsFromPoint,
  };
  // Full screen shows something at the window's own origin.
  const { boxed } = box;
  // An element with no box of its own (display: contents, not rendered) has an
  // empty rectangle at 0, 0: not in the page's coordinates at all.
  const toPage = (rect) => {
    if (!boxed() || (!rect.x && !rect.y && !rect.width && !rect.height)) return rect;
    return new DOMRect((rect.x - box.x) / box.scale, (rect.y - box.y) / box.scale, rect.width / box.scale, rect.height / box.scale);
  };
  box.toPage = toPage; // in-view.js
  const listToPage = (list) => {
    const rects = Array.from(list, toPage);
    /** @type {any} */ (rects).item = (i) => rects[i] ?? null;
    return /** @type {any} */ (rects);
  };
  const windowX = (x) => (boxed() ? x * box.scale + box.x : x);
  const windowY = (y) => (boxed() ? y * box.scale + box.y : y);

  const scrollTop = find(element, 'scrollTop').get;
  const scrollLeft = find(element, 'scrollLeft').get;
  const scrollHeight = find(element, 'scrollHeight').get;
  const scrollWidth = find(element, 'scrollWidth').get;
  element.getBoundingClientRect = function () {
    // <html> and <body> as a document's: the page's whole height, moved by its scroll.
    if (boxed() && (this === html || this === document.body) && document.body) {
      const { body } = document;
      return new DOMRect(-scrollLeft.call(body), -scrollTop.call(body), scrollWidth.call(body), scrollHeight.call(body));
    }
    return toPage(native.elementRect.call(this));
  };
  element.getClientRects = function () { return listToPage(native.elementRects.call(this)); };
  range.getBoundingClientRect = function () { return toPage(native.rangeRect.call(this)); };
  range.getClientRects = function () { return listToPage(native.rangeRects.call(this)); };
  doc.elementFromPoint = function (x, y) { return native.fromPoint.call(this, windowX(x), windowY(y)); };
  doc.elementsFromPoint = function (x, y) { return native.allFromPoint.call(this, windowX(x), windowY(y)); };
  if (native.caret) doc.caretRangeFromPoint = function (x, y) { return native.caret.call(this, windowX(x), windowY(y)); };
  if (native.caretPosition) {
    // The third argument (the shadow roots to look in) goes through.
    doc.caretPositionFromPoint = function (x, y, ...rest) { return native.caretPosition.call(this, windowX(x), windowY(y), ...rest); };
    const clientRect = window.CaretPosition?.prototype.getClientRect;
    if (clientRect) window.CaretPosition.prototype.getClientRect = function () {
      const rect = clientRect.call(this);
      return rect && toPage(rect);
    };
  }
  if (native.shadowFromPoint) shadow.elementFromPoint = function (x, y) { return native.shadowFromPoint.call(this, windowX(x), windowY(y)); };
  if (native.shadowAllFromPoint) shadow.elementsFromPoint = function (x, y) { return native.shadowAllFromPoint.call(this, windowX(x), windowY(y)); };

  // The pointer: only events the browser made (one a page makes itself is
  // already in its own coordinates).
  const mouse = MouseEvent.prototype;
  const clientX = find(mouse, 'clientX').get;
  const clientY = find(mouse, 'clientY').get;
  const define = (name, get) => Object.defineProperty(mouse, name, { configurable: true, enumerable: true, get });
  define('clientX', function () {
    const x = clientX.call(this);
    return boxed() && this.isTrusted ? (x - box.x) / box.scale : x;
  });
  define('clientY', function () {
    const y = clientY.call(this);
    return boxed() && this.isTrusted ? (y - box.y) / box.scale : y;
  });
  define('x', function () { return this.clientX; });
  define('y', function () { return this.clientY; });
  define('pageX', function () { return this.clientX + scrollLeft.call(box.on ? box.body() : html); });
  define('pageY', function () { return this.clientY + scrollTop.call(box.on ? box.body() : html); });
}

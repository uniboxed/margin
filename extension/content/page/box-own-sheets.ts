// Margin's own sheets in the page, for the box (box.ts): the box's own rules,
// and <body>'s scroll (box-locks.ts), size and padding (box-body.ts), how it's
// read, and its background. Made in the page's own world and adopted, and kept
// adopted whatever the page does with its list.
import { bodyFitCss, boxCss, NO_BOX_CSS, SAID_CSS, STILL_CSS } from '../../shared/page-box.ts';

// Made with the box, before anything is in the page; `start` puts them in.
export function createOwnSheets() {
  // Sheets of the page's own world: `<style>` and style attributes are blocked by strict CSPs.
  const { replaceSync } = CSSStyleSheet.prototype;
  const sheet = () => new CSSStyleSheet();
  const sheets = {
    box: sheet(),
    scroll: sheet(), // how <body> scrolls (box-locks.ts checkLocks)
    fit: sheet(), // <body>'s size in the box (box-body.ts measureBody)
    padding: sheet(), // <body>'s margin as padding (box-body.ts measureBody)
    read: sheet(), // how <body> is read (box-body.ts readWithout, readSaid)
    back: sheet(), // <body>'s background drawn on <body> (box-locks.ts checkBackground)
  };
  const ours = [sheets.box, sheets.fit, sheets.scroll, sheets.padding, sheets.read, sheets.back];
  // Each written only when its text changes: WebKit styles the whole page again after any sheet is replaced,
  // even with the same text (20,000 rules: about 80 ms).
  const written: Map<CSSStyleSheet, string> = new Map();
  const replace = (target: CSSStyleSheet, css: string) => {
    if (written.get(target) === css) return;
    written.set(target, css);
    replaceSync.call(target, css);
  };

  // Never dropped by a page that assigns its own list, or edits the one it has,
  // which goes through a proxy of it, one that lets the page's edits be seen.
  const adopted = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets');
  const adopt = () => adopted.set.call(document, [...adopted.get.call(document).filter((s) => !ours.includes(s)), ...ours]);

  let box = null;
  let rootZoom = 1; // the page's `zoom` on <html> (box-body.ts readSaid)
  let rootClipsY = true; // <html> clips up and down (box-locks.ts checkLocks: not while the page says its overflow-x)
  const write = () => replace(sheets.box, box.on ? boxCss(box, rootZoom, rootClipsY) : NO_BOX_CSS);
  function setRootZoom(next: number) {
    if (next === rootZoom) return;
    rootZoom = next;
    write();
  }
  function setRootClipsY(next: boolean) {
    if (next === rootClipsY) return;
    rootClipsY = next;
    write();
  }

  function start(theBox: any) {
    box = theBox;
    let adoptDue = false;
    function adoptedEdited() {
      if (adoptDue) return;
      adoptDue = true;
      queueMicrotask(() => {
        adoptDue = false;
        adopt();
        box.bodyMayHaveChanged();
      });
    }
    const edit = (act) => (...args) => {
      const done = act(...args);
      adoptedEdited();
      return done;
    };
    const adoptedView = new Proxy(adopted.get.call(document), { set: edit(Reflect.set), deleteProperty: edit(Reflect.deleteProperty) });
    Object.defineProperty(document, 'adoptedStyleSheets', {
      configurable: true,
      enumerable: true,
      get() { return adoptedView; },
      set(list) {
        adopted.set.call(this, [...[...list].filter((s) => !ours.includes(s)), ...ours]);
        box.bodyMayHaveChanged();
      },
    });
    write();
    // As most pages' <body> ends up (it grows with its content: 23 of 27 sites looked at), so the first read
    // usually finds it so and writes nothing (box-body.ts writeFit). Nothing shows it before then: that read
    // comes with <body>.
    replace(sheets.fit, bodyFitCss({ grows: true }));
    replace(sheets.read, `${STILL_CSS} ${SAID_CSS}`);
    adopt();
  }

  return {
    sheets,
    ours,
    replace,
    write,
    setRootZoom,
    setRootClipsY,
    /** The page's adopted sheets as the browser has them (Margin's among them). */
    adoptedNow: () => adopted.get.call(document),
    start,
  };
}

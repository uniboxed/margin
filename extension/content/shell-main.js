// Fitted layout, page side, Safari (content/shell.js has the overview). Runs
// in the page's own world, in every frame, at document_start; it does
// nothing except in the card: the frame Margin wrote the page into, which
// Safari runs this in again once the page is in it. There it sets the card
// up (content/shell-card.js). Chrome doesn't run it again in the card, so
// there content/shell-writer.js does that from the top window.
import { setUpCard } from './shell-card.js';

(() => {
  if (window === top || location.href === 'about:blank' || location.href === 'about:srcdoc') return;
  let shelled = false;
  try {
    shelled = parent === top && location.ancestorOrigins?.[0] === location.origin
      && String(/** @type {HTMLIFrameElement | null} */ (frameElement)?.name).startsWith('margin-')
      && top.document.documentElement.hasAttribute('data-margin-shell');
  } catch {}
  if (shelled) setUpCard(window, top);
})();

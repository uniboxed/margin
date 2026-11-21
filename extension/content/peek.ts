// Content-script Peek link interceptor (Track 2 M2.5):
// - Shift+Click on any http/https link opens it in Peek.
// - Plain click on an external-domain link inside a Pinned tab or Favorite opens
//   in Peek when settings.autoPeekPins !== false (excluding OAuth/SSO flows).
import { isPeekableUrl, shouldAutoPeek } from '../shared/peek.ts';

export function startPeek({
  doc = document,
  isPinnedOrFav,
  autoPeekEnabled,
  onPeek,
}: {
  doc?: Document,
  isPinnedOrFav: () => boolean,
  autoPeekEnabled: () => boolean,
  onPeek: (url: string, source: 'shift-click' | 'auto-peek') => void,
}) {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as Element | null;
    const link = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!link) return;
    const href = link.href;
    if (!isPeekableUrl(href)) return;
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      onPeek(href, 'shift-click');
      return;
    }
    if (shouldAutoPeek({ href, currentUrl: doc.location?.href ?? '', fromPinnedOrFav: isPinnedOrFav(), autoPeekEnabled: autoPeekEnabled() })) {
      e.preventDefault();
      e.stopPropagation();
      onPeek(href, 'auto-peek');
    }
  };
  doc.addEventListener('click', onClick, true);
  return {
    destroy() {
      doc.removeEventListener('click', onClick, true);
    },
  };
}

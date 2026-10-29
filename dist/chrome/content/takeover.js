// A copy of Margin that finds another copy's sidebar in the page: Margin was
// installed or updated while the page was open. Called by content/core.js.
// Returns whether it's replacing one.
export function takeOver(api) {
  // A sidebar that isn't this world's was left by an earlier copy of Margin:
  // it was installed or updated while the page was open (WebKit adds this
  // copy to open pages in a world of its own; so does background.js
  // injectIntoOpenTabs elsewhere). It no longer works, but its scripts stay:
  // this copy takes over now, leaves swipe and pull-to-refresh to it (they act
  // on the page directly, so both would go back twice), and the page reloads
  // to start clean once that can't lose anything (reloadWhenSafe).
  // Copies that stand back for a newer one themselves (data-margin-v, set by
  // content/core.js) are left to do so: this copy may be the older one.
  // Every host of an earlier copy (any theme's: they're all margin-*-host).
  const hosts = [...(document.documentElement?.children ?? [])].filter((node) => /^margin-.*-host$/.test(node.localName) && !(/** @type {HTMLElement} */ (node)).dataset.marginV);
  const replacing = hosts.length > 0;
  if (replacing) {
    for (const stale of /** @type {HTMLElement[]} */ (hosts)) {
      stale.style.setProperty('display', 'none', 'important');
      stale.remove();
    }
    reloadWhenSafe();
  }
  // Hidden (not the tab in front, or once the user leaves it), nothing
  // typed into it (judged generously: any text in a field or editor, in any
  // same-origin frame, counts), no media playing or call going, and not done
  // in the last 30s (then it tries again after). Hidden tabs a few at a time.
  // The background loads the page's URL again once it has registered what a
  // page load needs (the fitted layout): a GET, not a reload, which would send
  // a form again; WebKit doesn't add a history entry for the same URL (with a
  // #fragment, which would only scroll, the browser's reload).
  function reloadWhenSafe() {
    const inUse = (doc, depth = 0) => {
      if (!doc || depth > 4) return false;
      const active = doc.activeElement;
      if (active && (active.isContentEditable || active.matches?.('textarea, select, input:not([type=hidden], [type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=image])'))) return true;
      for (const el of doc.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], input[type=password]')) if (el.value.trim()) return true;
      for (const el of doc.querySelectorAll('[contenteditable]:not([contenteditable=false])')) if (el.isContentEditable && el.textContent.trim()) return true;
      for (const el of doc.querySelectorAll('select')) if ([...el.options].some((o) => o.selected !== o.defaultSelected)) return true;
      for (const el of doc.querySelectorAll('input[type=checkbox], input[type=radio]')) if (el.checked !== el.defaultChecked) return true;
      for (const el of doc.querySelectorAll('audio, video')) if ((!el.paused && !el.ended) || (typeof MediaStream !== 'undefined' && el.srcObject instanceof MediaStream)) return true;
      for (const frame of doc.querySelectorAll('iframe, frame')) {
        let inner;
        try {
          inner = frame.contentDocument;
        } catch {
          continue; // another origin: its own business
        }
        if (inUse(inner, depth + 1)) return true;
      }
      return false;
    };
    const busy = () => {
      try {
        return navigator.mediaSession?.playbackState === 'playing' || inUse(document);
      } catch {
        return true;
      }
    };
    let retry = null;
    let asking = false;
    // Tried while it couldn't be (in front, being shown): again the next time
    // it's hidden, or after this long if it stays hidden, doubling to 5
    // minutes; at most TRIES times (then the page keeps the old copy's leftovers
    // until it's reloaded some other way).
    let backoff = 2500;
    let tries = 0;
    const TRIES = 6;
    const arm = (delay = 500 + Math.random() * 3000) => {
      document.addEventListener('visibilitychange', go);
      clearTimeout(retry);
      retry = setTimeout(go, delay);
    };
    const go = () => {
      if (asking || !document.hidden || busy()) return;
      const KEY = 'margin-reloaded-for-update';
      let stamp = Date.now();
      try {
        const wait = 30000 - (stamp - (Number(sessionStorage.getItem(KEY)) || 0));
        if (wait > 0) {
          clearTimeout(retry);
          retry = setTimeout(go, wait + 100);
          return;
        }
        sessionStorage.setItem(KEY, String(stamp));
      } catch {}
      document.removeEventListener('visibilitychange', go);
      clearTimeout(retry);
      // Updated again meanwhile: this copy is cut off (the newer one reloads).
      if (!api.runtime?.id) return;
      console.info('[margin] Margin was updated while this page was open: loading it again');
      asking = true;
      tries++;
      // No answer at all (a background that's gone): asked again later.
      const unanswered = setTimeout(() => {
        asking = false;
        if (tries >= TRIES) return;
        backoff = Math.min(backoff * 2, 5 * 60_000);
        arm(backoff);
      }, 10000);
      api.runtime.sendMessage({ type: 'reloadForUpdate' }).then((reply) => {
        clearTimeout(unanswered);
        const answer = reply?.ok ? reply.result : null;
        // Done, or never (not a web page, or the tab is gone: background
        // handlers.js reloadForUpdate).
        if (!answer || answer.reloaded || !answer.retry || !api.runtime?.id || tries >= TRIES) return;
        // Not now (it was being shown meanwhile): this attempt's throttle
        // goes, and it tries again later (typed fields and media are
        // checked again then too).
        try {
          if (Number(sessionStorage.getItem(KEY)) === stamp) sessionStorage.removeItem(KEY);
        } catch {}
        asking = false;
        backoff = Math.min(backoff * 2, 5 * 60_000);
        arm(backoff);
      }, () => {});
    };
    arm();
  }
  return replacing;
}

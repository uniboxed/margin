// What's on its way to a new value on the elements a read of <body> looks at
// (box.ts): transitions and animations, as the page's own events tell of
// them. Never by asking for the animations themselves: WebKit sorts all of
// the document's for that (`Document::matchingAnimations`, which
// `Element.getAnimations` goes through too), and that sort crashed pages in
// Safari (EXC_BAD_ACCESS in `compareAnimationsByCompositeOrder`, three times
// on 2026-11-02), the page in front going dark for 2 s each time.
// An event comes in the frame after the transition started, so a read can
// miss one that has just started: whatever starts is read again as it ends.

const STARTS = ['transitionrun', 'animationstart'];
const ENDS = ['transitionend', 'transitioncancel', 'animationend', 'animationcancel'];
// An end that never came (a page that stopped the event before Margin's
// listener, a target no longer looked at) holds reads back no longer than this.
export const MOVE_CAP_MS = 10_000;
// Elements with something on its way, past which those with no end in sight
// (an endless animation) are swept as more come.
const SWEEP_AT = 64;
// What no event tells of (a script's `element.animate()`): a read the page's
// changes asked for that found something new is made once more this much
// later, and again while that finds something new, up to SETTLE_TRIES times.
// Not a read for the box's own moves: nothing of the page's moved.
export const SETTLE_MS = 1000;
export const SETTLE_TRIES = 3;
// What a `@keyframes` sets is found by walking every rule of every sheet
// (keyframesIn): on a site with tens of thousands of rules, 3–11 ms a walk in
// WebKit, and a read asks at every attempt while an animation runs on what it
// looks at. So each name's answer is kept this long.
export const KEYFRAMES_KEEP_MS = 2000;

// The browser's own, from before a page's scripts.
const { CSSKeyframesRule: KeyframesRule, CSSImportRule: ImportRule } = globalThis;

const nth = (list: string, at: number) => {
  const all = list.split(/,\s*/);
  return all[at % all.length];
};

/**
 * @param how.names What matters on an element: null for one a read doesn't look at.
 * @param how.near Whether a read may come to look at it (a first child that has just come): what starts on it is kept.
 * @param how.ended Nothing that mattered is on its way any more, and something did since the last read.
 * @param how.settle Read once more: what was read may have been on its way, unseen.
 * @param how.styleOf Computed style: style only, nothing laid out.
 * @param how.keyframes What a `@keyframes` of that name sets, null if no sheet the page can read has it.
 * @param how.echoed A transition a read started itself: started and over at once, in the frame after it.
 */
export function startMoves({ names, near = (node) => !!names(node), ended, settle = () => {}, styleOf, keyframes, echoed = () => {} }: {
  names: (node: any) => RegExp | null,
  near?: (node: any) => boolean,
  ended: () => void,
  settle?: () => void,
  styleOf: (node: any) => any,
  keyframes: (name: string) => string[] | null,
  echoed?: (event: any) => void,
}, on: EventTarget = window) {
  /** element → what's on its way on it, and since when */
  const moving: Map<any, Map<string, number>> = new Map();
  /** a `@keyframes` name → what it sets, and when that was found */
  const sets: Map<string, { set: string[] | null, at: number }> = new Map();
  const keyframesOf = (name: string) => {
    const now = performance.now();
    const kept = sets.get(name);
    if (kept && now - kept.at < KEYFRAMES_KEEP_MS) return kept.set;
    for (const [other, { at }] of sets) if (now - at >= KEYFRAMES_KEEP_MS) sets.delete(other);
    const set = keyframes(name);
    sets.set(name, { set, at: now });
    return set;
  };
  let owed = false; // something that mattered moved since the last read: read again once it's all ended
  const keyOf = (event: any) => (event.type.startsWith('transition') ? `t ${event.propertyName}` : `a ${event.animationName}`);
  // A CSS animation with an end, running, of something a read looks at. One
  // with no end shows now all there'll ever be; a paused one stays as it is;
  // one no longer named is gone.
  function animates(node: Element, name: string, property: RegExp) {
    const style = styleOf(node);
    const at = String(style.animationName).split(/,\s*/).lastIndexOf(name);
    if (at < 0 || nth(style.animationIterationCount, at) === 'infinite' || nth(style.animationPlayState, at) === 'paused') return false;
    const set = keyframesOf(name);
    return !set || set.some((item) => property.test(item));
  }
  // Whether it moves what a read looks at on that element now.
  function matters(node: Element, key: string) {
    const property = names(node);
    if (!property) return false;
    const [kind, name] = [key[0], key.slice(2)];
    return kind === 't' ? property.test(name) : animates(node, name, property);
  }

  // A read made without everything held still starts transitions of its own
  // (box.ts): they come in the next frame's events, each started and over at
  // once, before it moved at all, which a page's own never is.
  let echoing = false;
  let echoFrame = 0;
  let echoRuns: Map<any, Set<string>> = new Map();
  const echoKey = (event: any) => `${event.pseudoElement} ${event.propertyName}`;
  function echo() {
    echoing = true;
    cancelAnimationFrame(echoFrame);
    echoFrame = requestAnimationFrame(() => { // after that frame's events
      echoFrame = 0;
      echoing = false;
      echoRuns = new Map();
    });
  }
  // Chromium ends one with a cancel, WebKit with an end, at 0 s either way.
  function isEcho(event: any) {
    if (!echoing || event.elapsedTime !== 0 || !echoRuns.get(event.target)?.has(echoKey(event))) return false;
    echoed(event);
    return true;
  }

  function started(event: any) {
    if (!event.isTrusted) return;
    if (event.type === 'transitionrun' && echoing) {
      if (!echoRuns.has(event.target)) echoRuns.set(event.target, new Set<any>());
      echoRuns.get(event.target)!.add(echoKey(event)); // (set just above)
    }
    if (event.pseudoElement) return; // a read looks at elements, not at their ::before
    const node = event.target;
    // Kept even before a read looks at it: a first child that has just come
    // starts moving before the next look at the first children finds it.
    if (!near(node)) return;
    let on = moving.get(node);
    if (!on) moving.set(node, (on = new Map()));
    on.set(keyOf(event), performance.now());
    if (moving.size > SWEEP_AT) sweep();
  }
  function stopped(event: any) {
    if (!event.isTrusted) return;
    const echoes = event.type.startsWith('transition') && isEcho(event);
    if (event.pseudoElement) return;
    const node = event.target;
    const on = moving.get(node);
    const key = keyOf(event);
    if (!on?.has(key)) return;
    on.delete(key);
    if (!on.size) moving.delete(node);
    // Whatever mattered and ended came after the last read, or a read then
    // didn't look at it yet: read again. Not for a read's own.
    if (!echoes && matters(node, key)) owed = true;
    if (owed && !isMoving()) {
      owed = false;
      ended();
    }
  }
  // Without what left the page and what's past the cap.
  function sweep() {
    const now = performance.now();
    for (const [node, on] of moving) {
      if (!node.isConnected) {
        moving.delete(node);
        continue;
      }
      for (const [key, since] of on) if (now - since >= MOVE_CAP_MS) on.delete(key);
      if (!on.size) moving.delete(node);
    }
  }
  // What's still on its way of what a read looks at now.
  function isMoving() {
    sweep();
    for (const [node, on] of moving) for (const key of on.keys()) if (matters(node, key)) return true;
    return false;
  }

  let settleTimer: Timer | 0 = 0;
  let settling = false; // the read to come is a settling one
  let settles = 0;
  for (const type of STARTS) on.addEventListener(type, started, true);
  for (const type of ENDS) on.addEventListener(type, stopped, true);
  return {
    /** Whether a read now would find a length on its way: it waits, and is made again as that ends. */
    moving: () => {
      if (!isMoving()) return false;
      owed = true;
      return true;
    },
    /** A read without everything held is about to be made: what it starts itself comes back as events. */
    echo,
    /** A read was made, with nothing on its way: what ended before it is in it. */
    read: () => { owed = false; },
    /**
     * What a read the page's own changes asked for came to: `changed`, it
     * found something new, which may yet be on its way unseen.
     */
    found: (changed: boolean) => {
      settles = settling ? settles + 1 : 0;
      settling = false;
      if (!changed || settles >= SETTLE_TRIES) return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settling = true;
        settle();
      }, SETTLE_MS);
    },
  };
}

// What a `@keyframes` of that name sets, from the sheets the page can read
// (the last one wins, as in CSS): null if none of them has it.
export function keyframesIn(sheets: any[], name: string) {
  let found = null as CSSKeyframesRule | null; // (set in walk's callback)
  const walk = (rules: CSSRuleList | null | undefined) => {
    for (const rule of Array.from(rules ?? [])) {
      try {
        if (rule instanceof KeyframesRule) {
          if (rule.name === name) found = rule;
        } else if (rule instanceof ImportRule) {
          walk(rule.styleSheet?.cssRules);
        } else if ((rule as any).cssRules) {
          walk((rule as any).cssRules);
        }
      } catch {} // another site's sheet
    }
  };
  for (const sheet of sheets) {
    try {
      walk(sheet.cssRules);
    } catch {}
  }
  return found && Array.from(found.cssRules).flatMap((frame) => Array.from((frame as CSSKeyframeRule).style));
}

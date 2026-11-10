// The page's style sheets, for the box: media queries about the window's size
// and viewport units are rewritten (shared/page-css.ts). Only sheets that
// changed are looked at: one observer on the document, at most one pass a
// frame, and none on a tab out of sight until it's shown.
import type { Box } from './box.ts';
import type { Accessor } from './accessor.ts';
import { asksSize, hasUnits, shiftQuery, shiftStyle, shiftUnits } from '../../shared/page-css.ts';
import { contentNamed, encodeItems, hash, pathText, planFrom, usable, type Entry, type Item, type Kind } from '../../shared/sheet-walk.ts';

const SWEEP_FLOOR = 64;
// Reading a sheet's selectors for :has(): slices of about this many ms, this
// many ms apart.
const HAS_SLICE = 4;
const HAS_WAIT = 16;
// The kept walks' format (shared/sheet-walk.ts): one more when what a walk keeps changes in a way the functions'
// own text (walkMark) doesn't show.
const WALK_FORMAT = 1;
// What the page's world walked in full goes across this long after the last of it.
const KEEP_WAIT = 1000;

export function startSheets(box: Box) {
  const ours = new Set(box.ours);
  const sheetProto = CSSStyleSheet.prototype;
  const { insertRule, deleteRule, replace, replaceSync } = sheetProto;
  const { addRule, removeRule } = sheetProto;
  const { matches } = Element.prototype;
  // (The browser's own: accessor.ts.)
  const mediaText = Object.getOwnPropertyDescriptor(MediaList.prototype, 'mediaText') as Accessor;
  const ruleStyle = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'style') as Accessor;
  const selectorText = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'selectorText') as Accessor;
  const seen = new WeakSet();
  let fresh = false; // a sheet of the document's not seen before

  // ---- media queries --------------------------------------------------------
  // Holders (a sheet or a @media rule) whose query has a size in it, with what
  // it's been moved by. Moves go by the difference: a query can't take a
  // variable, and moving one twice would double it.
  const moved: Map<any, { dw: number, dh: number }> = new Map();
  // A sheet that left the page, or a rule that left its sheet, goes from the
  // list: when the box rests, and whenever the list has twice as many as after
  // the last sweep (a page that swaps its <style>s and never moves the box).
  const gone = (holder: CSSStyleSheet | CSSMediaRule | CSSImportRule | CSSStyleRule) => {
    const sheet = holder instanceof CSSStyleSheet ? holder : holder.parentStyleSheet;
    return !sheet || (sheet.ownerNode && !sheet.ownerNode.isConnected);
  };
  let sweepAt = SWEEP_FLOOR;
  // What it read of the query, when it's about the size (a walk keeps it: walkRules), else ''.
  function moveHolder(holder: any, dw: number, dh: number) { // (a sheet, or a rule with a media list)
    const applied = moved.get(holder) ?? { dw: 0, dh: 0 };
    const list = holder.media;
    if (!list) return '';
    const text = list.mediaText;
    if (!asksSize(text)) return '';
    const next = shiftQuery(text, dw - applied.dw, dh - applied.dh);
    if (next !== text) mediaText.set.call(list, next);
    moved.set(holder, { dw, dh });
    if (moved.size < sweepAt) return text;
    for (const held of moved.keys()) if (gone(held)) moved.delete(held);
    sweepAt = Math.max(SWEEP_FLOOR, 2 * moved.size);
    return text;
  }
  function moveAll(dw: number, dh: number) {
    for (const holder of moved.keys()) {
      if (gone(holder)) moved.delete(holder);
      else {
        try {
          moveHolder(holder, dw, dh);
        } catch {}
      }
    }
  }
  const moveToBox = () => moveAll(box.seenW(), box.seenH());
  box.onRest.push(moveToBox);
  // Paper has no box.
  addEventListener('beforeprint', () => moveAll(0, 0));
  addEventListener('afterprint', moveToBox);

  // ---- walking a sheet ------------------------------------------------------
  // Where a shorthand is taken apart into its longhands (shared/page-css.ts), made when first wanted: a rule
  // of a sheet that's never in the page. Not an element's style: on a page with sheets of its own, WebKit does a
  // document's worth of work for each edit of one, in the page or not (GitHub: 620 ms for its 450 rules with
  // units, against 12 here).
  let scratchStyle: CSSStyleDeclaration | undefined;
  const scratch = () => {
    if (scratchStyle) return scratchStyle;
    const sheet = new CSSStyleSheet();
    replaceSync.call(sheet, 'margin-scratch {}');
    return (scratchStyle = ruleStyle.get.call(sheet.cssRules[0]));
  };
  // `units`: false where the sheet's text has none, which saves serializing
  // every rule of it just to look. A rule's declarations are serialized, not
  // the rules nested in it (walked on their own), nor its selector (looked
  // through for :has() apart: hasLater). `rec`: a content-named file's walk,
  // kept for its next visit (kept walks, below): each rule that needs work, at
  // `at` (its parents' indices), with a hash of what was read there.
  function walkRules(rules: CSSRuleList, units: boolean, dw: number, dh: number, rec: Walk | null = null, at: number[] = []) {
    const list = Array.from(rules);
    for (let i = 0; i < list.length; i++) {
      const rule = list[i];
      try {
        if (rule instanceof CSSStyleRule) {
          if (units) {
            const style = ruleStyle.get.call(rule);
            const said = style.cssText;
            if (hasUnits(said)) {
              rec?.items.push({ kind: 'u', path: [...at, i], check: hash(`${selectorText.get.call(rule)}\n${said}`) });
              shiftStyle(style, scratch(), said);
            }
          }
        } else {
          if (rule instanceof CSSMediaRule) {
            const query = moveHolder(rule, dw, dh);
            if (query) rec?.items.push({ kind: 'm', path: [...at, i], check: hash(query) });
          }
          // @font-face, @page, a keyframe, nested declarations.
          const style = (rule as any).style;
          const said = units && style ? style.cssText : '';
          if (said && hasUnits(said)) {
            rec?.items.push({ kind: 'u', path: [...at, i], check: hash(`\n${said}`) });
            shiftStyle(style, scratch(), said);
          }
          // (Kept whether its sheet came or not: it may next time.)
          if (rule instanceof CSSImportRule) rec?.items.push({ kind: 'i', path: [...at, i], check: hash(String(rule.href)) });
          if ((rule as any).styleSheet) visit((rule as any).styleSheet);
        }
        if ((rule as any).cssRules?.length) walkRules((rule as any).cssRules, units, dw, dh, rec, rec ? [...at, i] : at);
      } catch {
        if (rec) rec.broken = true;
      }
    }
  }
  function visit(sheet: CSSStyleSheet) {
    if (!sheet || seen.has(sheet) || ours.has(sheet)) return;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      return; // another origin's, no CORS: content/page-link.ts fetches those
    }
    seen.add(sheet);
    fresh ||= !!sheet.ownerNode; // adopted ones say so as they're set (box.ts)
    // Only a <style>'s own text is watched: edits of text elsewhere cost nothing.
    const owner = sheet.ownerNode as Element | null; // (a <style>, <link> or null here: ProcessingInstruction sheets are XML's)
    const inline = owner?.localName === 'style';
    if (inline) watch.observe(owner, STYLE_TEXT);
    const dw = box.seenW();
    const dh = box.seenH();
    try {
      moveHolder(sheet, dw, dh);
    } catch {}
    // A <style>'s text says what's in it, without a walk. Rules added later go
    // through insertRule. A sheet with neither units nor queries has nothing to do.
    const text = inline ? owner.textContent : '';
    // A file whose address names its contents: what its walk found last time, checked and done, if it's here
    // (kept walks, below); else the walk, kept.
    const href = !inline ? sheet.href : null;
    const integrity = owner?.localName === 'link' ? String((owner as HTMLLinkElement).integrity ?? '') : '';
    const rec = href && contentNamed(href, integrity) ? fromKept(rules, href, integrity, dw, dh) : null;
    if (rec === DONE) return;
    const units = !text || hasUnits(text);
    if (units || /@(media|import)/i.test(text)) walkRules(rules, units, dw, dh, rec);
    if (rec) rec.walked = true;
    if (!text) hasLater(rules, rec);
    else if (text.includes(HAS)) collectHas(rules);
  }
  const visitRoot = (root: Document | ShadowRoot) => {
    for (const sheet of Array.from(root.styleSheets)) visit(sheet);
    for (const sheet of root.adoptedStyleSheets ?? []) visit(sheet);
  };

  // ---- kept walks (shared/sheet-walk.ts) -------------------------------------
  // A content-named file's walk, kept: what Margin's world read from storage for this origin comes across
  // (content/sheet-walk-link.ts, `margin:sheet-walk`), and a file that's in it is checked rule by rule and only
  // those rules are done; anything off (or nothing kept yet, or not here in time) is the full walk, as always,
  // whose findings go back across (`margin:sheet-walk-keep`) to replace what was kept.
  type Walk = { href: string, n: number, s: number, r: string, items: Item[], h: [string, string][], pending: number, walked: boolean, broken: boolean };
  const DONE = Symbol('done');
  const { parse, stringify } = JSON;
  const { now } = Date;
  const entriesByName = Performance.prototype.getEntriesByName;
  let kept: Record<string, Entry> = {};
  let mark = '';
  // Changes with what decides what a walk keeps: Margin's code for it, and the browser's version.
  const walkMark = () => (mark ||= hash([WALK_FORMAT, navigator.userAgent, String(hasUnits), String(asksSize), String(walkRules), String(visit), String(readSelectors), String(fromKept), String(readKept)].join('\n')));
  document.addEventListener('margin:sheet-walk', (event) => {
    try {
      const group = parse(String((event as CustomEvent).detail));
      if (group?.v === walkMark() && group.files && typeof group.files === 'object') kept = group.files;
    } catch {}
  });
  document.dispatchEvent(new CustomEvent('margin:sheet-walk-ask'));
  // The file's size as the browser decoded it, where it says (another origin's without Timing-Allow-Origin: 0).
  const sizeOf = (href: string) => {
    try {
      return Number((entriesByName.call(performance, href, 'resource')[0] as PerformanceResourceTiming | undefined)?.decodedBodySize) || 0;
    } catch {
      return 0;
    }
  };
  // What's there now, for a kept rule's check (shared/sheet-walk.ts planFrom): read as the walk reads it.
  function readKept(kind: Kind | 'h', rule: any): { check: string, said: [CSSStyleDeclaration, string] | null } | null {
    if (kind === 'u') {
      const own = rule instanceof CSSStyleRule;
      const style = own ? ruleStyle.get.call(rule) : rule.style;
      if (!style) return null;
      const said = style.cssText;
      return { check: hash(`${own ? selectorText.get.call(rule) : ''}\n${said}`), said: [style, said] };
    }
    if (kind === 'm') return rule instanceof CSSMediaRule ? { check: hash(rule.media.mediaText), said: null } : null;
    if (kind === 'i') return rule instanceof CSSImportRule ? { check: hash(String(rule.href)), said: null } : null;
    return rule instanceof CSSStyleRule ? { check: selectorText.get.call(rule), said: null } : null;
  }
  // DONE when what was kept did it; else the walk to keep.
  function fromKept(rules: CSSRuleList, href: string, integrity: string, dw: number, dh: number): Walk | typeof DONE {
    const s = sizeOf(href);
    const entry = kept[href];
    const plan = usable(entry, now()) && (entry.r ?? '') === integrity && !(entry.s && s && entry.s !== s) ? planFrom(entry, rules, readKept) : null;
    if (!plan) return { href, n: rules.length, s, r: integrity, items: [], h: [], pending: 0, walked: false, broken: false };
    for (const { kind, rule, said } of plan.work) {
      try {
        if (kind === 'u' && said) shiftStyle(said[0], scratch(), said[1]);
        else if (kind === 'm') moveHolder(rule, dw, dh);
        else if (kind === 'i' && rule.styleSheet) visit(rule.styleSheet);
      } catch {}
    }
    if (plan.has.length) {
      knownHas.push(...plan.has);
      unreadTask ||= setTimeout(readSelectors, HAS_WAIT);
    }
    used.add(href);
    keepSoon();
    return DONE;
  }
  // The :has() selectors kept for a file walked in full (`rec`) before they came, if the walk found what was kept.
  function keptHas(rec: Walk, rules: ArrayLike<CSSRule>) {
    const entry = kept[rec.href];
    if (!usable(entry, now()) || rec.broken || !rec.walked || rec.pending !== 1 || entry.n !== rec.n || entry.w !== encodeItems(rec.items) || (entry.r ?? '') !== rec.r || (entry.s && rec.s && entry.s !== rec.s)) return null;
    const plan = planFrom({ ...entry, w: '' }, rules, readKept);
    if (plan) {
      used.add(rec.href);
      keepSoon();
    }
    return plan?.has ?? null;
  }
  const walked: Record<string, Entry> = {};
  const used = new Set<string>();
  let keepTimer: Timer | 0 = 0;
  function walkDone(rec: Walk) {
    if (rec.broken || !rec.walked || rec.pending) return;
    walked[rec.href] = { n: rec.n, w: encodeItems(rec.items), t: Math.floor(now() / 1000), ...(rec.s ? { s: rec.s } : {}), ...(rec.r ? { r: rec.r } : {}), ...(rec.h.length ? { h: rec.h } : {}) };
    keepSoon();
  }
  function keepSoon() {
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => {
      keepTimer = 0;
      const files = { ...walked };
      for (const href of Object.keys(walked)) delete walked[href];
      const detail = stringify({ v: walkMark(), files, used: [...used] });
      used.clear();
      document.dispatchEvent(new CustomEvent('margin:sheet-walk-keep', { detail }));
    }, KEEP_WAIT);
  }

  // Sheets a script writes: the units in its text, the queries once parsed
  // (they go through the same list as any, to follow the box).
  function trackQueries(rules: CSSRuleList | CSSRule[]) {
    for (const rule of Array.from(rules)) {
      try {
        if (rule instanceof CSSMediaRule) moveHolder(rule, box.seenW(), box.seenH());
        if ((rule as any).cssRules?.length) trackQueries((rule as any).cssRules);
      } catch {}
    }
  }
  // What a rule can do to <body>'s reading: only what applies to <body>, to
  // <html> above it or to the first children, whose margins collapse with it. A
  // rule that matches none of them can't, and is the end of it: a class that
  // makes it match later changes something that's watched. Rules are looked at
  // together once the script's turn is over, when what it did to the page goes
  // with them, in one selector: thousands of them cost one match, and anything
  // that isn't a plain rule, or that a browser won't take, is simply read for.
  const edited = new Set<any>();
  let judging: Timer | 0 = 0;
  function judge() {
    judging = 0;
    const rules = [...edited];
    edited.clear();
    try {
      if (rules.some((rule) => !(rule instanceof CSSStyleRule) || rule.cssRules?.length)) return box.bodyMayHaveChanged();
      const selector = rules.map((rule) => selectorText.get.call(rule)).join();
      if (box.reachable().some((node: Element | null) => node && matches.call(node, selector))) box.bodyMayHaveChanged();
    } catch {
      box.bodyMayHaveChanged();
    }
  }
  function ruleChanged(rule: CSSRule | null | undefined) {
    box.rulesEdited();
    edited.add(rule);
    judging ||= setTimeout(judge);
  }
  sheetProto.insertRule = function (rule, index = 0) {
    if (ours.has(this)) return insertRule.call(this, rule, index);
    visit(this);
    const at = insertRule.call(this, typeof rule === 'string' ? shiftUnits(rule) : rule, index);
    trackQueries([this.cssRules[at]]);
    ruleChanged(this.cssRules[at]);
    if (String(rule).includes(HAS)) collectHas([this.cssRules[at]]);
    return at;
  };
  sheetProto.deleteRule = function (index) {
    if (!ours.has(this)) ruleChanged(this.cssRules[index]);
    deleteRule.call(this, index);
  };
  sheetProto.addRule = function (...args) {
    visit(this);
    const at = addRule.apply(this, args);
    noteHas(String(args[0]));
    box.bodyMayHaveChanged();
    return at;
  };
  sheetProto.removeRule = function (...args) {
    removeRule.apply(this, args);
    box.bodyMayHaveChanged();
  };
  sheetProto.replaceSync = function (text) {
    if (ours.has(this)) return replaceSync.call(this, text);
    seen.add(this);
    replaceSync.call(this, shiftUnits(String(text)));
    trackQueries(this.cssRules);
    if (String(text).includes(HAS)) collectHas(this.cssRules);
    box.bodyMayHaveChanged();
  };
  sheetProto.replace = function (text) {
    if (ours.has(this)) return replace.call(this, text);
    seen.add(this);
    return replace.call(this, shiftUnits(String(text))).then((sheet: CSSStyleSheet) => {
      trackQueries(this.cssRules);
      if (String(text).includes(HAS)) collectHas(this.cssRules);
      box.bodyMayHaveChanged();
      return sheet;
    });
  };
  // Inside a @media or the like.
  const groupProto = CSSGroupingRule.prototype;
  const { insertRule: insertInGroup, deleteRule: deleteFromGroup } = groupProto;
  groupProto.insertRule = function (rule, index = 0) {
    const at = insertInGroup.call(this, rule, index);
    ruleChanged(this.cssRules[at]);
    if (String(rule).includes(HAS)) collectHas([this.cssRules[at]]);
    return at;
  };
  groupProto.deleteRule = function (index) {
    ruleChanged(this.cssRules[index]);
    deleteFromGroup.call(this, index);
  };
  const reread = (proto: HTMLStyleElement | StyleSheet | MediaList, name: string) => {
    const own = Object.getOwnPropertyDescriptor(proto, name) as Accessor;
    Object.defineProperty(proto, name, {
      ...own,
      set(value) {
        own.set.call(this, value);
        if (!ours.has(this)) box.bodyMayHaveChanged();
      },
    });
  };
  for (const proto of [StyleSheet.prototype, HTMLStyleElement.prototype, HTMLLinkElement.prototype]) reread(proto, 'disabled');
  reread(MediaList.prototype, 'mediaText');
  for (const name of ['appendMedium', 'deleteMedium']) {
    // (By name: MediaList's own methods, wrapped.)
    const own = (MediaList.prototype as unknown as Record<string, any>)[name];
    (MediaList.prototype as unknown as Record<string, any>)[name] = { [name](medium: string) {
      own.apply(this, arguments);
      box.bodyMayHaveChanged();
    } }[name];
  }
  // A script reaching for a rule's `style` is about to edit it, and an inline
  // style never comes this way, so `element.style` costs nothing. The read comes
  // after the script's turn. A `style` kept and written to much later isn't seen.
  Object.defineProperty(CSSStyleRule.prototype, 'style', {
    ...ruleStyle,
    get() {
      ruleChanged(this);
      return ruleStyle.get.call(this);
    },
    set(value) {
      ruleStyle.set.call(this, value);
      box.bodyMayHaveChanged();
    },
  });
  const styleMap = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'styleMap') as Accessor | undefined; // (not every browser has it)
  if (styleMap) {
    Object.defineProperty(CSSStyleRule.prototype, 'styleMap', {
      ...styleMap,
      get() {
        ruleChanged(this);
        return styleMap.get.call(this);
      },
    });
  }
  Object.defineProperty(CSSStyleRule.prototype, 'selectorText', {
    ...selectorText,
    set(value) {
      selectorText.set.call(this, value);
      noteHas(String(value));
      box.bodyMayHaveChanged();
    },
  });

  // ---- :has() ----------------------------------------------------------------
  // A rule on <html> or <body> that says `:has()` turns on with no change to
  // either, or to any sheet. Only such a rule's own selector is asked, once a
  // frame and only on a page that has one: no read unless its answer changed.
  const HAS = ':has(';
  const hasRules = new Set<any>();
  let aboutBody: string[] = [];
  let answers = '';
  let hasFrame = 0;
  let watchingHas = false;
  // The selector without its `:has(...)`: does it name <html> or <body> at all?
  function withoutHas(selector: string) {
    let out = selector;
    for (let at = out.indexOf(HAS); at >= 0; at = out.indexOf(HAS)) {
      let depth = 0;
      let end = at + HAS.length - 1;
      do {
        if (out[end] === '(') depth++;
        else if (out[end] === ')') depth--;
        end++;
      } while (depth && end < out.length);
      out = `${out.slice(0, at)}${/[\w)\]-]$/.test(out.slice(0, at)) ? '' : '*'}${out.slice(end)}`;
    }
    return out;
  }
  // A 1 for each of <html> and <body> that it matches.
  function ask(selector: string) {
    try {
      return box.reachable().slice(0, 2).map((node: Element | null) => (node && matches.call(node, selector) ? 1 : 0)).join('');
    } catch {
      return '';
    }
  }
  const answersNow = () => aboutBody.map(ask).join();
  function hasCheck() {
    hasFrame = 0;
    if (answersNow() !== answers) box.bodyMayHaveChanged();
  }
  const hasWatch = new MutationObserver(() => {
    hasFrame ||= requestAnimationFrame(hasCheck);
  });
  function noteHas(selector: string) {
    if (!selector.includes(HAS) || hasRules.has(selector)) return;
    hasRules.add(selector);
    box.bodyMayHaveChanged();
  }
  // The selectors of a sheet whose text isn't known (a <link>'s, an
  // @import's, an adopted one), looked through after the page's turn, in
  // slices: a selector costs as much to read as a rule's declarations, and
  // load is when a page has least time. A rule already in the sheet applied
  // at the read its sheet brought, so only what it changes later hangs on
  // it; one about <html> or <body> found now is read for, to be sure.
  // Each with where it is (its parents' indices) and the walk it's kept for, if it is (kept walks, above).
  const unread: [ArrayLike<CSSRule>, number, number[], Walk | null][] = [];
  // Selectors with :has() a kept walk had, looked at as the ones read here are.
  const knownHas: string[] = [];
  let unreadTask: Timer | 0 = 0;
  function hasLater(rules: CSSRuleList, rec: Walk | null = null) {
    unread.push([Array.from(rules), 0, [], rec]);
    if (rec) rec.pending++;
    unreadTask ||= setTimeout(readSelectors, HAS_WAIT);
  }
  function readSelectors() {
    unreadTask = 0;
    const until = performance.now() + HAS_SLICE;
    let about = false;
    const take = (selector: string) => {
      if (hasRules.has(selector)) return;
      hasRules.add(selector);
      about ||= ask(withoutHas(selector)).includes('1');
    };
    for (const selector of knownHas.splice(0)) take(selector);
    while (unread.length) {
      const item = unread[unread.length - 1];
      const [rules, , at, rec] = item;
      if (item[1] >= rules.length) {
        unread.pop();
        if (rec && !--rec.pending) walkDone(rec);
        continue;
      }
      // A file walked before what was kept came, whose walk found just what was kept: its :has() selectors as kept
      // (each checked at its place), not read again.
      const has = rec && !at.length && !item[1] ? keptHas(rec, rules) : null;
      if (has) {
        unread.pop();
        rec!.pending--;
        has.forEach(take);
        continue;
      }
      if (performance.now() > until) {
        unreadTask = setTimeout(readSelectors, HAS_WAIT);
        break;
      }
      // A run of rules between looks at the clock.
      for (const end = Math.min(rules.length, item[1] + 64); item[1] < end; item[1]++) {
        const rule = rules[item[1]];
        try {
          if (rule instanceof CSSStyleRule) {
            const selector = selectorText.get.call(rule);
            if (selector.includes(HAS)) {
              rec?.h.push([pathText([...at, item[1]]), selector]);
              if (!hasRules.has(selector)) {
                hasRules.add(selector);
                about ||= ask(withoutHas(selector)).includes('1');
              }
            }
          }
          const inner = (rule as any).cssRules;
          if (inner?.length) {
            unread.push([Array.from(inner), 0, rec ? [...at, item[1]] : at, rec]);
            if (rec) rec.pending++;
          }
        } catch {
          if (rec) rec.broken = true;
        }
      }
    }
    if (about) box.bodyMayHaveChanged();
  }
  function collectHas(rules: CSSRuleList | CSSRule[]) {
    for (const rule of Array.from(rules)) {
      try {
        if (rule instanceof CSSStyleRule) noteHas(selectorText.get.call(rule));
        if ((rule as any).cssRules?.length) collectHas((rule as any).cssRules);
      } catch {}
    }
  }
  box.onRead.push(() => {
    if (!hasRules.size) return;
    aboutBody = [...hasRules].filter((selector) => ask(withoutHas(selector)).includes('1'));
    answers = answersNow();
    const wanted = aboutBody.length > 0;
    if (wanted === watchingHas) return;
    watchingHas = wanted;
    if (wanted) hasWatch.observe(document, { childList: true, subtree: true, attributes: true });
    else hasWatch.disconnect();
  });

  // ---- style attributes ------------------------------------------------------
  const INLINE = '[style*="vw"], [style*="vh"], [style*="vmin"], [style*="vmax"]';
  function shiftInline(node: Element) {
    const { style } = node as Element & Partial<ElementCSSInlineStyle>; // (SVG and MathML elements have one too; some others don't)
    const said = style?.cssText;
    // (`said` is its text: it has a style.)
    if (said && hasUnits(said)) shiftStyle(style as CSSStyleDeclaration, scratch(), said);
  }
  const inlineIn = (root: Document | DocumentFragment | Element) => {
    if ((root as Element).matches?.(INLINE)) shiftInline(root as Element); // (only an element has matches)
    for (const node of root.querySelectorAll?.(INLINE) ?? []) shiftInline(node);
  };

  // ---- what changed -----------------------------------------------------------
  let sheetCount = 0;
  let frame = 0;
  let waiting = false; // for the tab to come into sight
  const addedRoots: Set<Element | Document | DocumentFragment> = new Set();
  const dirtyRoots = new Set<any>();
  // Out of sight, what's added isn't kept, however long a chat tab runs: only
  // which root to look through once, when the tab is shown.
  const rescan = new Set<any>();
  const connected = (node: Node) => node === document || node.isConnected;
  function pass() {
    frame = 0;
    waiting = false;
    if (!box.on) return;
    fresh = false;
    visitRoot(document);
    if (fresh || document.styleSheets.length !== sheetCount) box.bodyMayHaveChanged();
    sheetCount = document.styleSheets.length;
    for (const root of dirtyRoots) if (connected(root)) visitRoot(root);
    dirtyRoots.clear();
    for (const root of addedRoots) if (connected(root)) inlineIn(root);
    addedRoots.clear();
    for (const root of rescan) {
      if (!connected(root)) continue;
      inlineIn(root);
      if (root !== document) visitRoot(root);
    }
    rescan.clear();
  }
  // Before a read of <body> (box-body.ts), the sheets it hasn't seen yet are walked, as a pass would: the read
  // sees their queries and units already the box's, and their edits are styled with it, not after it. WebKit
  // styles the whole page again after any sheet is edited (20,000 rules: about 85 ms), so a walk after the read
  // was a second time. What the read finds needs no read of its own: the count is the read's.
  box.onBeforeRead.push(() => {
    if (!box.on) return;
    visitRoot(document);
    sheetCount = document.styleSheets.length;
  });
  function soon() {
    if (frame || waiting) return;
    if (document.hidden) waiting = true;
    else frame = requestAnimationFrame(pass);
  }
  const isStyle = (node: Node) => node.nodeName === 'STYLE' || node.nodeName === 'style' || node.nodeName === 'LINK';
  function observed(records: MutationRecord[]) {
    if (!box.on) return;
    const hidden = document.hidden;
    let changed = false;
    box.childrenChanged();
    for (const record of records) {
      if (record.type === 'characterData') { // a <style>'s text: a new sheet
        changed = true;
        continue;
      }
      if (record.type === 'attributes') {
        // A style attribute a script wrote: done here, before it's painted. A
        // record of our own write finds nothing left to rewrite, and animated
        // styles cost one test.
        const target = (record.target as any);
        if (record.attributeName === 'style') {
          if (hasUnits(target.getAttribute('style') ?? '')) shiftInline(target);
        } else if (isStyle(target)) box.bodyMayHaveChanged();
        continue;
      }
      if (isStyle(record.target)) changed = true;
      let added = false;
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || box.ownFlag(node)) continue;
        added = true;
        const element = (node as Element);
        // Looked through once, from the topmost added.
        if (!hidden && (element.firstElementChild || element.hasAttribute('style')) && !addedRoots.has((element.parentNode as Element))) addedRoots.add(element);
        if (isStyle(element)) changed = true;
        // A declarative shadow root the parser has just attached.
        if (element.shadowRoot) watchRoot(element.shadowRoot);
      }
      if (!added) continue;
      const root = record.target.getRootNode();
      if (hidden) rescan.add(root);
      else if (root !== document && root instanceof ShadowRoot) dirtyRoots.add(root);
    }
    if (changed || addedRoots.size || dirtyRoots.size || rescan.size || document.styleSheets.length !== sheetCount) soon();
  }
  const watch = new MutationObserver(observed);
  const STYLE_TEXT = { characterData: true, subtree: true };
  const WATCH = { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'media', 'disabled'] };
  const roots = new WeakSet();
  function watchRoot(root: Document | ShadowRoot) {
    if (roots.has(root)) return;
    roots.add(root);
    watch.observe(root, WATCH);
    dirtyRoots.add(root);
  }
  watch.observe(document, WATCH);
  const { attachShadow } = Element.prototype;
  Element.prototype.attachShadow = function (...args) {
    const root = attachShadow.apply(this, args);
    watchRoot(root);
    return root;
  };

  // A sheet that has just loaded: rewritten before it's painted.
  document.addEventListener('load', (event) => {
    // (A load seen in the document's capture phase is an element's.)
    if (!isStyle(event.target as Node)) return; // a <style> says so too, once its @imports are in
    pass();
    box.bodyMayHaveChanged(); // another origin's sheet can't be read, but it applies
  }, true);
  // Always, hidden or not: a tab loaded behind the page is ready when it's shown.
  document.addEventListener('DOMContentLoaded', () => {
    pass();
    box.loaded();
  });
  addEventListener('load', () => {
    pass();
    box.loaded(); // a site's own reset, late
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && waiting) pass(); });
  box.onMove.push(() => { if (box.on) soon(); });
  addedRoots.add(document.documentElement); // injected late: what's there already
  document.addEventListener('margin:sheets', pass); // content/page-link.ts
  pass();
}

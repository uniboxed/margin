// The page's style sheets, for the box: media queries about the window's size
// and viewport units are rewritten (shared/page-css.js). Only sheets that
// changed are looked at: one observer on the document, at most one pass a
// frame, and none on a tab out of sight until it's shown.
import { asksSize, hasUnits, shiftQuery, shiftUnits } from '../../shared/page-css.js';

// Pseudo-classes whose truth can change without a DOM mutation. Structural
// :has() selectors need only the MutationObserver below; installing pointer,
// focus and form-control hooks for those would tax unrelated page interaction.
const STATEFUL_PSEUDO = /^(?:active|autofill|checked|default|defined|disabled|enabled|focus|focus-visible|focus-within|fullscreen|future|hover|in-range|indeterminate|invalid|link|local-link|modal|muted|open|optional|out-of-range|past|paused|picture-in-picture|placeholder-shown|playing|popover-open|read-only|read-write|required|seeking|stalled|target|target-current|user-invalid|user-valid|valid|visited|volume-locked)(?![-\w])/i;

export function hasStatefulPseudo(selector) {
  let quote = '';
  let brackets = 0;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (char === '\\') { i++; continue; }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[') { brackets++; continue; }
    if (char === ']') { brackets = Math.max(0, brackets - 1); continue; }
    if (!brackets && char === ':' && selector[i + 1] !== ':' && STATEFUL_PSEUDO.test(selector.slice(i + 1))) return true;
  }
  return false;
}

export function startSheets(box) {
  const ours = new Set(box.ours);
  const sheetProto = CSSStyleSheet.prototype;
  const { insertRule, deleteRule, replace, replaceSync } = sheetProto;
  const { addRule, removeRule } = sheetProto;
  const { matches } = Element.prototype;
  const { getRootNode } = Node.prototype;
  const disabled = Object.getOwnPropertyDescriptor(StyleSheet.prototype, 'disabled');
  const sheetMedia = Object.getOwnPropertyDescriptor(StyleSheet.prototype, 'media');
  const mediaText = Object.getOwnPropertyDescriptor(MediaList.prototype, 'mediaText');
  const mediaRule = globalThis.CSSMediaRule;
  const mediaRuleMedia = mediaRule && Object.getOwnPropertyDescriptor(mediaRule.prototype, 'media');
  const importRule = globalThis.CSSImportRule;
  const importRuleMedia = importRule && Object.getOwnPropertyDescriptor(importRule.prototype, 'media');
  const ruleStyle = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'style');
  const ruleStyleMap = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'styleMap');
  const selectorText = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'selectorText');
  const shadowAdopted = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets');
  const keyframeRule = globalThis.CSSKeyframeRule;
  const keyframeStyle = keyframeRule && Object.getOwnPropertyDescriptor(keyframeRule.prototype, 'style');
  const isDeclarationRule = (rule) => rule instanceof CSSStyleRule || (!!keyframeRule && rule instanceof keyframeRule);
  const declarationProto = CSSStyleDeclaration.prototype;
  const declarationSet = declarationProto.setProperty;
  const declarationRemove = declarationProto.removeProperty;
  const declarationGet = declarationProto.getPropertyValue;
  const declarationText = Object.getOwnPropertyDescriptor(declarationProto, 'cssText');
  const seen = new WeakSet();
  /** Every root Margin can reach, including closed roots created after injection. @type {Set<Document | ShadowRoot>} */
  const knownRoots = new Set([document]);
  let fresh = false; // a sheet of the document's not seen before

  // ---- media queries --------------------------------------------------------
  // Holders (a sheet or a @media rule) whose query has a size in it, with what
  // it's been moved by. Moves go by the difference: a query can't take a
  // variable, and moving one twice would double it.
  /** @type {Map<any, { dw: number, dh: number, sheet: CSSStyleSheet | null, top: CSSStyleSheet | null }>} */
  const moved = new Map();
  const mediaOwner = new WeakMap();
  const nodeSheets = new WeakMap();
  const inThisDocument = (node) => node === document || getRootNode.call(node, { composed: true }) === document;
  const rootConnected = (root) => root === document || (!!root.host && inThisDocument(root.host));
  const topSheet = (sheet) => {
    let top = sheet;
    while (top?.ownerRule?.parentStyleSheet) top = top.ownerRule.parentStyleSheet;
    return top;
  };
  function sheetBelongsToDocument(sheet) {
    const top = topSheet(sheet);
    if (top?.ownerNode) {
      try { return inThisDocument(top.ownerNode) && top.ownerNode.sheet === top; } catch { return false; }
    }
    for (const root of knownRoots) {
      if (!rootConnected(root)) continue;
      try { if (Array.from(root.adoptedStyleSheets ?? []).includes(top)) return true; } catch {}
    }
    return false;
  }
  function sheetIsLive(sheet) {
    const top = topSheet(sheet);
    return sheetBelongsToDocument(top) && !top?.disabled;
  }
  const ruleIsLive = (rule) => !!rule?.parentStyleSheet && sheetIsLive(rule.parentStyleSheet);
  const holderIsLive = (holder) => holder instanceof CSSStyleSheet ? sheetIsLive(holder) : ruleIsLive(holder);
  const sourceSheet = (source) => source instanceof CSSStyleSheet ? source : source instanceof Node ? /** @type {any} */ (source).sheet : null;
  const sourceIsLive = (source) => {
    const sheet = sourceSheet(source);
    return !!sheet && sheetIsLive(sheet);
  };
  function dropMoved(rule) {
    restoreHolder(rule);
    try { for (const child of Array.from(rule?.cssRules ?? [])) dropMoved(child); } catch {}
  }
  function restoreHolder(holder) {
    const applied = moved.get(holder);
    if (!applied) return;
    try {
      const list = holder.media;
      const text = list && mediaText.get.call(list);
      if (text && (applied.dw || applied.dh)) {
        const original = shiftQuery(text, -applied.dw, -applied.dh);
        if (original !== text) mediaText.set.call(list, original);
      }
    } catch {}
    moved.delete(holder);
  }
  function holdersForSheet(sheet) {
    const top = topSheet(sheet);
    const holders = [];
    for (const [holder, applied] of moved) {
      if (applied.top === top) holders.push(holder);
    }
    return holders;
  }
  function dropSheetHolders(sheet, holders = holdersForSheet(sheet)) {
    const top = topSheet(sheet);
    const sheets = new Set([top]);
    for (const holder of holders) {
      sheets.add(moved.get(holder)?.sheet ?? null);
      restoreHolder(holder);
    }
    // visit(top) recursively reaches @import children, but only if their own
    // seen entries are evicted too. Otherwise a full scan restores their media
    // queries and then incorrectly skips shifting them back into the box.
    for (const current of sheets) if (current) seen.delete(current);
  }
  function dropNodeHolders(node) {
    const sheets = new Set();
    for (const applied of moved.values()) {
      if (applied.top?.ownerNode === node) sheets.add(applied.top);
    }
    for (const sheet of sheets) dropSheetHolders(sheet);
  }
  function pruneMoved() {
    const sheets = new Set();
    for (const applied of moved.values()) {
      if (!sheetBelongsToDocument(applied.top)) sheets.add(applied.top);
    }
    for (const sheet of sheets) dropSheetHolders(sheet);
  }
  function moveHolder(holder, dw, dh) {
    const owner = holder instanceof CSSStyleSheet ? holder : holder.parentStyleSheet;
    const applied = moved.get(holder) ?? { dw: 0, dh: 0, sheet: owner, top: topSheet(owner) };
    const list = holder.media;
    if (!list) return;
    mediaOwner.set(list, holder);
    const text = list.mediaText;
    if (!asksSize(text)) {
      moved.delete(holder);
      return;
    }
    const next = shiftQuery(text, dw - applied.dw, dh - applied.dh);
    if (next !== text) mediaText.set.call(list, next);
    moved.set(holder, { dw, dh, sheet: applied.sheet ?? owner, top: applied.top ?? topSheet(owner) });
  }
  function moveAll(dw, dh) {
    pruneMoved();
    for (const holder of moved.keys()) {
      try {
        moveHolder(holder, dw, dh);
      } catch {}
    }
  }
  const moveToBox = () => moveAll(box.seenW(), box.seenH());
  box.onRest.push(moveToBox);
  // Paper has no box.
  addEventListener('beforeprint', () => moveAll(0, 0));
  addEventListener('afterprint', moveToBox);

  // ---- walking a sheet ------------------------------------------------------
  // `units`: false where the sheet's text has none, which saves serializing
  // every rule of it just to look.
  function walkRules(rules, units) {
    for (const rule of Array.from(rules)) {
      try {
        if (rule instanceof CSSMediaRule) moveHolder(rule, box.seenW(), box.seenH());
        const plain = rule instanceof CSSStyleRule;
        const keyframe = !!keyframeRule && rule instanceof keyframeRule;
        const style = plain ? ruleStyle.get.call(rule) : keyframe && keyframeStyle?.get ? keyframeStyle.get.call(rule) : /** @type {any} */ (rule).style;
        // Mutation instrumentation is installed lazily by the rule's style
        // and styleMap getters below. Walking thousands of rules must not add
        // dozens of own accessors to declarations a page never edits.
        // One serialization for both questions.
        const said = units && (plain ? rule.cssText : style?.cssText);
        if (said && plain && said.includes(HAS)) noteHas(selectorText.get.call(rule));
        // Over a copy of the names: a property set moves to the end of the live list.
        if (said && hasUnits(said)) {
          for (const name of Array.from(style)) {
            const value = style.getPropertyValue(name);
            const next = shiftUnits(value);
            if (next !== value) declarationSet.call(style, name, next, style.getPropertyPriority(name));
          }
        }
        if (/** @type {any} */ (rule).cssRules?.length) walkRules(/** @type {any} */ (rule).cssRules, units);
        if (/** @type {any} */ (rule).styleSheet) visit(/** @type {any} */ (rule).styleSheet);
      } catch {}
    }
  }
  function visit(sheet) {
    if (!sheet || seen.has(sheet) || ours.has(sheet)) return;
    if (!sheetIsLive(sheet)) {
      seen.delete(sheet);
      return;
    }
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      return; // another origin's, no CORS: content/page-link.js fetches those
    }
    seen.add(sheet);
    if (sheet.ownerNode) {
      const prior = nodeSheets.get(sheet.ownerNode);
      if (prior && prior !== sheet) {
        seen.delete(prior);
        dropSheetHolders(prior);
      }
      nodeSheets.set(sheet.ownerNode, sheet);
    }
    fresh ||= !!sheet.ownerNode; // adopted ones say so as they're set (box.js)
    // Only a <style>'s own text is watched: edits of text elsewhere cost nothing.
    if (sheet.ownerNode?.localName === 'style') watch.observe(sheet.ownerNode, STYLE_TEXT);
    try {
      moveHolder(sheet, box.seenW(), box.seenH());
    } catch {}
    // A <style>'s text says what's in it, without a walk. Rules added later go
    // through insertRule. A sheet with neither units nor queries has nothing to do.
    const text = sheet.ownerNode?.localName === 'style' ? sheet.ownerNode.textContent : '';
    const units = !text || hasUnits(text);
    if (units || /@(media|import)/i.test(text)) walkRules(rules, units);
    if (text.includes(HAS)) collectHas(rules);
  }
  const visitRoot = (root) => {
    for (const sheet of Array.from(root.styleSheets)) visit(sheet);
    for (const sheet of root.adoptedStyleSheets ?? []) visit(sheet);
  };

  // Sheets a script writes: the units in its text, the queries once parsed
  // (they go through the same list as any, to follow the box).
  function trackQueries(rules) {
    for (const rule of Array.from(rules)) {
      try {
        if (rule instanceof CSSMediaRule && sheetIsLive(rule.parentStyleSheet)) moveHolder(rule, box.seenW(), box.seenH());
        if (/** @type {any} */ (rule).cssRules?.length) trackQueries(/** @type {any} */ (rule).cssRules);
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
  const edited = new Set();
  let judging = 0;
  function judge() {
    judging = 0;
    const rules = [...edited];
    edited.clear();
    try {
      if (rules.some((rule) => !(rule instanceof CSSStyleRule) || rule.cssRules?.length)) return box.bodyMayHaveChanged();
      const selector = rules.map((rule) => selectorText.get.call(rule)).join();
      if (box.reachable().some((node) => node && matches.call(node, selector))) box.bodyMayHaveChanged();
    } catch {
      box.bodyMayHaveChanged();
    }
  }
  function ruleChanged(rule, live = ruleIsLive(rule)) {
    if (!live) return false;
    box.rulesEdited();
    edited.add(rule);
    judging ||= setTimeout(judge);
    return true;
  }
  sheetProto.insertRule = function (rule, index = 0) {
    if (ours.has(this)) return insertRule.call(this, rule, index);
    const at = insertRule.call(this, typeof rule === 'string' ? shiftUnits(rule) : rule, index);
    const live = sheetIsLive(this);
    if (live) {
      visit(this);
      trackQueries([this.cssRules[at]]);
      ruleChanged(this.cssRules[at], true);
      if (String(rule).includes(HAS)) collectHas([this.cssRules[at]]);
    }
    return at;
  };
  sheetProto.deleteRule = function (index) {
    const removed = this.cssRules[index];
    const live = !ours.has(this) && sheetIsLive(this);
    const result = deleteRule.call(this, index);
    dropMoved(removed);
    if (live) {
      ruleChanged(removed, true);
      queueHasRebuild(); // a removed grouping rule can contain :has() descendants
    }
    return result;
  };
  sheetProto.addRule = function (...args) {
    if (ours.has(this)) return addRule.apply(this, args);
    const shifted = [...args];
    if (typeof shifted[1] === 'string') shifted[1] = shiftUnits(shifted[1]);
    const before = this.cssRules.length;
    const result = addRule.apply(this, shifted);
    visit(this);
    const at = Number.isInteger(result) && result >= 0 ? result : Math.min(Number(args[2] ?? before), this.cssRules.length - 1);
    const added = this.cssRules[at];
    const live = sheetIsLive(this);
    if (live && added) trackQueries([added]);
    if (live) {
      noteHas(String(args[0]));
      box.bodyMayHaveChanged();
    }
    return result;
  };
  sheetProto.removeRule = function (...args) {
    if (ours.has(this)) return removeRule.apply(this, args);
    const removed = this.cssRules[args[0] ?? 0];
    const live = sheetIsLive(this);
    const result = removeRule.apply(this, args);
    dropMoved(removed);
    if (live) {
      queueHasRebuild();
      box.bodyMayHaveChanged();
    }
    return result;
  };
  sheetProto.replaceSync = function (text) {
    if (ours.has(this)) return replaceSync.call(this, text);
    // Replacement detaches the old rules, clearing parentStyleSheet. Capture
    // their media holders first so retained rules are restored and do not stay
    // forever in the strong moved ledger.
    const priorHolders = holdersForSheet(this);
    replaceSync.call(this, shiftUnits(String(text)));
    dropSheetHolders(this, priorHolders);
    const live = sheetIsLive(this);
    if (live) {
      seen.add(this);
      trackQueries(this.cssRules);
    } else {
      seen.delete(this);
    }
    if (live) {
      queueHasRebuild();
      box.bodyMayHaveChanged();
    }
  };
  sheetProto.replace = function (text) {
    if (ours.has(this)) return replace.call(this, text);
    const priorHolders = holdersForSheet(this);
    return replace.call(this, shiftUnits(String(text))).then((sheet) => {
      dropSheetHolders(this, priorHolders);
      const live = sheetIsLive(this);
      if (live) {
        seen.add(this);
        trackQueries(this.cssRules);
      } else {
        seen.delete(this);
      }
      if (live) {
        queueHasRebuild();
        box.bodyMayHaveChanged();
      }
      return sheet;
    });
  };
  // Inside a @media or the like.
  const groupProto = CSSGroupingRule.prototype;
  const { insertRule: insertInGroup, deleteRule: deleteFromGroup } = groupProto;
  groupProto.insertRule = function (rule, index = 0) {
    const at = insertInGroup.call(this, typeof rule === 'string' ? shiftUnits(rule) : rule, index);
    const live = ruleIsLive(this);
    if (live) {
      trackQueries([this.cssRules[at]]);
      ruleChanged(this.cssRules[at], true);
      if (String(rule).includes(HAS)) collectHas([this.cssRules[at]]);
    }
    return at;
  };
  groupProto.deleteRule = function (index) {
    const removed = this.cssRules[index];
    const live = ruleIsLive(this);
    const result = deleteFromGroup.call(this, index);
    ruleChanged(removed, live);
    dropMoved(removed);
    if (live) queueHasRebuild();
    return result;
  };
  // CSSKeyframesRule is not a CSSGroupingRule in Blink. Viewport units added
  // through its legacy mutators must still be virtualized before parsing.
  const keyframesProto = globalThis.CSSKeyframesRule?.prototype;
  if (keyframesProto) {
    const appendKeyframe = keyframesProto.appendRule;
    const deleteKeyframe = keyframesProto.deleteRule;
    if (typeof appendKeyframe === 'function') keyframesProto.appendRule = function (rule) {
      const result = appendKeyframe.call(this, shiftUnits(String(rule)));
      if (ruleIsLive(this)) box.bodyMayHaveChanged();
      return result;
    };
    if (typeof deleteKeyframe === 'function') keyframesProto.deleteRule = function (key) {
      const live = ruleIsLive(this);
      const result = deleteKeyframe.call(this, key);
      if (live) box.bodyMayHaveChanged();
      return result;
    };
  }
  const reread = (proto, name) => {
    const own = Object.getOwnPropertyDescriptor(proto, name);
    if (!own?.set) return;
    Object.defineProperty(proto, name, {
      ...own,
      set(value) {
        const before = sourceSheet(this);
        const wasLive = !!before && sheetIsLive(before);
        own.set.call(this, value);
        if (ours.has(this)) return;
        const after = sourceSheet(this);
        const live = !!after && sheetIsLive(after);
        if (live) visit(after);
        if (wasLive || live) box.bodyMayHaveChanged();
      },
    });
  };
  for (const proto of [StyleSheet.prototype, HTMLStyleElement.prototype, HTMLLinkElement.prototype]) reread(proto, 'disabled');
  const hookMediaOwner = (proto, descriptor, owner = (value) => value) => {
    if (!proto || !descriptor?.get) return;
    Object.defineProperty(proto, 'media', {
      ...descriptor,
      get() {
        const list = descriptor.get.call(this);
        if (list) mediaOwner.set(list, owner(this));
        return list;
      },
    });
  };
  hookMediaOwner(StyleSheet.prototype, sheetMedia);
  hookMediaOwner(mediaRule?.prototype, mediaRuleMedia);
  hookMediaOwner(importRule?.prototype, importRuleMedia, (rule) => rule.styleSheet ?? rule);
  // MediaList text is author input. Undo Margin's previous delta before a
  // list operation, then apply the current box exactly once to the new list.
  const editMedia = (list, edit) => {
    const holder = mediaOwner.get(list);
    const live = holder ? holderIsLive(holder) : true;
    const applied = holder && moved.get(holder);
    if (holder && applied && (applied.dw || applied.dh)) {
      const original = shiftQuery(mediaText.get.call(list), -applied.dw, -applied.dh);
      mediaText.set.call(list, original);
    }
    let changed = false;
    try {
      const result = edit();
      changed = true;
      return result;
    } finally {
      // A native exception (for example, deleting an absent medium) must not
      // leave the author's query restored to full-window coordinates.
      if (holder) {
        moved.delete(holder);
        // If this list had not been reconciled yet, a throwing native edit is
        // observationally a no-op; do not shift it merely because it was read.
        if (live && (changed || applied)) moveHolder(holder, box.seenW(), box.seenH());
        else {
          const sheet = holder instanceof CSSStyleSheet ? holder : holder.parentStyleSheet;
          if (sheet) seen.delete(topSheet(sheet));
        }
      }
      if (live && changed) box.bodyMayHaveChanged();
    }
  };
  Object.defineProperty(MediaList.prototype, 'mediaText', {
    ...mediaText,
    set(value) { editMedia(this, () => mediaText.set.call(this, value)); },
  });
  for (const name of ['appendMedium', 'deleteMedium']) {
    const own = MediaList.prototype[name];
    MediaList.prototype[name] = { [name](medium) {
      return editMedia(this, () => own.apply(this, arguments));
    } }[name];
  }
  // Instrument only declaration objects owned by rules. Patching
  // CSSStyleDeclaration.prototype makes every `element.style` write on every
  // page cross JavaScript, which is a severe tax on animation and dragging.
  // Rule declarations are stable [SameObject] values. Give them one shared
  // child prototype: hundreds of own accessors on every declaration consume
  // tens of MB and turn CSSOM inspection into a long task, while a shared
  // prototype keeps the native object, identity and method brands intact.
  // The supported named properties are engine/version dependent (logical
  // sizes alone add dozens). Capture the browser's own list once; a fixed
  // hand-written subset leaves retained rule declarations permanently stale.
  const directProperties = [];
  try {
    const probe = Document.prototype.createElement.call(document, 'i').style;
    const descriptor = (name) => {
      for (let owner = probe; owner; owner = Object.getPrototypeOf(owner)) {
        const found = Object.getOwnPropertyDescriptor(owner, name);
        if (found) return found;
      }
      return null;
    };
    for (const name in probe) {
      if (name !== 'cssText' && typeof probe[name] === 'string') {
        const native = descriptor(name);
        directProperties.push([name, native?.enumerable ?? false, native?.get ?? null, native?.set ?? null]);
      }
    }
  } catch {}
  const instrumentedDeclarations = new WeakSet();
  const declarationRules = new WeakMap();
  const cssName = (name) => {
    if (name === 'cssFloat') return 'float';
    let property = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    if (/^(?:webkit|moz|ms|o|epub)-/.test(property)) property = `-${property}`;
    return property;
  };
  // CSS declaration values use Web IDL's legacy null-to-empty-string
  // conversion. String(null) would create a literal custom-property value.
  const declarationValue = (value) => value === null ? '' : String(value);
  let ruleDeclarationPrototype = null;
  function declarationPrototype() {
    if (ruleDeclarationPrototype) return ruleDeclarationPrototype;
    const descriptors = {};
    for (const [name, enumerable, nativeGet, nativeSet] of directProperties) {
      const property = cssName(name);
      descriptors[name] = {
        configurable: true,
        enumerable,
        get() { return nativeGet ? nativeGet.call(this) : declarationGet.call(this, property); },
        set(value) {
          const shifted = shiftUnits(declarationValue(value));
          if (nativeSet) nativeSet.call(this, shifted);
          else declarationSet.call(this, property, shifted);
          const owner = declarationRules.get(this);
          if (owner) ruleChanged(owner);
        },
      };
    }
    descriptors.setProperty = {
      configurable: true,
      writable: true,
      value(name, value, priority) {
        const result = declarationSet.call(this, name, shiftUnits(declarationValue(value)), priority);
        const owner = declarationRules.get(this);
        if (owner) ruleChanged(owner);
        return result;
      },
    };
    descriptors.removeProperty = {
      configurable: true,
      writable: true,
      value(name) {
        const result = declarationRemove.call(this, name);
        const owner = declarationRules.get(this);
        if (owner) ruleChanged(owner);
        return result;
      },
    };
    if (declarationText?.set) descriptors.cssText = {
      configurable: true,
      enumerable: declarationText.enumerable ?? false,
      get() { return declarationText.get.call(this); },
      set(value) {
        declarationText.set.call(this, shiftUnits(declarationValue(value)));
        const owner = declarationRules.get(this);
        if (owner) ruleChanged(owner);
      },
    };
    ruleDeclarationPrototype = Object.create(declarationProto, descriptors);
    return ruleDeclarationPrototype;
  }
  function instrumentDeclaration(declaration, rule) {
    if (instrumentedDeclarations.has(declaration)) return;
    instrumentedDeclarations.add(declaration);
    declarationRules.set(declaration, rule);
    try {
      Object.setPrototypeOf(declaration, declarationPrototype());
    } catch {
      // Old engines that reject a platform object's prototype change still get
      // the explicit mutation methods without allocating every named property.
      try {
        Object.defineProperties(declaration, {
          setProperty: {
            configurable: true,
            writable: true,
            value(name, value, priority) {
              const result = declarationSet.call(this, name, shiftUnits(declarationValue(value)), priority);
              const owner = declarationRules.get(this);
              if (owner) ruleChanged(owner);
              return result;
            },
          },
          removeProperty: {
            configurable: true,
            writable: true,
            value(name) {
              const result = declarationRemove.call(this, name);
              const owner = declarationRules.get(this);
              if (owner) ruleChanged(owner);
              return result;
            },
          },
        });
        const ownText = Object.getOwnPropertyDescriptor(declaration, 'cssText');
        if (declarationText?.set) Object.defineProperty(declaration, 'cssText', {
          configurable: true,
          enumerable: ownText?.enumerable ?? false,
          get() { return declarationText.get.call(this); },
          set(value) {
            declarationText.set.call(this, shiftUnits(declarationValue(value)));
            const owner = declarationRules.get(this);
            if (owner) ruleChanged(owner);
          },
        });
      } catch {}
    }
  }
  const hookRuleStyle = (proto, descriptor) => {
    if (!descriptor?.get) return;
    Object.defineProperty(proto, 'style', {
      ...descriptor,
      get() {
        const style = descriptor.get.call(this);
        instrumentDeclaration(style, this);
        return style;
      },
      ...(descriptor.set ? { set(value) {
        descriptor.set.call(this, value);
        if (ruleIsLive(this)) box.bodyMayHaveChanged();
      } } : {}),
    });
  };
  hookRuleStyle(CSSStyleRule.prototype, ruleStyle);
  if (keyframeRule && keyframeStyle) hookRuleStyle(keyframeRule.prototype, keyframeStyle);

  const instrumentedStyleMaps = new WeakSet();
  const styleMapProto = globalThis.StylePropertyMap?.prototype;
  function instrumentStyleMap(map, rule) {
    if (!styleMapProto || instrumentedStyleMaps.has(map)) return;
    instrumentedStyleMaps.add(map);
    for (const name of ['set', 'append', 'delete', 'clear']) {
      const own = styleMapProto[name];
      if (typeof own !== 'function') continue;
      try {
        Object.defineProperty(map, name, {
          configurable: true,
          writable: true,
          value(...args) {
            if (name === 'set' || name === 'append') args = args.map((value, index) => {
              if (index === 0 || typeof value === 'string') return index === 0 ? value : shiftUnits(value);
              const text = String(value);
              return hasUnits(text) ? shiftUnits(text) : value;
            });
            const result = own.apply(this, args);
            ruleChanged(rule);
            return result;
          },
        });
      } catch {}
    }
  }
  if (ruleStyleMap) {
    Object.defineProperty(CSSStyleRule.prototype, 'styleMap', {
      ...ruleStyleMap,
      get() {
        const map = ruleStyleMap.get.call(this);
        instrumentStyleMap(map, this);
        return map;
      },
    });
  }
  Object.defineProperty(CSSStyleRule.prototype, 'selectorText', {
    ...selectorText,
    set(value) {
      selectorText.set.call(this, value);
      if (ruleIsLive(this)) {
        noteHas(String(value));
        box.bodyMayHaveChanged();
      }
    },
  });

  // ---- :has() ----------------------------------------------------------------
  // A geometry-relevant `:has()` can turn on with no DOM mutation at all
  // (`checked`, focus, hover). Keep only selectors from the current live rule
  // graph and coalesce both DOM and state changes into one answer check.
  const HAS = ':has(';
  let hasRules = new Set();
  /** @type {string[]} */
  let aboutBody = [];
  let answers = '';
  let hasCheckQueued = false;
  let hasRebuildQueued = false;
  let hasGraphDirty = true;
  let watchingHas = false;
  let watchingHasDocument = false;
  let hasInShadow = false;
  let forceHasCheck = false;
  let documentHasState = false;
  /** Shadow roots whose own live rule graph contains :has(). */
  let shadowHasRoots = new Set();
  /** Those roots whose :has() graph can change without a DOM mutation. */
  let shadowHasStateRoots = new Set();
  /** Those roots whose selector can also depend on the host's light tree. */
  let shadowHasLightRoots = new Set();
  let shadowHasGlobalContext = false;
  let watchedHasRoots = new Set();
  // Can this selector's subject be one of the nodes which contributes to the
  // body reading? Test both truth values for each :has(). Merely removing it
  // breaks negation (`body:not(:has(.x))` becomes `body:not(*)`). Eight
  // combinations cover normal selectors; a more complex one is watched
  // conservatively instead of risking stale geometry.
  function nextHas(text) {
    let quote = '';
    let brackets = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '\\') { i++; continue; }
      if (quote) {
        if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '[') { brackets++; continue; }
      if (char === ']') { brackets = Math.max(0, brackets - 1); continue; }
      if (!brackets && text.startsWith(HAS, i)) return i;
    }
    return -1;
  }
  function afterHas(text, at) {
    let depth = 1;
    let quote = '';
    let brackets = 0;
    for (let i = at + HAS.length; i < text.length; i++) {
      const char = text[i];
      if (char === '\\') { i++; continue; }
      if (quote) {
        if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '[') { brackets++; continue; }
      if (char === ']') { brackets = Math.max(0, brackets - 1); continue; }
      if (brackets) continue;
      if (char === '(') depth++;
      else if (char === ')' && --depth === 0) return i + 1;
    }
    return -1;
  }
  function possibleSubjects(selector) {
    const expand = (text) => {
      const at = nextHas(text);
      if (at < 0) return [text];
      const end = afterHas(text, at);
      if (end < 0) return ['*'];
      const tails = expand(text.slice(end));
      const variants = [];
      for (const replacement of [':is(*)', ':not(*)']) for (const tail of tails) {
        variants.push(`${text.slice(0, at)}${replacement}${tail}`);
        if (variants.length >= 8) return ['*'];
      }
      return variants;
    };
    return expand(selector);
  }
  // A 1 for every body-reachable node that it matches.
  function ask(selector) {
    try {
      return box.reachable().map((node) => (node && matches.call(node, selector) ? 1 : 0)).join('');
    } catch {
      return '';
    }
  }
  const answersNow = () => aboutBody.map(ask).join();
  function checkHas() {
    if (!hasCheckQueued) return;
    hasCheckQueued = false;
    const forced = forceHasCheck;
    forceHasCheck = false;
    const next = answersNow();
    if (next === answers && !forced) return;
    answers = next;
    box.bodyMayHaveChanged();
  }
  function queueHasCheck(force = false) {
    if (!watchingHas && !hasInShadow) return;
    forceHasCheck ||= force === true;
    if (hasCheckQueued) return;
    hasCheckQueued = true;
    queueMicrotask(checkHas);
  }
  function nodeTouchesShadowRoots(node, roots) {
    if (shadowHasGlobalContext && roots.size) return true;
    if (!(node instanceof Node)) return false;
    const root = getRootNode.call(node);
    if (root instanceof ShadowRoot) return roots.has(root);
    for (const shadow of roots) {
      const host = shadow.host;
      if (node === host || (shadowHasLightRoots.has(shadow) && host.contains(node))) return true;
    }
    return false;
  }
  const nodeTouchesShadowHas = (node) => nodeTouchesShadowRoots(node, shadowHasRoots);
  const nodeTouchesShadowState = (node) => nodeTouchesShadowRoots(node, shadowHasStateRoots);
  function recordTouchesShadowHas(record) {
    if (nodeTouchesShadowHas(record.target)) return true;
    if (record.type !== 'childList') return false;
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (nodeTouchesShadowHas(node)) return true;
    }
    return false;
  }
  function processHasRecords(records) {
    const relevant = records.filter((record) => record.type !== 'attributes' || record.attributeName !== box.readAttribute);
    if (!relevant.length) return;
    box.preferPrivateRead('mutation');
    queueHasCheck(hasInShadow && relevant.some(recordTouchesShadowHas));
  }
  const hasWatch = new MutationObserver(processHasRecords);
  function collectCurrentHas(rules, into) {
    let found = false;
    for (const rule of Array.from(rules)) {
      try {
        if (rule instanceof CSSStyleRule) {
          const selector = selectorText.get.call(rule);
          if (selector.includes(HAS)) {
            into.add(selector);
            found = true;
          }
        }
        if (/** @type {any} */ (rule).cssRules?.length) found = collectCurrentHas(/** @type {any} */ (rule).cssRules, into) || found;
        if (/** @type {any} */ (rule).styleSheet?.cssRules) found = collectCurrentHas(/** @type {any} */ (rule).styleSheet.cssRules, into) || found;
      } catch {}
    }
    return found;
  }
  function refreshHas() {
    aboutBody = [...hasRules].filter((selector) => possibleSubjects(selector).some((subject) => ask(subject).includes('1')));
    answers = answersNow();
    documentHasState = aboutBody.some(hasStatefulPseudo);
    const documentWanted = aboutBody.length > 0 || shadowHasLightRoots.size > 0 || shadowHasGlobalContext;
    const wanted = documentWanted || shadowHasRoots.size > 0;
    const rootsChanged = shadowHasRoots.size !== watchedHasRoots.size || [...shadowHasRoots].some((root) => !watchedHasRoots.has(root));
    if (wanted !== watchingHas || documentWanted !== watchingHasDocument || rootsChanged) {
      hasWatch.disconnect();
      watchingHas = wanted;
      watchingHasDocument = documentWanted;
      watchedHasRoots = new Set(shadowHasRoots);
      const options = { childList: true, subtree: true, attributes: true };
      if (documentWanted) hasWatch.observe(document, options);
      for (const root of shadowHasRoots) if (rootConnected(root)) hasWatch.observe(root, options);
    }
    listenForHasState(documentHasState || shadowHasStateRoots.size > 0);
  }
  function rebuildHas() {
    hasRebuildQueued = false;
    if (!hasGraphDirty) return;
    hasGraphDirty = false;
    const next = new Set();
    const nextShadowRoots = new Set();
    const nextShadowStateRoots = new Set();
    const nextShadowLightRoots = new Set();
    let nextShadowGlobalContext = false;
    for (const root of knownRoots) {
      if (!rootConnected(root)) continue;
      const local = new Set();
      for (const sheet of [...Array.from(root.styleSheets), ...(root.adoptedStyleSheets ?? [])]) {
        try {
          collectCurrentHas(sheet.cssRules, local);
        } catch {}
      }
      if (root === document) {
        for (const selector of local) next.add(selector);
      } else if (local.size) {
        nextShadowRoots.add(root);
        if ([...local].some(hasStatefulPseudo)) nextShadowStateRoots.add(root);
        if ([...local].some((selector) => selector.includes(':host'))) nextShadowLightRoots.add(root);
        if ([...local].some((selector) => selector.includes(':host-context('))) nextShadowGlobalContext = true;
      }
    }
    const changed = next.size !== hasRules.size
      || [...next].some((selector) => !hasRules.has(selector))
      || nextShadowRoots.size !== shadowHasRoots.size
      || [...nextShadowRoots].some((root) => !shadowHasRoots.has(root))
      || nextShadowStateRoots.size !== shadowHasStateRoots.size
      || [...nextShadowStateRoots].some((root) => !shadowHasStateRoots.has(root))
      || nextShadowLightRoots.size !== shadowHasLightRoots.size
      || [...nextShadowLightRoots].some((root) => !shadowHasLightRoots.has(root))
      || nextShadowGlobalContext !== shadowHasGlobalContext;
    hasRules = next;
    shadowHasRoots = nextShadowRoots;
    shadowHasStateRoots = nextShadowStateRoots;
    shadowHasLightRoots = nextShadowLightRoots;
    shadowHasGlobalContext = nextShadowGlobalContext;
    hasInShadow = shadowHasRoots.size > 0;
    refreshHas();
    if (changed) box.bodyMayHaveChanged();
  }
  function queueHasRebuild() {
    hasGraphDirty = true;
    if (hasRebuildQueued) return;
    hasRebuildQueued = true;
    queueMicrotask(rebuildHas);
  }
  function noteHas(_selector) { queueHasRebuild(); }
  function collectHas(_rules) { queueHasRebuild(); }
  box.onRead.push(refreshHas);
  const HAS_STATE_EVENTS = ['focusin', 'focusout', 'pointerover', 'pointerout', 'pointerdown', 'pointerup', 'pointercancel', 'input', 'change', 'reset', 'toggle', 'hashchange', 'popstate', 'fullscreenchange', 'play', 'pause', 'ended'];
  let listeningForHasState = false;
  function stateChangeTouches(eventTarget) {
    const shadow = hasInShadow && (!(eventTarget instanceof Node) || nodeTouchesShadowState(eventTarget));
    if (!documentHasState && !shadow) return;
    queueHasCheck(shadow);
  }
  const hasStateChanged = (event) => stateChangeTouches(event?.target);
  function listenForHasState(wanted) {
    if (wanted === listeningForHasState) return;
    listeningForHasState = wanted;
    if (wanted) installHasStateSetters();
    for (const type of HAS_STATE_EVENTS) {
      if (wanted) addEventListener(type, hasStateChanged, { capture: true, passive: true });
      else removeEventListener(type, hasStateChanged, true);
    }
  }
  const stateSetter = (proto, name) => {
    const own = proto && Object.getOwnPropertyDescriptor(proto, name);
    if (!own?.set) return;
    Object.defineProperty(proto, name, {
      ...own,
      set(value) {
        own.set.call(this, value);
        if (listeningForHasState) stateChangeTouches(this);
      },
    });
  };
  const stateSetters = /** @type {[any, string[]][]} */ ([
    [globalThis.HTMLInputElement?.prototype, ['checked', 'indeterminate', 'value']],
    [globalThis.HTMLOptionElement?.prototype, ['selected']],
    [globalThis.HTMLSelectElement?.prototype, ['selectedIndex', 'value']],
    [globalThis.HTMLTextAreaElement?.prototype, ['value']],
  ]);
  const validity = globalThis.HTMLInputElement?.prototype?.setCustomValidity;
  let stateSettersInstalled = false;
  function installHasStateSetters() {
    if (stateSettersInstalled) return;
    stateSettersInstalled = true;
    for (const [proto, names] of stateSetters) for (const name of names) stateSetter(proto, name);
    if (validity) HTMLInputElement.prototype.setCustomValidity = function (...args) {
      const result = validity.apply(this, args);
      if (listeningForHasState) stateChangeTouches(this);
      return result;
    };
  }

  // ---- style attributes ------------------------------------------------------
  const INLINE = '[style*="vw"], [style*="vh"], [style*="vmin"], [style*="vmax"]';
  function shiftInline(node) {
    const { style } = node;
    if (!style || !hasUnits(style.cssText)) return;
    for (const name of Array.from(style)) {
      const value = style.getPropertyValue(name);
      const next = shiftUnits(value);
      if (next !== value) declarationSet.call(style, name, next, style.getPropertyPriority(name));
    }
  }
  const inlineIn = (root) => {
    if (root.matches?.(INLINE)) shiftInline(root);
    for (const node of root.querySelectorAll?.(INLINE) ?? []) shiftInline(node);
  };

  // ---- what changed -----------------------------------------------------------
  let sheetCount = 0;
  let graphDirty = false;
  let fullScan = false;
  let forcedPass = false;
  let frame = 0;
  let waiting = false; // for the tab to come into sight
  /** @type {Set<Element | Document | DocumentFragment>} */
  const addedRoots = new Set();
  const dirtyRoots = new Set();
  // Out of sight, what's added isn't kept, however long a chat tab runs: only
  // which root to look through once, when the tab is shown.
  const rescan = new Set();
  const connected = (node) => node === document || (node instanceof ShadowRoot ? rootConnected(node) : inThisDocument(node));
  const passPending = () => forcedPass || fullScan || graphDirty || frame || waiting || addedRoots.size || dirtyRoots.size || rescan.size || document.styleSheets.length !== sheetCount;
  function pass(force = false) {
    forcedPass ||= force;
    if (!passPending()) return false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    waiting = false;
    if (!box.on) {
      // Do not retain arbitrarily large added subtrees while the box is off.
      // The next enable performs one complete, idempotent reconciliation.
      fullScan = true;
      forcedPass = false;
      addedRoots.clear();
      dirtyRoots.clear();
      rescan.clear();
      pruneKnownRoots();
      return true;
    }
    fresh = false;
    if (fullScan) rebuildStyleAttributeWatch();
    const roots = fullScan ? [...knownRoots] : [document, ...dirtyRoots, ...rescan];
    for (const root of new Set(roots)) {
      if (!connected(root)) continue;
      if (fullScan) {
        for (const sheet of [...Array.from(root.styleSheets), ...(root.adoptedStyleSheets ?? [])]) {
          seen.delete(sheet);
          dropSheetHolders(sheet);
        }
        inlineIn(root);
      } else if (rescan.has(root)) inlineIn(root);
      visitRoot(root);
    }
    const graphChanged = graphDirty || fresh || document.styleSheets.length !== sheetCount;
    graphDirty = false;
    fullScan = false;
    forcedPass = false;
    if (graphChanged) {
      box.bodyMayHaveChanged();
      queueHasRebuild();
    }
    sheetCount = document.styleSheets.length;
    dirtyRoots.clear();
    for (const root of addedRoots) if (connected(root)) inlineIn(root);
    addedRoots.clear();
    rescan.clear();
    if (pruneKnownRoots()) {
      // Pruning happened after this pass computed graphChanged.
      graphDirty = false;
      box.bodyMayHaveChanged();
    } else pruneMoved();
    return true;
  }
  function soon(force = false) {
    forcedPass ||= force;
    if (!passPending()) return;
    if (frame || waiting) return;
    if (document.hidden) waiting = true;
    else frame = requestAnimationFrame(() => pass());
  }
  const isStyle = (node) => node.nodeName === 'STYLE' || node.nodeName === 'style' || node.nodeName === 'LINK';
  function invalidateStyle(node, force = false) {
    const prior = nodeSheets.get(node);
    const current = node?.sheet;
    if (force || prior !== current) {
      dropNodeHolders(node);
      if (prior) {
        seen.delete(prior);
        dropSheetHolders(prior);
      }
      if (current) {
        seen.delete(current);
        dropSheetHolders(current);
      }
    }
    if (current) nodeSheets.set(node, current);
    else nodeSheets.delete(node);
  }
  function invalidateStylesIn(root) {
    if (isStyle(root)) invalidateStyle(root, true);
    for (const node of root.querySelectorAll?.('style, link') ?? []) invalidateStyle(node, true);
  }
  function processRecords(records) {
    const relevant = records.filter((record) => record.type !== 'attributes' || record.attributeName !== box.readAttribute);
    if (!relevant.length) return;
    box.preferPrivateRead('mutation');
    if (!box.on) {
      graphDirty = true;
      fullScan = true;
      addedRoots.clear();
      dirtyRoots.clear();
      rescan.clear();
      pruneKnownRoots();
      return;
    }
    const hidden = document.hidden;
    let changed = false;
    let removed = false;
    let styleRemoved = false;
    box.childrenChanged();
    for (const record of relevant) {
      if (record.type === 'characterData') { // a <style>'s text: a new sheet
        const holder = /** @type {any} */ (record.target.parentElement);
        if (isStyle(holder)) invalidateStyle(holder, true);
        const root = getRootNode.call(record.target);
        if (root instanceof ShadowRoot) dirtyRoots.add(root);
        changed = true;
        continue;
      }
      if (record.type === 'attributes') {
        // A style attribute a script wrote: done here, before it's painted. A
        // record of our own write finds nothing left to rewrite, and animated
        // styles cost one test.
        const target = /** @type {any} */ (record.target);
        if (record.attributeName === 'style') {
          if (hasUnits(target.getAttribute('style') ?? '')) shiftInline(target);
        } else if (isStyle(target)) {
          if (!inThisDocument(target)) continue;
          if (record.attributeName === 'href' || record.attributeName === 'rel' || record.attributeName === 'type') {
            invalidateStyle(target);
            const root = getRootNode.call(target);
            if (root instanceof ShadowRoot) dirtyRoots.add(root);
            changed = true;
          }
          if (record.attributeName === 'media' && target.sheet) {
            moved.delete(target.sheet);
            try { moveHolder(target.sheet, box.seenW(), box.seenH()); } catch {}
          }
          if (record.attributeName === 'disabled' && target.sheet && sheetIsLive(target.sheet)) visit(target.sheet);
          box.bodyMayHaveChanged();
        }
        continue;
      }
      if (isStyle(record.target)) {
        invalidateStyle(record.target, true);
        const root = getRootNode.call(record.target);
        if (root instanceof ShadowRoot) dirtyRoots.add(root);
        changed = true;
      }
      let added = false;
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        added = true;
        const element = /** @type {Element} */ (node);
        // Looked through once, from the topmost added.
        if (!hidden && (element.firstElementChild || element.hasAttribute('style')) && !addedRoots.has(/** @type {Element} */ (element.parentNode))) addedRoots.add(element);
        if (isStyle(element)) changed = true;
        observeStyleNodes(element);
        // A declarative shadow root the parser has just attached.
        discoverRoots(element);
      }
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        removed = true;
        const element = /** @type {Element} */ (node);
        if (isStyle(element) || element.querySelector?.('style, link')) {
          invalidateStylesIn(element);
          styleRemoved = true;
          changed = true;
        }
      }
      if (!added) continue;
      const root = getRootNode.call(record.target);
      if (hidden) rescan.add(root);
      else if (root !== document && root instanceof ShadowRoot) dirtyRoots.add(root);
    }
    if (removed) {
      const rootsPruned = pruneKnownRoots();
      if (rootsPruned) changed = true;
      else if (styleRemoved) rebuildStyleAttributeWatch();
    }
    if (changed) {
      graphDirty = true;
      queueHasRebuild();
    }
    if (changed || addedRoots.size || dirtyRoots.size || rescan.size || document.styleSheets.length !== sheetCount) soon();
  }
  const watch = new MutationObserver(processRecords);
  const styleAttributeWatch = new MutationObserver(processRecords);
  const STYLE_TEXT = { characterData: true, subtree: true };
  const WATCH = { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] };
  const STYLE_ATTRIBUTES = { attributes: true, attributeFilter: ['media', 'disabled', 'href', 'rel', 'type'] };
  function observeStyleNodes(root) {
    if (isStyle(root) && inThisDocument(root)) styleAttributeWatch.observe(root, STYLE_ATTRIBUTES);
    for (const node of root.querySelectorAll?.('style, link') ?? []) {
      if (inThisDocument(node)) styleAttributeWatch.observe(node, STYLE_ATTRIBUTES);
    }
  }
  function rebuildStyleAttributeWatch() {
    styleAttributeWatch.disconnect();
    for (const root of knownRoots) if (rootConnected(root)) observeStyleNodes(root);
  }
  const watchedRoots = new WeakSet();
  // One observer owns every live root. When a host leaves the document,
  // disconnect and rebuild that observed set as well as the strong registry;
  // otherwise the observer itself can retain a detached closed tree.
  function pruneKnownRoots() {
    let pruned = false;
    for (const root of knownRoots) {
      if (rootConnected(root)) continue;
      knownRoots.delete(root);
      dirtyRoots.delete(root);
      rescan.delete(root);
      pruned = true;
    }
    for (const root of addedRoots) if (!connected(root)) addedRoots.delete(root);
    if (!pruned) return false;
    graphDirty = true;
    watch.disconnect();
    for (const root of knownRoots) watch.observe(root, WATCH);
    rebuildStyleAttributeWatch();
    pruneMoved();
    queueHasRebuild();
    return true;
  }
  function styleLoaded(event) {
    if (!isStyle(event.target) || !sourceIsLive(event.target)) return; // a <style> says so too, once its @imports are in
    const current = event.target.sheet;
    if (current && nodeSheets.get(event.target) === current) seen.delete(current);
    else invalidateStyle(event.target, true);
    graphDirty = true;
    queueHasRebuild();
    pass();
    box.bodyMayHaveChanged(); // another origin's sheet can't be read, but it applies
  }
  function watchRoot(root) {
    // attachShadow() is also used to prepare detached component templates. A
    // weak host-to-root entry is enough until insertion; observing it now would
    // retain the never-connected host and its whole subtree for the document.
    if (!rootConnected(root)) {
      if (knownRoots.has(root)) pruneKnownRoots();
      return;
    }
    if (watchedRoots.has(root)) {
      if (rootConnected(root)) {
        const reconnected = !knownRoots.has(root);
        // Disconnected roots are pruned from the strong set. Put a root back
        // before visiting it so a constructed adopted sheet is live again on
        // the very turn its host is reattached.
        knownRoots.add(root);
        if (reconnected) {
          watch.observe(root, WATCH);
          observeStyleNodes(root);
        }
        visitRoot(root);
        if (reconnected) {
          dirtyRoots.add(root);
          graphDirty = true;
          soon();
        }
      }
      return;
    }
    watchedRoots.add(root);
    knownRoots.add(root);
    watch.observe(root, WATCH);
    observeStyleNodes(root);
    root.addEventListener('load', styleLoaded, true);
    visitRoot(root);
    dirtyRoots.add(root);
    if (rootConnected(root)) {
      graphDirty = true;
      soon();
    }
  }
  const attachedRoots = new WeakMap();
  function discoverRoots(root) {
    const own = root.shadowRoot ?? attachedRoots.get(root);
    if (own) watchRoot(own);
    for (const element of root.querySelectorAll?.('*') ?? []) {
      const shadow = element.shadowRoot ?? attachedRoots.get(element);
      if (shadow) watchRoot(shadow);
    }
  }
  watch.observe(document, WATCH);
  observeStyleNodes(document);
  const { attachShadow } = Element.prototype;
  Element.prototype.attachShadow = function (...args) {
    const root = attachShadow.apply(this, args);
    attachedRoots.set(this, root);
    watchRoot(root);
    return root;
  };

  // adoptedStyleSheets is an observable array and produces no DOM mutation.
  // Wrap every shadow root just as box.js wraps the document, reconciling a
  // newly adopted prebuilt sheet before author code can paint it.
  const adoptedViews = new WeakMap();
  function shadowSheetsChanged(root) {
    if (!rootConnected(root)) return;
    watchRoot(root);
    queueHasRebuild();
    pruneMoved();
    box.bodyMayHaveChanged();
  }
  if (shadowAdopted?.get && shadowAdopted?.set) Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
    ...shadowAdopted,
    get() {
      const source = shadowAdopted.get.call(this);
      const known = adoptedViews.get(this);
      if (known?.source === source) return known.view;
      const changed = () => shadowSheetsChanged(this);
      const view = new Proxy(source, {
        set(target, property, value, receiver) {
          const result = Reflect.set(target, property, value, receiver);
          changed();
          return result;
        },
        deleteProperty(target, property) {
          const result = Reflect.deleteProperty(target, property);
          changed();
          return result;
        },
      });
      adoptedViews.set(this, { source, view });
      return view;
    },
    set(list) {
      shadowAdopted.set.call(this, list);
      shadowSheetsChanged(this);
    },
  });

  // A sheet that has just loaded: rewritten before it's painted.
  document.addEventListener('load', styleLoaded, true);
  // Always, hidden or not: a tab prepared behind the page is ready when it's shown.
  document.addEventListener('DOMContentLoaded', () => {
    pass(true);
    box.loaded();
  });
  addEventListener('load', () => {
    pass(true);
    box.loaded(); // a site's own reset, late
  });
  // Capture runs before box.js' visibility listener, so a native tab show
  // reconciles stylesheet text before its pending body reading is consumed.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && waiting) pass(); }, true);
  // A clean move needs no sheet walk: media holders move onRest and viewport
  // units use the live box variables. Pending/full-scan work still schedules.
  box.onMove.push(() => { if (box.on) soon(); });
  box.onAdopted.push((root) => {
    visitRoot(root);
    queueHasRebuild();
    pruneMoved();
    box.bodyMayHaveChanged();
  });
  box.onRoot.push(() => {
    discoverRoots(document);
    pass(true);
  });
  function flush() {
    // A resize handler can synchronously change a <style> or append a sheet.
    // MutationObserver delivery is later; preflight must consume those records
    // before it acknowledges the destination's geometry.
    let records;
    do {
      records = [...watch.takeRecords(), ...styleAttributeWatch.takeRecords()];
      if (records.length) processRecords(records);
    } while (records.length);
    const hasRecords = hasWatch.takeRecords();
    if (hasRecords.length) processHasRecords(hasRecords);
    checkHas();
    // A resize listener can edit or replace a :has() rule in this same task.
    // Do not leave its live selector graph to the next microtask/visible frame.
    if (hasRebuildQueued) rebuildHas();
    // Rule edits are normally judged after the author's turn so thousands of
    // edits cost one selector match. A hidden tab can be suspended before that
    // timer runs; destination preflight must consume it before claiming that
    // the body geometry is current.
    if (judging) {
      clearTimeout(judging);
      judge();
    }
    if (passPending()) pass();
    // The pass itself can discover a new or removed sheet and queue another
    // graph rebuild. Preparation acknowledges only the fully current graph.
    if (hasRebuildQueued) rebuildHas();
  }
  discoverRoots(document);
  addedRoots.add(document.documentElement); // injected late: what's there already
  document.addEventListener('margin:sheets', () => pass(true)); // content/page-link.js
  pass();
  return { flush };
}

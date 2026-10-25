// T4-T13 for the iframe-shell prototype (imported by run.mjs).
import { A, B, X, DIR, launch, serverLog, clearLog, waitFor, card, shellLog, gotoShell, frameUrlIs, sleep, summarizeLog, within, progress } from './lib.mjs';

const navReqs = (log, re = /./) => summarizeLog(log, (e) => (e.dest === 'document' || e.dest === 'iframe') && re.test(e.path));
const topState = async (page) => ({
  top: page.url(),
  frame: card(page)?.url() ?? null,
  title: await within(page.title()),
  marker: await within(page.evaluate(() => window.__marker ?? null)),
  shelled: await within(page.evaluate(() => !!document.getElementById('margin-frame'))),
});
const cardReady = (page, re) => waitFor(async () => {
  const f = card(page);
  if (!f || !re.test(f.url())) return null;
  return (await f.evaluate(() => document.readyState === 'complete').catch(() => false)) ? f : null;
}, { timeout: 8000 });

export const tests = {
  // ------------------------------------------------------------------ T4 back/forward
  async T4() {
    const out = { steps: [] };
    const { context } = await launch();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await gotoShell(page, `${A}/p/A`);
    await page.evaluate(() => { window.__marker = 'alive'; });
    await clearLog();
    for (const id of ['b', 'c']) {
      await card(page).click('#' + id);
      await cardReady(page, new RegExp(`/p/${id.toUpperCase()}$`));
      await waitFor(() => page.url().endsWith('/p/' + id.toUpperCase()));
    }
    const hist = async () => {
      const h = await cdp.send('Page.getNavigationHistory');
      return { currentIndex: h.currentIndex, entries: h.entries.map((e) => `${e.url} | ${e.title}`) };
    };
    out.afterABC = { ...(await topState(page)), historyLength: await page.evaluate(() => history.length), browserHistory: await hist() };
    const step = async (label, action, expect) => {
      const t0 = Date.now();
      await action();
      await cardReady(page, expect);
      await waitFor(() => expect.test(page.url()), { timeout: 3000 });
      out.steps.push({ label, ms: Date.now() - t0, ...(await topState(page)), browserHistory: await hist() });
    };
    await step('card: history.back()', () => card(page).evaluate(() => history.back()), /\/p\/B$/);
    await step('top (shell): history.back()', () => page.evaluate(() => history.back()), /\/p\/A$/);
    let h = await cdp.send('Page.getNavigationHistory');
    await step('browser forward (CDP navigateToHistoryEntry)', () => cdp.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex + 1].id }), /\/p\/B$/);
    h = await cdp.send('Page.getNavigationHistory');
    await step('browser forward again', () => cdp.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex + 1].id }), /\/p\/C$/);
    h = await cdp.send('Page.getNavigationHistory');
    await step('browser back', () => cdp.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id }), /\/p\/B$/);
    out.requestsDuringHistory = navReqs(await serverLog());
    out.markerAtEnd = await page.evaluate(() => window.__marker);
    await context.close();
    return out;
  },

  // ------------------------------------------------------------------ T5 cross-origin navigations from the card
  async T5() {
    const out = {};
    const { context } = await launch();
    const run = async (label, start, act, expectTop, { after } = {}) => {
      const page = await context.newPage();
      await gotoShell(page, start);
      await clearLog();
      const t0 = Date.now();
      await act(page);
      const ok = await waitFor(() => expectTop.test(page.url()), { timeout: 6000 });
      const settled = await waitFor(async () => {
        const shelled = await page.evaluate(() => !!document.getElementById('margin-frame')).catch(() => null);
        if (shelled === false) return true;
        const f = card(page);
        return f && expectTop.test(f.url()) && (await f.evaluate(() => document.readyState === 'complete').catch(() => false));
      }, { timeout: 6000 });
      const r = { ok: !!ok, settled: !!settled, ms: Date.now() - t0, ...(await topState(page)), requests: navReqs(await serverLog()), skip: (await shellLog(page))?.find((e) => e.ev === 'skip') ?? null };
      if (after) r.after = await after(page);
      out[label] = r;
      return page;
    };
    await run('a_click_cross_origin_link', `${A}/p/start`, (p) => card(p).click('#xo'), /^http:\/\/localhost:8922\/p\/xo$/);
    await run('b_script_location_cross_origin', `${A}/p/start`, (p) => card(p).evaluate((u) => { location.href = u; }, `${B}/p/xo2`), /^http:\/\/localhost:8922\/p\/xo2$/);
    await run('c_same_origin_302_to_cross_origin', `${A}/p/start`, (p) => card(p).click('#redir'), /^http:\/\/localhost:8922\/p\/xo-redir$/, {
      after: async (page) => {
        // What does Back do after a redirect hand-off?
        await page.evaluate(() => history.back());
        await sleep(1500);
        const s = await topState(page);
        return { afterBack: s, requestsAfterBack: navReqs(await serverLog()).slice(-4) };
      },
    });
    await run('d_cross_site_link', `${A}/p/start`, (p) => card(p).click('#xs'), /^http:\/\/127\.0\.0\.1:8921\/p\/xs$/);
    await run('e_cross_origin_POST_form', `${A}/p/start`, (p) => card(p).click('#f-xo-btn'), /^http:\/\/localhost:8922\/post$/, {
      after: async (page) => ({ body: await page.evaluate(() => document.getElementById('body')?.textContent ?? document.body?.innerHTML?.slice(0, 200)) }),
    });
    await run('f_same_origin_POST_target_top', `${A}/p/start`, (p) => card(p).click('#f-same-top-btn'), /^http:\/\/localhost:8921\/post$/, {
      after: async (page) => ({ body: await page.evaluate(() => document.getElementById('body')?.textContent ?? null) }),
    });
    await context.close();
    return out;
  },

  // ------------------------------------------------------------------ T6 frame busting
  async T6() {
    const out = {};
    const { context } = await launch();
    for (const mode of ['assign', 'replace', 'href', 'reload', 'other', 'owasp']) {
      for (const guard of [true, false]) {
        const page = await context.newPage();
        const q = mode === 'owasp' ? 'owasp=1' : `bust=${mode}`;
        const url = `${A}/p/bust-${mode}?${q}${guard ? '' : '&margin-nonav'}`;
        await clearLog();
        await page.goto(url, { waitUntil: 'commit' });
        await sleep(2000);
        const log = await serverLog();
        const docs = log.filter((e) => e.path.startsWith(`/p/bust-${mode}`) || e.path.startsWith('/p/framed-warning'));
        const f = card(page);
        progress('T6', mode, guard);
        const sl = await within(shellLog(page));
        const r = {
          topDocumentRequests2s: docs.filter((e) => e.dest === 'document').length,
          iframeRequests2s: docs.filter((e) => e.dest === 'iframe').length,
          ...(await topState(page)),
          cardTitle: f ? await within(f.evaluate(() => document.title)) : null,
          cardHtmlDisplay: f ? await within(f.evaluate(() => getComputedStyle(document.documentElement).display)) : null,
          events: Array.isArray(sl) ? sl.filter((e) => /bust|reload|top-nav|unhide/.test(e.ev)).map((e) => `${e.ev}${e.how ? '(' + e.how + ')' : ''} ${e.type ?? ''} cancelable=${e.cancelable ?? ''}`) : sl,
        };
        out[`${mode}_${guard ? 'guarded' : 'unguarded'}`] = r;
        await within(page.goto('about:blank', { waitUntil: 'commit' }), 2000);
        await within(page.close(), 2000);
      }
    }
    await context.close();
    return out;
  },

  // ------------------------------------------------------------------ T7 framing headers
  async T7() {
    const out = { matrix: {}, probes: {} };
    const pages = {
      xfoSameorigin: '?xfo=SAMEORIGIN',
      cspAncestorsSelf: `?csp=${encodeURIComponent("frame-ancestors 'self'")}`,
      xfoDeny: '?xfo=DENY',
      cspAncestorsNone: `?csp=${encodeURIComponent("frame-ancestors 'none'")}`,
      cspNonePlusScriptSrc: `?csp=${encodeURIComponent("frame-ancestors 'none'; script-src 'self'")}`,
      xfoDenyPlusScriptSrc: `?xfo=DENY&csp=${encodeURIComponent("script-src 'self'")}`,
      // The same header also applies to the TOP (shell) document, which creates the iframe:
      topCspFrameSrcNone: `?csp=${encodeURIComponent("frame-src 'none'")}`,
      topCspDefaultSrcNone: `?csp=${encodeURIComponent("default-src 'none'")}`,
      cspSandbox: `?csp=${encodeURIComponent('sandbox allow-scripts allow-forms')}`,
    };
    const modes = {
      none_noFallback: { ruleset: false, flags: 'margin-nofallback' },
      none_fallback: { ruleset: false, flags: '' },
      static_firstParty_subframe_XFO_CSP: { ruleset: true, flags: '' },
      narrow_session_XFO_CSP: { ruleset: false, flags: 'margin-narrow', xfoOnly: false },
      narrow_session_XFOonly_fallback: { ruleset: false, flags: 'margin-narrow', xfoOnly: true },
    };
    const { context, worker } = await launch();
    let n = 0;
    for (const [mname, m] of Object.entries(modes)) {
      await worker.evaluate((on) => self.setStaticRuleset(on), m.ruleset);
      await worker.evaluate((x) => self.setNarrowHeaders(x), !!m.xfoOnly);
      await worker.evaluate(() => self.clearSession());
      out.matrix[mname] = {};
      for (const [pname, qs] of Object.entries(pages)) {
        const page = await context.newPage();
        const path = `/p/h${++n}-${pname}`;
        const url = `${A}${path}${qs}${m.flags ? '&' + m.flags : ''}`;
        await clearLog();
        const t0 = Date.now();
        await page.goto(url, { waitUntil: 'commit' });
        await sleep(1200);
        const f = card(page);
        const shelled = await page.evaluate(() => !!document.getElementById('margin-frame')).catch(() => null);
        let cardOk = null, inline = null;
        if (f) {
          cardOk = await f.evaluate(() => document.title).catch(() => null);
          inline = await f.evaluate(() => window.__inlineRuns ?? 0).catch(() => null);
        }
        const log = await serverLog();
        const sl = await shellLog(page);
        const sl0 = sl || [];
        out.matrix[mname][pname] = {
          outcome: !shelled ? 'top-level (unshelled)' : cardOk && cardOk.startsWith('page ') ? 'in card' : `BLOCKED in card (card title=${JSON.stringify(cardOk)})`,
          cardUrl: f?.url() ?? null,
          inlineScriptRanInCard: shelled ? inline : undefined,
          inlineScriptRanTopLevel: !shelled ? await page.evaluate(() => window.__inlineRuns ?? 0).catch(() => null) : undefined,
          documentRequests: log.filter((e) => e.path.startsWith(path) && (e.dest === 'document' || e.dest === 'iframe')).map((e) => e.dest).join(','),
          armed: sl?.find((e) => e.ev === 'armed') ?? undefined,
          shellEvents: sl0.filter((e) => /fallback|skip|armed/.test(e.ev)).map((e) => e.ev + (e.reason ? ':' + e.reason : '') + (e.why ? ':' + e.why : '')).join(' '),
          ms: Date.now() - t0,
        };
        await page.close();
      }
    }
    // How broad is each header-removal rule? Victim: A/p/victim?xfo=DENY framed by an attacker page.
    const victim = encodeURIComponent(`${A}/p/victim?xfo=DENY`);
    const probe = async (label, attackerUrl, page0) => {
      const page = page0 || (await context.newPage());
      await page.goto(attackerUrl);
      await sleep(800);
      const fr = page.mainFrame().childFrames()[0];
      const title = fr ? await within(fr.evaluate(() => document.title)) : null;
      const res = !fr ? 'no frame' : title === 'page victim' ? 'LOADED (victim framed)' : `BLOCKED (frame title=${JSON.stringify(title)})`;
      if (!page0) await page.close();
      return res;
    };
    for (const [mname, m] of Object.entries({ none: { ruleset: false }, static_firstParty: { ruleset: true }, narrow_session: { ruleset: false, narrow: true } })) {
      await worker.evaluate((on) => self.setStaticRuleset(on), m.ruleset);
      await worker.evaluate((x) => self.setNarrowHeaders(x), false);
      await worker.evaluate(() => self.clearSession());
      const r = {};
      r.sameSiteCrossOriginAttacker_otherTab = await probe('', `${B}/attack?margin-noshell&src=${victim}`);
      r.crossSiteAttacker_otherTab = await probe('', `${X}/attack?margin-noshell&src=${victim}`);
      if (m.narrow) {
        // Same tab, after the shell armed the tab for host "localhost".
        const page = await context.newPage();
        await gotoShell(page, `${A}/p/armed?margin-narrow`);
        r.armedTab_crossSiteAttacker = await probe('', `${X}/attack?margin-noshell&src=${victim}`, page);
        r.armedTab_sameHostOtherPortAttacker = await probe('', `${B}/attack?margin-noshell&src=${victim}`, page);
        r.sessionRules = (await worker.evaluate(() => self.state())).session.map((x) => JSON.stringify(x.condition));
        await page.close();
      }
      out.probes[mname] = r;
    }
    await worker.evaluate(() => self.setStaticRuleset(false));
    await context.close();
    return out;
  },

  // ------------------------------------------------------------------ T8 keeping the original page from running + cost
  async T8() {
    const out = { runs: {} };
    const N = Number(process.env.T8_RUNS || 5);
    const ONLY_STREAM = process.env.ONLY_STREAM === '1';
    const ctxs = { noext: await launch({ ext: false }), ext: await launch() };
    const modes = (process.env.T8_MODES || 'noext,openstop,swap,open,stop,nostop,swapstoptimeout').split(',');
    for (const delay of ONLY_STREAM ? [] : [0, 150]) {
      for (const mode of modes) {
        const ctx = mode === 'noext' ? ctxs.noext : ctxs.ext;
        const rows = [];
        for (let i = 0; i < N; i++) {
          const page = await ctx.context.newPage();
          const name = `t8-${mode}-${delay}-${i}`;
          const url = `${A}/p/${name}?delay=${delay}${mode === 'noext' ? '' : '&margin-' + mode}`;
          await clearLog();
          await page.goto(url, { waitUntil: 'commit' });
          let f;
          if (mode === 'noext') { await page.waitForLoadState('load'); f = page.mainFrame(); }
          else f = await waitFor(async () => { const c = card(page); return c && c.url() !== 'about:blank' && (await c.evaluate(() => document.readyState === 'complete').catch(() => false)) ? c : null; }, { timeout: 8000 });
          await sleep(400); // let beacons land
          const topOrigin = await page.evaluate(() => performance.timeOrigin);
          const t = f ? await f.evaluate(() => {
            const n = performance.getEntriesByType('navigation')[0];
            const fcp = performance.getEntriesByName('first-contentful-paint')[0];
            return { origin: performance.timeOrigin, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, fcp: fcp ? fcp.startTime : null };
          }) : null;
          const rendered = await page.evaluate(() => new Promise((r) => { requestAnimationFrame(() => r(true)); setTimeout(() => r(false), 500); }));
          const log = await serverLog();
          const mine = log.filter((e) => e.path.includes(name));
          const count = (pred) => mine.filter(pred).length;
          const off = t ? t.origin - topOrigin : 0;
          rows.push({
            topDocInlineRan: count((e) => e.beacon?.ev === 'inline' && e.beacon?.where === 'top'),
            topDocExternalScriptRan: count((e) => e.beacon?.ev === 'ext' && e.beacon?.where === 'top'),
            cardInlineRan: count((e) => e.beacon?.ev === 'inline' && e.beacon?.where === 'frame'),
            topDocSubresourcesFetched: mine.filter((e) => /^\/(ext\.js|img\.png)/.test(e.path) && e.path.includes('for=document')).map((e) => e.path.split('?')[0]).join(','),
            htmlRequests: count((e) => e.path.startsWith('/p/')),
            loadMs: t ? +(off + t.load).toFixed(1) : null,
            dclMs: t ? +(off + t.dcl).toFixed(1) : null,
            fcpMs: t?.fcp != null ? +(off + t.fcp).toFixed(1) : null,
            topRenders: rendered,
          });
          await page.close();
        }
        const med = (k) => { const v = rows.map((r) => r[k]).filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
        out.runs[`${mode}_ttfb${delay}`] = {
          medianLoadMs: med('loadMs'), medianDclMs: med('dclMs'), medianFcpMs: med('fcpMs'),
          topDocInlineRan: rows.map((r) => r.topDocInlineRan).join(''), topDocExternalScriptRan: rows.map((r) => r.topDocExternalScriptRan).join(''),
          cardInlineRan: rows.map((r) => r.cardInlineRan).join(''), topDocSubresourcesFetched: rows[0].topDocSubresourcesFetched,
          htmlRequests: rows.map((r) => r.htmlRequests).join(''), topRenders: rows.map((r) => (r.topRenders ? 'y' : 'n')).join(''),
        };
      }
    }
    // Streaming page: does the top-level response keep downloading after the shell took over?
    out.stream = {};
    for (const mode of (process.env.STREAM_MODES || 'noext,openstop,swap,open,stop,swapstopraf').split(',')) {
      const page = await (mode === 'noext' ? ctxs.noext : ctxs.ext).context.newPage();
      const name = `t8s-${mode}`;
      await clearLog();
      await page.goto(`${A}/p/${name}?stream=400&filler=${process.env.FILLER || 20000000}${mode === 'noext' ? '' : '&margin-' + mode}`, { waitUntil: 'commit' });
      await sleep(2500);
      const log = (await serverLog()).filter((e) => e.path.startsWith('/p/' + name));
      const t0 = log[0]?.t ?? 0;
      const sl = await within(shellLog(page));
      const c = card(page);
      const cardFcp = c ? await within(c.evaluate(() => [performance.timeOrigin, performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null])) : null;
      const topOrigin = await within(page.evaluate(() => performance.timeOrigin));
      out.stream[mode] = {
        requests: log.map((e) => ({ dest: e.dest, at: +(e.t - t0).toFixed(1), finished: e.finished, aborted: e.aborted ?? null, closedAt: e.closedAt != null ? +(e.closedAt - t0).toFixed(1) : null })),
        shellFirstRafMs: Array.isArray(sl) ? sl.find((e) => e.ev === 'first-raf')?.t ?? null : sl,
        cardFcpMsFromTopNavStart: Array.isArray(cardFcp) && cardFcp[1] != null ? +(cardFcp[0] - topOrigin + cardFcp[1]).toFixed(1) : null,
      };
      await page.close();
    }
    await ctxs.noext.context.close();
    await ctxs.ext.context.close();
    return out;
  },

  // ------------------------------------------------------------------ T9 keyboard focus
  async T9() {
    const out = {};
    for (const variant of ['noext', 'shell', 'shell_nofocus']) {
      const { context } = await launch({ ext: variant !== 'noext' });
      const page = await context.newPage();
      let f;
      if (variant === 'noext') { await page.goto(`${A}/p/kbd`); f = page.mainFrame(); }
      else f = await gotoShell(page, `${A}/p/kbd${variant === 'shell_nofocus' ? '?margin-nofocus' : ''}`);
      await sleep(300);
      const sy = () => f.evaluate(() => Math.round(scrollY));
      const focusInfo = async () => ({
        topActive: await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName)),
        cardHasFocus: variant === 'noext' ? null : await f.evaluate(() => document.hasFocus()),
      });
      const r = { initialFocus: await focusInfo() };
      await page.keyboard.press('Space'); await sleep(400);
      r.afterSpace = await sy();
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await sleep(400);
      r.afterArrowDown2 = await sy();
      if (variant !== 'noext') {
        await f.evaluate(() => window.scrollTo(0, 0));
        await page.mouse.click(130, 400); // empty sidebar area
        await sleep(200);
        r.afterSidebarClick = await focusInfo();
        await page.keyboard.press('Space'); await sleep(400);
        r.afterSidebarClickThenSpace = await sy();
        await f.evaluate(() => window.scrollTo(0, 0));
        await page.click('#margin-input');
        await page.keyboard.type('abc ');
        await sleep(300);
        r.sidebarInputValue = await page.evaluate(() => document.getElementById('margin-input').value);
        r.scrollWhileTypingInSidebar = await sy();
        r.afterInputFocus = await focusInfo();
        // Click into the page card, then type: keys go to the page.
        await page.mouse.click(600, 300);
        await page.keyboard.press('Space'); await sleep(400);
        r.afterCardClickThenSpace = await sy();
      }
      out[variant] = r;
      await context.close();
    }
    return out;
  },

  // ------------------------------------------------------------------ T10 target=_top / _blank / window.open
  async T10() {
    const out = {};
    const { context } = await launch();
    const page = await context.newPage();
    await gotoShell(page, `${A}/p/start`);
    await page.evaluate(() => { window.__marker = 'alive'; });
    await clearLog();
    await card(page).click('#top-same');
    await cardReady(page, /\/p\/topsame$/);
    await waitFor(() => page.url().endsWith('/p/topsame'));
    out.a_target_top_same_origin = { ...(await topState(page)), requests: navReqs(await serverLog()), events: (await shellLog(page)).filter((e) => /top-nav/.test(e.ev)) };

    const popupCase = async (label, act) => {
      await clearLog();
      const [p2] = await Promise.all([context.waitForEvent('page'), act()]);
      await p2.waitForLoadState('commit').catch(() => {});
      await sleep(1200);
      const r = {
        ...(await topState(p2)),
        hasOpener: await p2.evaluate(() => window.opener !== null).catch(() => null),
        skip: (await shellLog(p2))?.find((e) => e.ev === 'skip') ?? null,
        requests: navReqs(await serverLog()),
      };
      if (r.hasOpener) {
        r.openerIsTheCard = await p2.evaluate(() => { try { return window.opener !== window.opener.top && window.opener.location.pathname; } catch (e) { return 'cross-origin opener'; } });
        await p2.evaluate(() => window.opener.postMessage('hi-from-popup', '*'));
        await sleep(200);
        r.cardReceived = await card(page).evaluate(() => window.__msgs.map((m) => m.data));
      }
      out[label] = r;
      await p2.close();
    };
    await popupCase('b_target_blank_same_origin', () => card(page).click('#blank-same'));
    await popupCase('c_target_blank_rel_opener', () => card(page).click('#blank-opener'));
    await popupCase('d_window_open_from_card', () => card(page).evaluate(() => { window.open('/p/popup', 'pop', 'width=500,height=400'); }));
    await popupCase('e_target_blank_cross_origin', () => card(page).click('#blank-xo'));

    await clearLog();
    await card(page).click('#top-xo');
    await waitFor(() => page.url().startsWith(B), { timeout: 5000 });
    await cardReady(page, /topxo$/);
    out.f_target_top_cross_origin = { ...(await topState(page)), requests: navReqs(await serverLog()) };
    await context.close();
    return out;
  },

  // ------------------------------------------------------------------ T11 reload / T12 print / T13 fullscreen
  async T11() {
    const out = {};
    const { context } = await launch();
    const page = await context.newPage();
    await gotoShell(page, `${A}/p/A`);
    await card(page).click('#b');
    await cardReady(page, /\/p\/B$/);
    await waitFor(() => page.url().endsWith('/p/B'));
    await clearLog();
    await page.reload({ waitUntil: 'commit' }); // browser-initiated reload (toolbar / Cmd+R path)
    await cardReady(page, /\/p\/B$/);
    out.browserReload = { ...(await topState(page)), requests: navReqs(await serverLog()), events: (await shellLog(page)).map((e) => e.ev) };
    await clearLog();
    await card(page).evaluate(() => { setTimeout(() => top.location.reload(), 0); }); // script reload of top after load
    await sleep(1200);
    out.scriptReloadOfTopFromCard = { ...(await topState(page)), requests: navReqs(await serverLog()), events: (await shellLog(page)).filter((e) => /reload|bust/.test(e.ev)).map((e) => e.ev) };
    await context.close();
    return out;
  },

  async T12() {
    const out = {};
    for (const ext of [false, true]) {
      const { context } = await launch({ ext });
      const page = await context.newPage();
      if (ext) await gotoShell(page, `${A}/p/print`); else await page.goto(`${A}/p/print`);
      const cdp = await context.newCDPSession(page);
      const pdf = Buffer.from((await cdp.send('Page.printToPDF', {})).data, 'base64').toString('latin1');
      out[ext ? 'shell_topLevelPrint' : 'plain'] = { pdfPages: (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length, bytes: pdf.length };
      if (ext) {
        // What a shell could do for Cmd+P instead: print the card's own document.
        out.shell_cardPrintCall = await card(page).evaluate(() => typeof window.print);
      }
      await context.close();
    }
    return out;
  },

  async T13() {
    const out = {};
    const { context } = await launch();
    const page = await context.newPage();
    const f = await gotoShell(page, `${A}/p/fs`);
    await f.click('#fs-btn');
    await sleep(800);
    out.cardFs = await f.evaluate(() => ({ fs: window.__fs, el: document.fullscreenElement?.id ?? null, iw: innerWidth, ih: innerHeight }));
    out.topFs = await page.evaluate(() => ({ el: document.fullscreenElement?.id ?? null, rect: JSON.parse(JSON.stringify(document.getElementById('margin-frame').getBoundingClientRect())) }));
    await page.screenshot({ path: `${DIR}results/T13-fullscreen.png` }).catch(() => {});
    await f.evaluate(() => document.exitFullscreen());
    await context.close();
    return out;
  },
};

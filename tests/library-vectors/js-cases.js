// js.json's cases (docs/CORE-REFACTOR.md step 4, part 1): the JavaScript the library's rules rely on, as an engine
// answers it. record.ts runs this in JavaScriptCore (a bare JSContext, as Margin.app runs library.js) and in Node
// (without `URL`, as JSC has none; and with Node's, for the addresses), after a bundle of library.ts's own functions
// (`marginVectors`: model.ts's normalizeUrl, air-traffic.ts's patterns, data-set.ts's fingerprint, the import's ids),
// and keeps JSC's answers, but the addresses' (`url`): Node's with `URL`, the browsers' (Tirth's answer 11).
// Strings that could hold half an emoji are given as UTF-16 units; numbers JSON can't hold as "-0", "NaN",
// "Infinity", "-Infinity".
(() => {
  const V = globalThis.marginVectors;
  const num = (n) => (Object.is(n, -0) ? '-0' : Number.isFinite(n) ? n : String(n));
  const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
  const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);

  // ---- spaces: trim and /\s/ over every code point ----
  const trimmed = [], regex = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    const s = c >= 0xd800 && c <= 0xdfff ? String.fromCharCode(c) : String.fromCodePoint(c);
    if (s.trim() === '') trimmed.push(c);
    if (/\s/.test(s)) regex.push(c);
  }
  const trims = [' a ', '\ufeff a \u3000', '\u0085a\u180e', ' \t\n ', '', 'a b', '\u00a0\u2028x\u2029'].map((s) => [s, s.trim()]);
  const squash = [' a\t\u00a0b\u2028\u2029c\ufeff\u0085d  \u180e e ', 'a b c', 'a  b', 'a\tb', '', '\n\n'].map((s) => [s, s.replace(/\s+/g, ' ')]);

  // ---- UTF-16 lengths and cuts (slice(0, n): a cut can leave half a pair, given as units) ----
  const lengths = ['a😀b', 'é', '', 'e\u0301', '😀😀', '中文', '👍🏽'].map((s) => [s, s.length]);
  const cutInputs = [['a😀b', 1], ['a😀b', 2], ['a😀b', 3], ['😀😀', 1], ['😀😀', 3], ['ab😀', 3], ['ab😀', 4], ['éééé', 2], ['short', 2000], [`${'a'.repeat(1999)}😀tail`, 2000], [`${'a'.repeat(199)}😀`, 200], [`${'a'.repeat(39)}😀`, 40], [`${'a'.repeat(79)}😀`, 80], [`${'a'.repeat(15)}😀`, 16], [`${'a'.repeat(255)}😀`, 256], ['👍🏽x', 3]];
  const cuts = cutInputs.map(([s, n]) => [s, n, units(s.slice(0, n))]);

  // ---- sort() with no comparator: UTF-16 units ----
  const sortInput = ['\ue000', '\uffff', '😀', '\u{10000}', 'a', 'A', '', 'ab', 'a\u0000', '\u00e9', 'e\u0301', '\uff21', '😀x', 't-b', 't-A', 't-a', 't-10', 't-9'];
  const sorted = [...sortInput].sort();

  // ---- localeCompare (the default locale) ----
  const ascii = [];
  for (let c = 0x20; c < 0x7f; c++) ascii.push(String.fromCharCode(c));
  const asciiOrder = [...ascii].sort((a, b) => a.localeCompare(b)).join('');
  let asciiSigns = '';
  for (const a of ascii) for (const b of ascii) asciiSigns += '-0+'[sign(a.localeCompare(b)) + 1];
  const pairs = [['sp-a', 'sp-B'], ['sp-b', 'sp-B'], ['sp-B', 'sp-c'], ['t-a1', 't-a_1'], ['safari:Work:x', 'safari:Personal:x'], ['fav-9', 'fav-a'], ['atc-10', 'atc-9'], ['a', 'a\u0000'], ['sp-x', 'sp-x'], ['', 'a'], ['personal', 'work'], ['work', 'Work'], ['safari:Personal:home', 'safari:Personal:Home'], ['chrome:Default:s1', 'safari:Personal:0'], ['t-abc', 't-ab'], ['é', 'e'], ['e\u0301', '\u00e9'], ['a-b', 'a_b'], ['a:b', 'a-b'], ['a1', 'aa'], ['Z', 'a'], ['zz', 'aaa']].map(([a, b]) => [a, b, sign(a.localeCompare(b))]);
  const locale = (() => { try { return new Intl.Collator().resolvedOptions().locale; } catch (e) { return null; } })();

  // ---- numbers ----
  const numbers = [0, -0, 1, -1, 0.1, 0.1 + 0.2, 1 / 3, 2 / 3, 1e21, 1e20, 123456789012345680000, 1e-6, 1e-7, 1.5e-7, 123e-20, 2 ** 53, 2 ** 53 + 2, 2 ** 53 - 1, -(2 ** 53), 5e-324, 1.7976931348623157e308, 100, 1e300, 0.0000012345, 1234567.125, 4.35, 0.5, -1e-7, 1e15, 1e16, 1e17, 12345678901234567890, 25, 1777777777777.5, 1762000000000, 1.0000000000000002, 999999999999999900000, 1e22, NaN, Infinity, -Infinity];
  const numberStrings = numbers.map((n) => [num(n), String(n), JSON.stringify(n) ?? null]);
  const parsed = ['9007199254740993', '-0', '0.1', '1E2', '1e-400', '123456789012345678901234567890', '1.00000000000000011102230246251565404236316680908203125'].map((t) => [t, num(JSON.parse(t))]);
  const rounds = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.49999999999999994, -0.49999999999999994, 4503599627370495.5, -4503599627370495.5, 4503599627370497, 0.1, -0.1, -0, 0, 1e300, -1e300, 2.4999999999999996, 0.6, -0.6, 3.5000000000000004, Infinity, -Infinity, NaN].map((x) => [num(x), num(Math.round(x))]);
  const maxes = [[0, -0], [-0, 0], [-0, -0], [-1, -0], [NaN, 1], [1, NaN], [-Infinity, -1]].map(([a, b]) => [num(a), num(b), num(Math.max(a, b)), num(Math.min(a, b))]);
  const ratios = [[1, 2, 3], [1, 1, 1], [2, 1], [1, 1, 1, 1], [0.5, 0.25, 0.25], [3, 3, 1]].map((rs) => { const sum = rs.reduce((a, b) => a + b, 0); return [rs, rs.map((r) => Math.round((r / sum) * 10000) / 10000)]; });

  // ---- a JSON value as JS reads it: String(v), the key o[v] makes, !!v ----
  const texts = ['null', 'true', 'false', '0', '-0', '5', '1.5', '1e21', '"x"', '""', '[]', '[1,2]', '[null,1]', '[[1,[2,3]],"a"]', '[{}]', '{}', '{"a":1}', '[true,false]', '[1e21,0.1]', '["a,b"]', '[[]]', '[[null]]', '" "', '"0"'];
  const values = texts.map((t) => { const v = JSON.parse(t); const o = {}; o[v] = 1; return [t, String(v), Object.keys(o)[0], !!v]; });

  // ---- data-set.ts fingerprint (JSON.stringify's escapes, FNV-1a over UTF-16 units); the import's ids ----
  const fpInputs = ['', 'a', 'Personal', 'Work Profile', 'Personal\n', '"q"', 'back\\slash', '\b\f\n\r\t', '\u0000\u0001\u001f\u007f', '\u2028\u2029', '😀', 'é', 'tab\there', 'safari\nPersonal\nt-abc123', '中文', '/<>&\'', '\u0080\u009f\u00a0'];
  const fingerprints = fpInputs.map((s) => [s, JSON.stringify(s), V.fingerprint(s)]);
  const nsInputs = [['safari', 'Personal', 'home'], ['chrome', 'Default', 't-abc'], ['edge', 'Work Profile', 'x'], ['safari', 'p'.repeat(250), 'home'], ['safari', 'Personal', 'i'.repeat(250)], ['safari', 'é😀', 'sp-1']];
  const ids = nsInputs.map(([b, p, id]) => [b, p, id, V.nsId(b, p, id), V.nsTabId(b, p, id)]);
  const idLetters = ['abcd', 'abc', 'ABCdef0123', 'a'.repeat(30), 'a'.repeat(31), 'ab-cd', 'abcé', 'id1x'].map((s) => [s, /^[A-Za-z0-9]{4,30}$/.test(s)]);

  // ---- the address regexes, toLowerCase ----
  const urls = ['https://a.com', 'HTTP://A.COM', 'Https:x', 'file:///a', 'FILE:/a', 'ftp://a', 'data:text/plain,a', 'http:', 'https://', 'https:// a', 'https:///a', 'https://\u00a0a', 'https://\ufeffa', 'https://\u2028a', 'https://a/b', 'httpss://a', ' https://a', 'h\u017ftp://a', 'http\u212a://a', 'margin://settings', 'app://com.apple.Notes', 'https://\u0085a', 'https://\u180ea'];
  const regexes = urls.map((u) => [u, /^(https?|file):/i.test(u), /^https?:/i.test(u), /^https?:\/\/[^\s/]/i.test(u)]);
  const lower = ['LINEAR.APP', '\u212aELVIN.com', '\u0130stanbul.com', 'ΣΑΣ.com', 'STRASSE', '\u1e9e'].map((s) => [s, s.toLowerCase()]);

  // ---- addresses: model.ts normalizeUrl, air-traffic.ts's patterns and matches (run with a URL, the browsers'; in a
  // bare JSContext, which has none, normalizeUrl gives its input back and no pattern matches; normalizePattern reads
  // no URL) ----
  const hasUrl = typeof URL === 'function';
  const addrs = ['https://a.com/', 'https://a.com', 'https://a.com/#x', 'https://A.COM/Path/?q=1#h', 'https://a.com:443/x', 'http://a.com:8080/', 'https://a.com/b/../c', 'https://a.com\\b\\c', 'https://a.com/%7e', 'https://a.com/?', 'http://0x7f.1/', 'https://bücher.de/', 'file:///Users/a/b.html', '  https://a.com/x  ', 'https://[::1]:8000/', 'not a url', ''];
  const normalized = addrs.map((u) => [u, V.normalizeUrl(u)]);
  const patternInputs = ['linear.app', 'LINEAR.APP', '*.figma.com', 'github.com/my-org/*', 'github.com/my-org', 'https://a.com/', 'http://A.com//x//', '*.', 'x', 'a b.com', 'a.com/**', '\ufeffa.com', 'a.com/', 'a.com/*', '-a.com', 'a'.repeat(64) + '.com', 'é.com', 'a.com\u0000'];
  const patterns = patternInputs.map((p) => [p, V.normalizePattern(p)]);
  const matchInputs = [['linear.app', 'https://linear.app/x'], ['*.figma.com', 'https://www.figma.com/'], ['*.figma.com', 'https://figma.com'], ['github.com/my-org/*', 'https://github.com/my-org'], ['github.com/my-org', 'https://github.com/my-org/repo'], ['a.com', 'ftp://a.com'], ['a.com', 'not a url']];
  const matches = matchInputs.map(([p, u]) => [p, u, V.patternMatchesUrl(p, u)]);

  return JSON.stringify({
    about: 'The JavaScript the library\'s rules rely on (docs/CORE-REFACTOR.md step 4, part 1), as JavaScriptCore answers it on this Mac in a bare JSContext (Margin.app\'s library.js), recorded by npm run library:vectors (tests/library-vectors/js-cases.js). Units: UTF-16 code units (a cut can leave half a pair; the core drops it, Tirth\'s answer 3). Numbers JSON can\'t hold: "-0", "NaN", "Infinity", "-Infinity". The groups under url: the browsers\' answers (Node with its URL, Tirth\'s answer 11); under jscUrl, JavaScriptCore\'s (a bare JSContext has no URL: the address as given, no pattern matching).',
    locale,
    cases: { trimmed, regex, trims, squash, lengths, cuts, sortInput, sorted, asciiOrder, asciiSigns, pairs, numberStrings, parsed, rounds, maxes, ratios, values, fingerprints, ids, idLetters, regexes, lower, patterns },
    url: { hasUrl, normalized, matches },
  });
})()

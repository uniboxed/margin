import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('destination sheet preflight drains deferred rule judging before its pass', () => {
  const sheets = source('../extension/content/page/sheets.js');
  const start = sheets.indexOf('function flush()');
  const end = sheets.indexOf('\n  discoverRoots(document);', start);
  const flush = sheets.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(flush, /watch\.takeRecords\(\)/, 'synchronous resize-handler DOM writes are consumed before acknowledgement');
  assert.equal((flush.match(/if \(hasRebuildQueued\) rebuildHas\(\);/g) ?? []).length, 2, 'both direct rule edits and sheets found by the pass rebuild :has() metadata synchronously');
  assert.match(flush, /if \(judging\)[\s\S]*clearTimeout\(judging\);[\s\S]*judge\(\);[\s\S]*if \(passPending\(\)\) pass\(\);/);
  assert.match(sheets, /const passPending = \(\) =>[^\n]+document\.styleSheets\.length !== sheetCount/, 'a clean destination does not rescan its live sheet graph');
  assert.match(sheets, /if \(!box\.on\)[\s\S]*fullScan = true;\s*forcedPass = false;/, 'an off page keeps its deferred full scan without staying force-dirty');
  assert.match(sheets, /box\.onMove\.push\(\(\) => \{ if \(box\.on\) soon\(\); \}\)/, 'a clean box move relies on live variables and onRest media moves instead of forcing a sheet walk');
  assert.match(sheets, /return \{ flush \};/);
});

test('detached shadow templates stay weak until their host is inserted', () => {
  const sheets = source('../extension/content/page/sheets.js');
  const start = sheets.indexOf('function watchRoot(root)');
  const end = sheets.indexOf('\n  const attachedRoots', start);
  const watchRoot = sheets.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(watchRoot.indexOf('if (!rootConnected(root))') < watchRoot.indexOf('knownRoots.add(root)'), 'a never-connected root is not strongly registered or observed');
  assert.match(sheets, /attachedRoots\.set\(this, root\);[\s\S]*watchRoot\(root\)/, 'the weak host mapping lets insertion discover closed roots later');
});

test('destination resize handlers run before the final prepared body measurement', () => {
  const box = source('../extension/content/page/box.js');
  const main = source('../extension/content/page/main.js');
  const start = box.indexOf('function rest(afterResize)');
  const end = box.indexOf('\n  function restSoon', start);
  const rest = box.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(rest.indexOf("dispatchEvent(new Event('resize'))") < rest.indexOf('measureBody(sized)'), 'page resize reactions precede the final read');
  assert.match(rest, /afterResize\?\.\(\)/, 'the sheet graph is drained after synchronous resize reactions');
  assert.match(main, /sheets\.flush\(\);[\s\S]*box\.prepare\(sheets\.flush\)/);
});

test('preflight coalesces a pending resize with the final box rest', () => {
  const box = source('../extension/content/page/box.js');
  const start = box.indexOf('function prepareBox');
  const end = box.indexOf("document.addEventListener('visibilitychange'", start);
  const prepare = box.slice(start, end);
  assert.match(prepare, /if \(restFrom\) resizeFrame = 0;\s*else readResize\(\);/);
  assert.ok(prepare.indexOf('rest(afterResize)') > prepare.indexOf('if (restFrom) resizeFrame = 0'), 'the one final rest owns the body measurement');
});

test('a destination preparation is published only after state and geometry commit', () => {
  const core = source('../extension/content/core.js');
  const start = core.indexOf('Margin.content.prepareForShow = async');
  const end = core.indexOf('\n  // Covered before the background introduces', start);
  const prepare = core.slice(start, end);
  const geometry = prepare.indexOf('geometryReady = link.prepare()');
  const layout = prepare.indexOf('host.getBoundingClientRect()');
  const publish = prepare.indexOf('preparedShow = { token');
  assert.ok(start >= 0 && end > start);
  assert.ok(geometry >= 0 && layout > geometry && publish > layout, 'no visible token exists while asynchronous or geometry work is unfinished');
  assert.equal((prepare.match(/if \(expired\(\)\) return \{ ready: false, reason: 'expired' \};/g) ?? []).length, 2, 'expiry is checked both before work and after the asynchronous fallback');
  assert.equal((prepare.match(/if \(alreadyShown\(\)\) return \{ ready: false, reason: 'already shown' \};/g) ?? []).length, 2, 'a destination made visible before or during async preparation cannot publish a stale token');
  assert.match(prepare, /ownerSeen\(preparedState\.owner, preparedState\.openTabsBy\)/);
  assert.match(prepare, /preparedState\.pageZoom/);
});

test('a prepared destination draws state received in the final hidden instant', () => {
  const core = source('../extension/content/core.js');
  const start = core.indexOf('function shown()');
  const end = core.indexOf('\n  function left()', start);
  const shown = core.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(shown, /if \(fresh\) \{[\s\S]*if \(changedWhileHidden && state\) render\(\);[\s\S]*changedWhileHidden = false;/, 'post-preflight storage changes render synchronously before the prepared page is painted');
});

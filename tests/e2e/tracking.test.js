import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildSafariProfile, gotoLauncher, launch, sidebarSnapshot, waitFor } from './helpers.js';

test('Safari profile: three spaces and explicit tab ownership survive activation, reordering, and a damaged live checkpoint', async () => {
  const server = createServer((req, res) => {
    const title = req.url.slice(1) || 'home';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = buildSafariProfile();
  const ctx = await launch({ extensionPath: dir });
  try {
    const control = await ctx.context.newPage();
    await gotoLauncher(control, ctx);
    const pages = [];
    for (const name of ['personal-page', 'work-page', 'fun-page']) {
      const page = await ctx.context.newPage();
      pages.push(page);
      await page.goto(`${origin}/${name}`);
      await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
    }
    const send = (message) => control.evaluate((value) => chrome.runtime.sendMessage(value), message).then((res) => res.result);
    const work = (await send({ type: 'createSpace', name: 'Work', emoji: '💼' })).spaceId;
    const fun = (await send({ type: 'createSpace', name: 'Fun', emoji: '🎨' })).spaceId;
    const snapshot = () => ctx.worker.evaluate(() => chrome.storage.local.get(null));
    const ids = await waitFor(async () => {
      const { tabs } = await snapshot();
      const byTitle = Object.fromEntries(Object.values(tabs ?? {}).map((tab) => [tab.title, tab.id]));
      return ['personal-page', 'work-page', 'fun-page'].every((name) => byTitle[name]) && byTitle;
    });
    await send({ type: 'moveTabToSpace', tabId: ids['work-page'], spaceId: work });
    await send({ type: 'moveTabToSpace', tabId: ids['fun-page'], spaceId: fun });

    for (const [index, name] of ['personal-page', 'work-page', 'fun-page'].entries()) {
      await ctx.worker.evaluate((id) => chrome.tabs.update(id, { active: true }), ids[name]);
      await pages[index].bringToFront();
      const view = await waitFor(async () => {
        const current = await sidebarSnapshot(pages[index]);
        return current?.chips?.length === 3 && current;
      });
      assert.deepEqual(view.chips.map((chip) => chip.id), ['personal', work, fun]);
    }

    // Moving browser positions emits Safari's moved/attached reconciliation
    // path. Ownership is explicit and must not follow the new index.
    await ctx.worker.evaluate((id) => chrome.tabs.move(id, { index: 0 }), ids['fun-page']);
    await waitFor(async () => {
      const { tabSpace } = await snapshot();
      return tabSpace?.[ids['work-page']] === work && tabSpace?.[ids['fun-page']] === fun;
    });

    const committed = await snapshot();
    assert.equal(committed.workspace.data.spaces.length, 3);
    assert.equal(committed.workspaceBackup.data.spaces.length, 3);
    // Simulate a malformed primary value (the failure mode that previously
    // normalized to one Personal space). Pages must use the structural backup.
    await ctx.worker.evaluate((workspace) => chrome.storage.local.set({ workspace: { ...workspace, data: { spaces: [] } } }), committed.workspace);
    await pages[2].bringToFront();
    const recovered = await waitFor(async () => {
      const current = await sidebarSnapshot(pages[2]);
      return current?.chips?.length === 3 && current;
    });
    assert.deepEqual(recovered.chips.map((chip) => chip.id), ['personal', work, fun]);
  } finally {
    await ctx.context.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

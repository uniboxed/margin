// A space's picture in Edit Theme Color (M2.9 step 7, docs/SPACE-BACKGROUNDS.md Part B §7; ui/picker/picture.ts,
// ui/behaviors/background-picker.ts), in WebKit and Chromium: where the host serves pictures (Margin.app's: here a
// stand-in that answers as it does), Margin's panel has Add Picture…, which asks for Margin.app's file picker; the id
// that comes back saved as any edit is (a fit, ⌘Z back); cancelled, nothing; refused, Margin.app's words; a file dropped
// on the panel sent as its bytes (one that isn't a picture refused before it's sent); an answer that comes after the
// panel closed not saved; Remove Picture. Each built-in theme's own picker has the same items. A host that serves no
// pictures (a browser's extension): no picture's controls. The picture drawn: tests/theme/background-picture.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA, MATERIAL, NEO, PIXEL } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const W = 1280, H = 800;
const script = harnessScript();
const ID = 'c'.repeat(64), ID2 = 'd'.repeat(64);
const THEMED = [['material', MATERIAL, ['Google Sans Flex']], ['neubrutalism', NEO, []], ['pixel', PIXEL, []]] as const;

for (const [engineName, engine] of ENGINES) {
  test(`a space's picture in Edit Theme Color in ${engineName}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: W, height: H } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await context.route('**/*', (route) => route.abort());
      await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
      await page.addScriptTag({ content: script });
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      const ev = <A, R>(fn: (a: A) => R, a?: A) => page.evaluate(fn as any, a) as Promise<Awaited<R>>;
      // The picture the host serves for every id, and a small PNG to drop (its base64: what `backgroundAdd` is sent).
      const dropped = await ev(() => {
        const c = document.createElement('canvas');
        c.width = 8; c.height = 6;
        const g = c.getContext('2d')!;
        g.fillStyle = '#3a7'; g.fillRect(0, 0, 8, 6);
        const url = c.toDataURL('image/png');
        (window as any).__testPicture = url;
        return url.slice(url.indexOf(',') + 1);
      });
      const mount = async (dir: string, id: string, fonts: readonly string[], pictures: boolean) => {
        assert.equal((await page.evaluate(([p, i, f]) => T.loadBuiltin(p, i, [...f]), [themeForPage(dir), id, fonts] as const)).ok, true);
        await ev((x) => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'fullscreen', pictures: x }), pictures);
        await page.waitForFunction(() => T.rtLayouts().length > 0);
      };
      const sent = async (type: string) => (await ev(() => T.rtSent())).filter(([k]) => k === type).map(([, p]) => p);
      const saves = () => sent('renameSpace');
      const parts = () => ev(() => T.rtPicker()) as Promise<any>;
      const isOpen = async () => (await ev(() => T.rtPanel())).open;
      // (A box, or a point already its centre: T.rtBoxText's.)
      type Box = { x: number, y: number, width?: number, height?: number };
      const click = async (b: Box | null | undefined, what = 'it') => {
        assert.ok(b, `${what}: drawn`);
        await page.mouse.click(b!.x + (b!.width ?? 0) / 2, b!.y + (b!.height ?? 0) / 2);
      };
      const reply = (v: unknown) => ev((x) => { (window as any).__pictureReply = x; }, v);
      const open = async () => {
        await ev(() => T.rtDispatch('space.editBackground', 'personal'));
        assert.equal(await isOpen(), true);
      };
      const settle = () => ev(() => T.rtFrames(2));
      /** A file dropped on Margin's panel (dragged in, over it, let go). */
      const drop = (file: { base64?: string, type: string, name: string, text?: string }) => ev((f) => {
        const host = document.querySelector('margin-background-picker')!;
        const bytes = f.base64 ? Uint8Array.from(atob(f.base64), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(f.text ?? '');
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], f.name, { type: f.type }));
        for (const type of ['dragenter', 'dragover', 'drop']) host.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
      }, file);

      await t.test('a host that serves no pictures (a browser\'s extension): no picture\'s controls', async () => {
        await mount(ARCADIA, 'arcadia', [], false);
        await open();
        assert.equal((await parts()).picture, null);
        await page.keyboard.press('Escape');
      });

      await t.test('Add Picture…: Margin.app\'s file picker asked for, the id that comes back saved, shown as its thumbnail', async () => {
        await mount(ARCADIA, 'arcadia', [], true);
        await open();
        let p = await parts();
        assert.ok(p.picture.add, 'Add Picture…');
        assert.deepEqual([p.picture.thumb, p.picture.fits, p.picture.remove], [null, [], null], 'nothing else without one');
        await reply({ id: ID });
        await click(p.picture.add, 'Add Picture…');
        await settle();
        assert.equal((await sent('backgroundChoose')).length, 1);
        const saved = (await saves()).at(-1);
        assert.deepEqual(saved.background.image, { id: ID, fit: 'cover', focus: [0.5, 0.5] }, 'saved: Fill, at its centre');
        p = await parts();
        assert.equal(p.picture.add, null);
        assert.equal(p.picture.thumb.src, await ev(() => (window as any).__testPicture), 'its thumbnail, from where the host serves it');
        assert.deepEqual(p.picture.fits.map((f: any) => [f.fit, f.checked]), [['cover', true], ['contain', false], ['tile', false]]);
        assert.ok(p.picture.remove);
        assert.equal(p.picture.note, '');
        // (Drawn as the state has it: the layer loads it from where the host serves it.)
        await ev((b) => T.rtChange('setBackground', 'personal', b), saved.background);
        await page.waitForFunction(() => (T.rtBackground() as any).pictureState === 'ready');
      });

      await t.test('how it fits: saved; ⌘Z back a step', async () => {
        const n = (await saves()).length;
        await click((await parts()).picture.fits[2], 'Tile');
        assert.equal((await saves()).at(-1).background.image.fit, 'tile');
        await page.keyboard.press('Meta+z');
        assert.equal((await saves()).length, n + 2);
        assert.equal((await saves()).at(-1).background.image.fit, 'cover', 'back to Fill');
        assert.deepEqual((await parts()).picture.fits.map((f: any) => f.checked), [true, false, false]);
      });

      await t.test('the file picker cancelled: nothing saved; refused: Margin.app\'s words, nothing saved', async () => {
        const n = (await saves()).length;
        await reply(null);
        await click((await parts()).picture.thumb, 'Change Picture…');
        await settle();
        assert.equal((await saves()).length, n, 'cancelled');
        assert.equal((await parts()).picture.note, '');
        await reply(undefined);
        await ev(() => { (window as any).__pictureFailure = { type: 'backgroundChoose', error: 'That picture is too large (over 40 MB).' }; });
        await click((await parts()).picture.thumb, 'Change Picture…');
        await settle();
        assert.equal((await saves()).length, n, 'refused');
        assert.equal((await parts()).picture.note, 'That picture is too large (over 40 MB).');
        assert.equal(await isOpen(), true);
      });

      await t.test('a file dropped on it: sent as its bytes, saved; one that isn\'t a picture refused before it\'s sent', async () => {
        const n = (await saves()).length;
        await ev(() => {
          const host = document.querySelector('margin-background-picker')!;
          const dt = new DataTransfer();
          dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
          host.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
        });
        assert.equal((await parts()).picture.dropping, true, 'shown while a file is over it');
        await ev((x) => { (window as any).__pictureReply = (type: string, payload: any) => (type === 'backgroundAdd' && payload.bytes === x ? { id: 'd'.repeat(64) } : undefined); }, dropped);
        await drop({ base64: dropped, type: 'image/png', name: 'photo.png' });
        await page.waitForFunction((k) => T.rtSent().filter(([t]) => t === 'renameSpace').length > k, n);
        assert.equal((await parts()).picture.dropping, false);
        const adds = await sent('backgroundAdd');
        assert.equal(adds.length, 1);
        assert.equal(adds[0].bytes, dropped, 'its bytes, base64');
        assert.deepEqual((await saves()).at(-1).background.image, { id: ID2, fit: 'cover', focus: [0.5, 0.5] }, 'saved, fitting as before');
        assert.equal((await parts()).picture.note, '', 'the last refusal\'s words gone');
        await drop({ text: 'hello', type: 'text/plain', name: 'notes.txt' });
        await settle();
        assert.equal((await sent('backgroundAdd')).length, 1, 'not sent');
        assert.equal((await parts()).picture.note, 'That isn’t a picture.');
      });

      await t.test('an answer that comes after the panel closed (and opened again): not saved', async () => {
        await ev(() => { (window as any).__pictureReply = () => new Promise((done) => { (window as any).__answer = done; }); });
        await click((await parts()).picture.thumb, 'Change Picture…');
        const n = (await saves()).length;
        await click((await parts()).done, 'Done');
        assert.equal(await isOpen(), false);
        // (Opened again before it comes: the answer was the closed one's.)
        await open();
        await ev(() => (window as any).__answer({ id: 'e'.repeat(64) }));
        await settle();
        assert.equal((await saves()).length, n, 'not saved');
        assert.notEqual((await parts()).picture.thumb?.src, undefined, 'the picture the space had still shown');
        await page.keyboard.press('Escape');
      });

      await t.test('Remove Picture: saved without it (none at all, with no colours); Add Picture… again', async () => {
        await open();
        await ev(() => { (window as any).__pictureReply = { id: 'c'.repeat(64) }; });
        let p = await parts();
        if (!p.picture.remove) { await click(p.picture.add, 'Add Picture…'); await settle(); p = await parts(); }
        await click(p.picture.remove, 'Remove Picture');
        assert.equal((await saves()).at(-1).background, null, 'no colours and no picture: none');
        p = await parts();
        assert.ok(p.picture.add, 'Add Picture… again');
        assert.equal(p.picture.thumb, null);
        await page.keyboard.press('Escape');
      });

      await t.test('each built-in theme\'s own picker: Add Picture…, how it fits, Remove Picture; none without pictures', async () => {
        for (const [id, dir, fonts] of THEMED) {
          await mount(dir, id, fonts, false);
          await open();
          assert.equal((await parts()).themed, true, id);
          assert.equal(await ev(() => T.rtBoxText('m-picker button', 'Add Picture…')), null, `${id}: none without pictures`);
          await page.keyboard.press('Escape');
          await mount(dir, id, fonts, true);
          await open();
          await reply({ id: ID });
          await click(await ev(() => T.rtBoxText('m-picker button', 'Add Picture…')), `${id}: Add Picture…`);
          await settle();
          assert.deepEqual((await saves()).at(-1)?.background?.image, { id: ID, fit: 'cover', focus: [0.5, 0.5] }, `${id}: saved`);
          assert.ok(await ev(() => T.rtBoxText('m-picker button', 'Change Picture…')), `${id}: Change Picture… now`);
          await click(await ev(() => T.rtBoxText('m-picker [role="radio"]', 'Tile')), `${id}: Tile`);
          assert.equal((await saves()).at(-1).background.image.fit, 'tile', `${id}: its fit`);
          const remove = await ev(() => { const b = document.querySelector('m-picker button[aria-label="Remove Picture"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
          await click(remove, `${id}: Remove Picture`);
          assert.equal((await saves()).at(-1).background, null, `${id}: removed`);
          // (Refused: its words in the theme's picker.)
          await reply(undefined);
          await ev(() => { (window as any).__pictureFailure = { type: 'backgroundChoose', error: 'Margin couldn’t read that picture.' }; });
          await click(await ev(() => T.rtBoxText('m-picker button', 'Add Picture…')), `${id}: Add Picture…`);
          await settle();
          assert.ok(await ev(() => T.rtBoxText('m-picker [role="status"]', 'Margin couldn’t read that picture.')), `${id}: the refusal's words shown`);
          await page.keyboard.press('Escape');
          assert.equal(await isOpen(), false, `${id}: closed`);
        }
      });

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}

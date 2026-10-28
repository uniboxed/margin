// background/onboarding.js: what the extension tells Margin's Mac app (its
// set-up window), against a fake browser API (Safari's profile).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
let allSites = false;
let appOpen = true;
let failing = false;
globalThis.chrome = {
  runtime: {
    getURL: (path) => `safari-web-extension://test/${path}`,
    getManifest: () => ({}),
    sendNativeMessage: async (app, message) => {
      if (failing) throw new Error('no native app');
      sent.push({ app, ...message });
      return { ok: true, appOpen };
    },
  },
  permissions: { contains: async ({ origins }) => (origins[0] === '<all_urls>' ? allSites : false) },
  storage: { local: { get: async () => ({}), set: async () => {} } },
};

const onboarding = await import('../extension/background/onboarding.js');
const types = () => sent.map((m) => (m.type === 'status' ? `status:${m.allSites}` : m.name));

const tick = () => new Promise((r) => setTimeout(r, 5));

test('onboarding: access is reported when it changes (first at start), events as they happen (once for two reports)', async () => {
  await onboarding.reportAccess();
  await onboarding.reportAccess();
  allSites = true;
  await onboarding.reportAccess();
  assert.deepEqual(types(), ['status:false', 'status:true'], 'only changes');
  assert.ok(sent.every((m) => m.app === 'io.tirth.margin' && m.v === 1 && Number.isFinite(m.at)));
  onboarding.reportEvent('marginNewTabPage');
  onboarding.reportEvent('marginNewTabPage'); // the same tab, from its page too
  onboarding.reportEvent('cmdTKey');
  await tick();
  assert.deepEqual(types().slice(2), ['marginNewTabPage', 'cmdTKey']);
});

test('onboarding: the app closed (or none: a temporary extension) → access is tried again later, and at once when an event finds it open', async () => {
  sent.length = 0;
  appOpen = false;
  allSites = false;
  await onboarding.reportAccess();
  await onboarding.reportAccess();
  assert.deepEqual(types(), ['status:false'], 'not heard: waits before trying again');
  onboarding.reportEvent('safariNewTab');
  await tick();
  assert.deepEqual(types(), ['status:false', 'safariNewTab'], 'events still go: the app may have opened since');
  appOpen = true;
  onboarding.reportEvent('marginNewWindowPage');
  await tick();
  await tick();
  assert.deepEqual(types(), ['status:false', 'safariNewTab', 'marginNewWindowPage', 'status:false'], 'the app is open now: access again');
  await onboarding.reportAccess();
  assert.equal(sent.length, 4, 'heard: no more until it changes');
  appOpen = false;
  allSites = true;
  await onboarding.reportAccess();
  appOpen = true;
  allSites = false;
  await onboarding.reportAccess();
  assert.deepEqual(types().slice(4), ['status:true', 'status:false'], 'not heard, but changed since: sent at once');
  failing = true;
  allSites = true;
  await onboarding.reportAccess(); // no app at all: fails quietly
  failing = false;
});

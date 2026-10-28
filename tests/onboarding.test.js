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

test('onboarding: access is reported when it changes (first at start), events while the app is open', async () => {
  await onboarding.reportAccess();
  await onboarding.reportAccess();
  allSites = true;
  await onboarding.reportAccess();
  assert.deepEqual(types(), ['status:false', 'status:true'], 'only changes');
  assert.ok(sent.every((m) => m.app === 'io.tirth.margin' && m.v === 1 && Number.isFinite(m.at)));
  onboarding.reportEvent('cmdTKey');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(types().at(-1), 'cmdTKey');
});

test('onboarding: the app closed (or none: a temporary extension) → events wait a while; access changes still go', async () => {
  sent.length = 0;
  appOpen = false;
  onboarding.reportEvent('safariNewTab');
  await new Promise((r) => setTimeout(r, 5));
  onboarding.reportEvent('cmdTKey');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(types(), ['safariNewTab'], 'the reply said the app is closed: the next event waits');
  allSites = false;
  await onboarding.reportAccess();
  assert.equal(types().at(-1), 'status:false');
  failing = true;
  allSites = true;
  await onboarding.reportAccess(); // no app at all: fails quietly
  failing = false;
});

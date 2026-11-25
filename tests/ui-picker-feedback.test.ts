// Edit Theme Color's ticks (M2.9 step 6, docs/SPACE-BACKGROUNDS.md Part B §6; ui/picker/feedback.ts): what each tick
// plays for each setting and device (the table), the device as Margin.app says it, at most one every 20 ms, the click
// made by WebAudio only where one plays (its audio started only by the person's gesture), the haptic's pattern. In the
// browsers, the picker's ticks: tests/theme/picker-feedback.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEEDBACK_SETTINGS, TICK_GAP_MS, createTickFeedback, deviceOf, feedbackSetting, tickPlays } from '../app/shared/ui/picker/feedback.ts';
import type { FeedbackDevice, FeedbackSetting } from '../app/shared/ui/picker/feedback.ts';
import type { TickKind } from '../app/shared/ui/picker/words.ts';

const TICKS: TickKind[] = ['detent', 'step', 'texture', 'appearance'];
const dev = (pointer: FeedbackDevice['pointer'], haptics = true, uiSounds = true): FeedbackDevice => ({ pointer, haptics, uiSounds });
const say = (p: ReturnType<typeof tickPlays>) => (p ? (p.kind === 'haptic' ? `haptic:${p.pattern}` : `sound${p.low ? ':low' : ''}`) : 'nothing');

test('ticks: the table: setting × device × the Mac\'s haptics and interface sounds', () => {
  const rows: [FeedbackSetting, FeedbackDevice | null, string, string][] = [
    // [setting, device, a detent plays, a texture plays]
    ['auto', dev('trackpad'), 'haptic:alignment', 'haptic:level'],
    ['auto', dev('mouse'), 'sound', 'sound:low'],
    ['auto', dev(null), 'sound', 'sound:low'], // (not told yet: a mouse unless proven a trackpad)
    ['auto', dev('trackpad', false), 'sound', 'sound:low'], // (no trackpad that plays haptics: a click)
    ['auto', dev('mouse', true, false), 'nothing', 'nothing'], // (interface sounds off)
    ['auto', dev('trackpad', true, false), 'haptic:alignment', 'haptic:level'],
    ['auto', null, 'sound', 'sound:low'], // (a host that knows no device: a browser's extension, Windows)
    ['haptics', dev('mouse'), 'haptic:alignment', 'haptic:level'], // (the setting's point: auto got it wrong)
    ['haptics', dev('trackpad', false), 'nothing', 'nothing'],
    ['haptics', null, 'nothing', 'nothing'],
    ['sound', dev('trackpad'), 'sound', 'sound:low'],
    ['sound', dev('trackpad', true, false), 'nothing', 'nothing'],
    ['sound', null, 'sound', 'sound:low'],
    ['off', dev('trackpad'), 'nothing', 'nothing'],
    ['off', null, 'nothing', 'nothing'],
  ];
  for (const [setting, device, detent, texture] of rows) {
    const what = `${setting} ${JSON.stringify(device)}`;
    assert.equal(say(tickPlays('detent', setting, device)), detent, what);
    assert.equal(say(tickPlays('texture', setting, device)), texture, what);
    for (const tick of ['step', 'appearance'] as TickKind[]) assert.equal(say(tickPlays(tick, setting, device)), detent, `${what} ${tick}: as a detent`);
  }
});

test('ticks: the setting and the device as stored and said, read', () => {
  assert.deepEqual(FEEDBACK_SETTINGS, ['auto', 'haptics', 'sound', 'off']);
  for (const v of FEEDBACK_SETTINGS) assert.equal(feedbackSetting(v), v);
  for (const v of [undefined, null, '', 'AUTO', 'loud', 1, {}]) assert.equal(feedbackSetting(v), 'auto', String(v));
  assert.deepEqual(deviceOf({ type: 'pointerKind', kind: 'trackpad', haptics: true, uiSounds: true }), dev('trackpad'));
  assert.deepEqual(deviceOf({ kind: 'mouse', haptics: false, uiSounds: false }), dev('mouse', false, false));
  assert.deepEqual(deviceOf({ kind: 'pen', haptics: 1, uiSounds: 0 }), dev(null, false, true), 'only what\'s exactly said');
  assert.equal(deviceOf(null), null);
  assert.equal(deviceOf('trackpad'), null);
});

/** A window with a stand-in WebAudio: what it made, started and closed. */
function fakeWin() {
  const made: string[] = [];
  class Param { setValueAtTime() { return this; } exponentialRampToValueAtTime() { return this; } }
  class Ctx {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    constructor() { made.push('context'); }
    resume() { made.push('resume'); this.state = 'running'; return Promise.resolve(); }
    close() { made.push('close'); return Promise.resolve(); }
    createOscillator() { return { type: '', frequency: new Param(), connect: (n: any) => n, start: () => made.push('start'), stop: () => {} }; }
    createGain() { return { gain: new Param(), connect: (n: any) => n }; }
  }
  return { win: { AudioContext: Ctx, performance: { now: () => 0 } } as unknown as Window, made };
}

test('ticks: at most one every 20 ms; a haptic is Margin.app\'s, a click WebAudio\'s, made only where one plays', () => {
  let t = 1000;
  let setting: FeedbackSetting = 'auto';
  let device: FeedbackDevice | null = dev('trackpad');
  const haptics: string[] = [];
  const { win, made } = fakeWin();
  const f = createTickFeedback({ win, setting: () => setting, device: () => device, haptic: (p) => haptics.push(p), now: () => t });
  f.prime();
  assert.deepEqual(made, [], 'a trackpad: no audio made');
  assert.deepEqual(f.tick('detent'), { kind: 'haptic', pattern: 'alignment' });
  t += TICK_GAP_MS - 1;
  assert.equal(f.tick('detent'), null, 'too soon');
  t += 1;
  assert.deepEqual(f.tick('texture'), { kind: 'haptic', pattern: 'level' });
  assert.deepEqual(haptics, ['alignment', 'level']);
  assert.deepEqual(made, [], 'still none');
  device = dev('mouse');
  t += 100;
  f.prime();
  assert.deepEqual(made, ['context', 'resume'], 'a mouse: made ready at the person\'s gesture');
  assert.deepEqual(f.tick('detent'), { kind: 'sound', low: false });
  assert.deepEqual(made, ['context', 'resume', 'start'], 'one context, a click started');
  t += 5;
  assert.equal(f.tick('step'), null, 'too soon, whatever it is');
  assert.deepEqual(f.played, { haptic: 2, sound: 1 });
  setting = 'off';
  t += 100;
  assert.equal(f.tick('detent'), null);
  f.prime();
  assert.equal(made.filter((m) => m === 'context').length, 1);
  f.destroy();
  assert.equal(made.at(-1), 'close');
  // No WebAudio (an old engine): nothing thrown, the tick still said.
  const none = createTickFeedback({ win: { performance: { now: () => 0 } } as unknown as Window, setting: () => 'sound', device: () => null, haptic: () => {}, now: () => 0 });
  none.prime();
  assert.deepEqual(none.tick('detent'), { kind: 'sound', low: false });
});

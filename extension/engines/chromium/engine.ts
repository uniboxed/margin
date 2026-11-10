// Chromium's own modules, as shared code reaches them (`#engine`: scripts/build.ts; unbuilt,
// extension/shared/any-engine.ts). What another engine has is null here, so its code isn't in this build.
import * as fullscreen from './fullscreen.ts';

export const engine = { onboarding: null, newTabHint: null, fullscreen };

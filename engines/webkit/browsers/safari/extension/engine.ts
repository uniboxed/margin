// Safari's own modules, as shared code reaches them (`#engine`: scripts/build.ts; unbuilt,
// extension/shared/any-engine.ts). What another engine has is null here, so its code isn't in this build.
import * as onboarding from './onboarding.ts';
import * as newTabHint from './newtab-hint.ts';

export const engine = { onboarding, newTabHint, fullscreen: null };

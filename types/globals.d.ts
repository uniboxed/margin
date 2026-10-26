// Ambient declarations for `npm run typecheck` (tsc --checkJs; nothing here
// is built or shipped).

// WebKit's trackpad pinch events (Safari only; shared/gestures.js).
interface GestureEvent extends UIEvent {
  readonly scale: number;
  readonly rotation: number;
}
interface WindowEventMap {
  gesturestart: GestureEvent;
  gesturechange: GestureEvent;
  gestureend: GestureEvent;
}

// Navigation API's `navigate` event fields WebKit has that lib.dom lacks.
interface NavigateEvent {
  readonly sourceElement?: Element | null;
}

// The extension APIs: `browser` in Safari, `chrome` in Chrome. Untyped.
declare var browser: any;
declare var chrome: any;

// Shared between scripts injected separately into one page (content
// scripts, the fitted layout); see DECISIONS.md "One bundled script per
// context". Loosely typed on purpose: each script adds its own parts.
declare var Margin: {
  platform?: import('../extension/shared/platform.js').Platform;
  content?: any;
  shell?: any;
  theme?: any; // the active theme's content part (themes/register.js)
  [key: string]: any;
};

// Expandos Margin sets in its own (isolated) world.
interface HTMLIFrameElement {
  __marginShellFrame?: boolean; // content/shell.js: the card
}
interface Function {
  __margin?: boolean; // content/shell-main.js: History methods already wrapped
}

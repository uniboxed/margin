// Edit Theme Color's words (Margin's, as Arc names the panel) and what its controls say happens: one list for the
// default panel, a theme's part (ui/picker/view.ts) and the controls (ui/picker/controls.ts). Pure.
import type { PickerState } from './model.ts';

export type TickKind = 'detent' | 'step' | 'texture' | 'appearance';
export type PanelEvents = {
  preview: (s: PickerState) => void,
  commit: (s: PickerState) => void,
  undo: () => void,
  escape: () => void,
  done: () => void,
  all: (s: PickerState) => void,
  tick?: (kind: TickKind) => void,
};

/** Its words (Margin's, as Arc names the panel). */
export const WORDS = Object.freeze({
  title: 'Edit Theme Color',
  auto: 'Automatic appearance', light: 'Light appearance', dark: 'Dark appearance',
  appearanceNote: 'Margin’s window only: pages keep their own',
  field: 'Color', key: 'Hue and lightness', empty: 'Click to pick a color',
  add: 'Add a color', remove: 'Remove a color',
  complementary: 'Complementary', analogous: 'Analogous', wheel: 'How the other colors follow the first',
  presets: 'Presets', prev: 'Previous presets', next: 'Next presets', preset: 'Set space color to',
  intensity: 'Intensity', texture: 'Texture', amount: 'Texture amount', textureHint: 'Click for the next texture; turn, drag or scroll for its amount',
  all: 'Use for All Spaces', allDone: 'Used for all spaces', done: 'Done',
});

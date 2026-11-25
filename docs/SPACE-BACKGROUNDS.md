# A space's background: Arc's picker in Margin (M2.9, study and plan, 2026-11-24)

Branch `feat/space-backgrounds`, from `refactor/hosted-only` at `71e11707`. Commit scope: `m2.9`, the next of Track 2's Arc features (M2.1–M2.8).

What Tirth asked for (2026-11-24):

- Every theme keeps its own background as its default.
- Arc's "Edit Theme Color" panel sets a background over **any** theme.
- The dial holds more textures than Arc's, such as Neubrutalism's dots.
- It should look and work like Arc's, not like Zen's copy of it.
- Pictures as backgrounds as well.

The prototype was approved (glass panel included): <https://claude.ai/artifact/7yzYiJesbzwzLcwVipM6uy>.

Nothing is built yet. Part A is the study; Part B is the plan.

---

# Part A: the study

## Sources

- **Arc 1.174.2, installed on Tirth's Mac**, read locally:
  - `~/Library/Application Support/Arc/StorableSidebar.json`: six real `windowTheme`s, the exact saved format.
  - `Arc.app/Contents/MacOS/Arc`: Swift type metadata and strings. These give the model's types, enum cases and coding keys, the editor's state and actions, and its tooltips.
  - Asset catalog names (`xcrun assetutil --info`) of `ARC_SpaceStyleEditor.bundle` and `ARC_WindowThemeUI.bundle`, plus the shader names in `default.metallib`.
  - Nothing was disassembled, and the Metal shaders' maths wasn't read. **No Arc asset (textures, Lottie files, images, preset values) goes into Margin.**
- Four open-source Arc importers: Crest `ArcSidebar.cs`, Wren `arc.rs`, VictorKildahl/cra#30 and denchiklut/oa#103.
- Zen's rebuild (zen-browser/desktop at d265627, MPL-2.0): `src/zen/spaces/ZenGradientGenerator.mjs`. Read only, no code taken.
- AppKit headers in the installed macOS SDK: `NSHapticFeedback.h`, `NSEvent.h`, `NSTouch.h`, `NSGlassEffectView.h`.

## Arc's model (from the binary's types, confirmed by the saved file)

```text
WindowTheme
  background: Background            .single(Style)
  windowAppearance?
  primaryColorPalette               { tintedLight, midTone, shaded, shadedDark }
  semanticColorPalette              .appearanceBased { light: P, dark: P } or .single
    P = { foregroundPrimary, foregroundSecondary, foregroundTertiary, background, backgroundExtra,
          focus, hover, cutoutColor, title, subtitle, minContrastColor, maxContrastColor }

Style
  contentOverBackgroundAppearance   Appearance: light | dark | auto (absent)
  isVibrant: Bool                   translucency
  color: ColorType
    .basicColor(...)                older, plain
    .blendedSingleColor             { color, translucencyStyle, modifiers }
    .blendedGradient                { baseColors[], overlayColors[], translucencyStyle, modifiers, wheel }

BlendedBackgroundModifiers { noiseFactor, intensityFactor, overlay }
Overlay       grain | sand | denim | tweed
Wheel         .complimentary(...) | .analogous(...)     (Arc's spelling)
```

Colours are `{red, green, blue, alpha, colorSpace: "extendedSRGB"}` floats. Extended sRGB means values can fall below 0 or rise above 1 (seen: blue −0.24).

Tirth's spaces hold three looks, each saved twice:

| stored `color` (pad) | midTone (derived) | shadedDark | intensity | noise | overlay | look |
|---|---|---|---|---|---|---|
| `#fff9e5` | `#eab200` | `#705500` | 0.373 | 0.45 | grain | light, vibrant |
| `#dcf3fc` | `#54c8f1` | `#006087` | 0.460 | 0.55 | grain | light, vibrant |
| `#f29bbb` | `#f29bbb` | `#ad1856` | 0.877 | 1.00 | grain | light, vibrant |

- The stored colour is the pad's colour. Arc then derives tones from it, and a **semantic palette for both light and dark**: text, hover, focus, background, title and contrast colours. That's how one colour themes every surface of Arc.
- Noise moves in steps of 0.05. Intensity is continuous.

## The panel, control by control

| Control | Arc's view / action (from the binary) | What it does |
|---|---|---|
| ✨ ☀ ☾ | `LightDarkToggleView`, `LoopingToggleView` (Lottie), `didSetAutomatic/Light/DarkAppearance` | The space's appearance, with animated icons |
| Dotted field + knobs | `SpaceStyleColorPadView`, `PadWheel`, `Knob {color, position, isSelected}`, pad state `{keyColor, numberOfComplimentaryColors, wheel, knobs, saturation, lightnessRange}`, image `DotGrid` | A hidden wheel: angle → hue, distance → lightness. The extra knobs follow the key colour by the wheel rule. |
| − / + | `EditColorButtonsView`, `didAddColor`, `didRemoveColor`, `didDeleteAllColors` | Adds or removes a following colour. With none left: "Tap to pick a color for this space" |
| Swatches ‹ › | `SpaceStyleEditorColorSet`, `currentPresetPage`, "Set space color to …" | Pages of nine presets |
| Wavy slider | `SineSlider`, `SineWave {maxAmplitude, …}`, label "Intensity" | Intensity; the wave grows with the value |
| Dial | `SpaceStyleDialView`, `NoiseFactorGesture {rotation, dialClick, scrollWheel, drag}`, `didTapNoiseKnob`, tooltip "Cycle noise texture", knob faces Grain/Sand/Denim/Tweed | Turn, scroll or drag sets the amount; click cycles the texture |
| (keys) | `undoStack`, `registerUndo`, `didKeyDownEscape` | One undo step per gesture, Escape |
| (menu) | "Edit Theme Color" in `SpaceMenu.swift` | Where the panel opens from |

Arc's harmonies are only complementary and analogous. Arc draws the background in Metal, in three passes:

1. The colours over an underlay colour at the intensity's alpha.
2. The texture, tiled, blended between spaces while switching.
3. Output around a cut-out where the page sits.

---

# Part B: the plan

## Decisions (Tirth, 2026-11-24)

1. **Per space, with "Use for all spaces".**
2. **Light / dark / auto per space**, like Arc. It sets Margin's UI and the derived palette. Safari's pages follow Safari, and the tooltip says so.
3. **Translucency** of the window stays with the Liquid Glass theme only, for now.
4. **Dial textures**: grain, sand, denim and tweed (Margin's own versions), plus dots and grid.
5. **Arc import** carries each space's `windowTheme` into `background`. (No Arc importer exists yet; see step 8.)
6. **Pictures**: yes.
7. **The UI**: Margin's HTML controls, on real system glass.
8. **Margin's default picker is glass.** Every theme without a picker of its own gets it, Arcadia among them: no picker code goes in Arcadia, so it looks like Arc's. This is an exception to "no blur anywhere" (DECISIONS.md:5138) and to "system glass only in Liquid Glass" (DECISIONS.md:5204): it is Margin's own chrome, not a theme's surface. Where the system has no glass (Windows for now, the extension), it is drawn opaque. It's recorded in DECISIONS.md with step 5.
10. **A theme may draw its own picker** (Tirth, 2026-11-24, after the per-theme prototype): a `background-picker` part, as for the menu, the editor and the preview card. The theme lays out and styles Margin's picker elements in HTML and CSS (no JavaScript, as everywhere in a theme); Margin's code works them. A theme with no part (or no slot for it) gets Margin's default panel; an element a theme leaves out isn't shown (its choice: Escape and a press outside still close it); an unknown variant is the default variant. Material, Neubrutalism and Pixel ship their own; Liquid Glass and Arcadia use the default. See step 5b.
9. **Feedback on detents**:
   - Mac with a finger on a trackpad: haptics.
   - Mac with a mouse, and Windows: a short sound.
   - It's a setting, so it can be changed.

## What the code says (mapped 2026-11-24; line numbers at `71e11707`)

- **A space's fields:**
  - Core: `Space` (`core/src/library/state.rs:254`); read and cut in `state_of` (`:617`); `update_space` (`model/spaces.rs:95`).
  - `theme` has a three-way rule (valid sets it, `null` clears it, anything else leaves it). It's written only when set: `values.rs:139`, `snapshot.rs:292`.
  - TS twin: `extension/state/model.ts:1135`, `app/shared/library/library.ts:95,146,312`.
  - Data set: `extension/shared/data-set.ts:50,221`.
- **Actions:**
  - `ACTION_NAMES` is a fixed `[&str; 57]` (`actions.rs:38`), and `actions_tests.rs:88` requires vectors for every action.
  - `renameSpace` (`actions.rs:628`) already carries `color` and `theme`, so `background` rides on it. No new action.
- **Vectors:**
  - `tests/fixtures/library/`, re-recorded with `npm run library:vectors`, in the same commit as both copies' change (`docs/CORE-REFACTOR.md:1636`).
  - A field that's absent when unset leaves the existing vectors valid.
- **How themes paint their ground:**
  - All five paint it as a `box-shadow` spread on `.page`, which can't carry a gradient, texture or picture.
  - Margin reads that ground back from computed styles for the page corners (`host-app.ts:241` `cornerFill`, Rust `page/fill.rs:56`). It reads sRGB only.
  - Arcadia and Material switch light/dark with `@media (prefers-color-scheme)`. Liquid Glass uses `light-dark()`. Neubrutalism is fixed light and Pixel fixed dark.
- **Runtime variables:**
  - Theme settings become `--m-*` in Margin's own constructed sheet (`theme-loader.ts:189`, adopted at `runtime.ts:274`).
  - `checkCssValue` (`sanitize.ts:1295`) refuses `url()` and gradients, so the background's variables need their own sheet, built only from validated values.
- **Glass today:**
  - There is no `NSGlassEffectView` or `NSVisualEffectView` in the app. Liquid Glass's glass is WebKit's `-apple-visual-effect: -apple-system-glass-material`, turned on per web view by the private `_setUseSystemAppearance:` (`OverlayWebView.swift:304`).
  - With that on, `color-scheme: light` isn't honoured in Dark Mode (themes README `:571`).
  - Margin's command bar, menus and palette are drawn inside the one web view, not in separate panels.
- **Bridge:**
  - JS uses `webkit.messageHandlers.margin` (`overlay-bridge.ts:17`); `perform(name, arg)` is in `host-app.ts:561`.
  - Routing happens in the core (`page/said.rs`), then to Swift `said()` (`MarginWindowController.swift:1682`).
  - **A haptic path exists**: `haptic.alignment` → `Said::Haptic` → `alignmentTick()` (`MarginWindowController.swift:1663`).
  - The only trackpad test today is `hasPreciseScrollingDeltas` (`:1898`).
- **Serving files:**
  - On Mac, `OverlaySchemeHandler` (`OverlayWebView.swift:83`) serves `margin-app://app/…`. Its CSP (`:89`) allows `img-src 'self' data: blob:`.
  - The same CSP is copied in `windows/src/serve.rs:21`, `tests/e2e/harness/margin.ts:48` and `tests/theme/security.test.ts:55`.
  - A picture served from `margin-app://app/background/<id>` (and `https://margin.invalid/background/<id>` on Windows) is `'self'`, so **no CSP change**.
- **Haptics, per the SDK header:**
  - `NSHapticFeedbackManager.defaultPerformer` is "the most appropriate feedback performer for the current input device", and "Force Touch trackpads will not perform the feedback if the user isn't currently touching the trackpad".
  - So a haptic sent while a mouse is in use does nothing. Margin has to know which device is in use to play a sound instead.
- **Arc import:** there's no Arc importer (`StorableSidebar` and `windowTheme` match nothing). Margin.app has no sandbox entitlements.

## The design

### 1. The value: `background` on a space

```text
background?: {
  colors:     ["#rrggbb", …]   0–3, lowercase hex; the first is the key colour
  wheel:      "complementary" | "analogous"
  intensity:  0–1, to 2 decimals
  texture:    "grain" | "sand" | "denim" | "tweed" | "dots" | "grid"
  amount:     0–1, in steps of 0.05 (0: no texture)
  appearance: "auto" | "light" | "dark"
  image?:     { id: 64 lowercase hex (SHA-256), fit: "cover" | "contain" | "tile", focus: [0–1, 0–1] }
}
```

- **Absent means "the theme's own background"**, exactly as `theme` works. It's written only when set, so existing data and vectors don't change.
- **How it's read** (core `state_of`, `update_space` and TS twins, one rule):
  - Unknown keys are dropped.
  - Wrong types fall back to each field's default (`analogous`, 0.5, `grain`, 0, `auto`).
  - Numbers are clamped (and `amount` snapped to 0.05). Colours that aren't `#rrggbb` are dropped, and anything after the third is dropped.
  - An `image` with a malformed id is dropped.
  - **With no colours and no image, the whole value is absent.**
- **Update** uses `theme`'s three-way rule on `renameSpace`'s `background`: an object sets it (after the reading rule), `null` clears it, and anything else leaves it.
- **`color` stays.** The picker's save sends `color: colors[0]` with the background in the same request, so older builds, the extension's copies and anything that reads `color` keep working. The core doesn't couple the two.
- **New spaces** start without a background. `createSpace` doesn't copy it from the current space; it does copy `theme`.
- The extension's data set carries the field through `data-set.ts` unchanged. The extension doesn't draw it.
- The colours are stored as picked. The followers' angles are Margin's: 180°, 120°/240°, ±38°. A background from Arc import may not match them, so the picker shows stored colours as they are until a knob is dragged.

### 2. Drawing: Margin's layer, under any theme (built: step 2)

Margin draws the background itself, as one layer, so every theme gets the same result and only has to make room for
it. The code: `app/shared/ui/background.ts` (the layer), `background-look.ts` (what it's drawn from: pure),
`color.ts` (OKLCH, WCAG contrast), `textures.ts` (the tiles); the runtime follows the shown space after each render.

- **`<margin-background>`** (not "backdrop": Margin.app already has a `MarginBackdrop` window), in the theme's
  container (before `<body>` in a document, first in a shadow root), fixed over the whole window at z-index
  −2147483647, never taking the pointer:
  - its content in a closed shadow root and its host's style pinned (`all: initial !important`), as
    `theme-preview.ts`'s bar: the overlay's theme sheet reaches every element of the document, never this. Whether it
    shows and its cut are a rule inside the shadow root, after the pin: a shadow tree's `!important` beats the host's
    own style attribute (found the first time: the attribute's `display` and `clip-path` were overridden);
  - layers, bottom to top: the underlay (near-white or near-black, a touch of the key colour's hue), the colours at
    `0.14 + 0.86 × intensity`, the texture at the amount;
  - cut out of the page card's outer box (`<m-page>`'s border box and its four corner radii: `View.measurePageOuter`,
    not part of the layout Margin.app is told) with `clip-path: path(evenodd, …)`, placed again at every layout.
- **The colours' layout** has one description (`layersOf`) for both the CSS and the colour at any point (`groundAt`):
  one colour flat; two a 135° gradient; three a 160° gradient with a soft radial wash of each at three corners.
- **What the runtime sets** while the space shown has a background (none otherwise, so a theme's `var(--m-…, own)`
  falls back):

  | Where | What |
  |---|---|
  | the theme's root | `m-background`; `m-appearance="light|dark"` |
  | the container (`:host`, `:root`), Margin's own constructed sheet after the theme's settings | `--m-bg` (the background as one colour: its average), `--m-fg` (text: 4.5:1 against every part, 7:1 where it can), `--m-fg-2` (4.5:1), `--m-accent` (3:1), `--m-hover`, `--m-selected` (translucent fills); 7:1 for both texts under Increase contrast, the colours' opacity lowered where no text gets there |

  `--space-color` is as today. Every value is a plain colour, checked again with `checkCssValue`.
- **Corner fill:** `cornerFill` takes an optional `ground` (the runtime's `backgroundAt`): outside the card, a sharp
  shadow the theme still paints wins (Neubrutalism's ink), then Margin's colour at that point (`rgb(…)`, what
  `fill.rs` reads), then an ancestor's background. The runtime tells the host each time the drawn ground changes
  (`onGround`), and the overlay measures again.
- **The theme contract** (themes README, "A space's background"): under `[m-background]` a theme stops painting its
  ground where the background should show, gives what lies on it Margin's text colours or translucent fills, and
  draws anything solid standing for the ground in `--m-bg`. Text colours go on the surfaces that lie on the background
  (the docked sidebar), not the root: menus and panels are drawn in the system's appearance, which can differ from
  the background's until step 3. Each built-in theme:
  - Arcadia, Material: the frame's spread and the docked sidebar clear; in the sidebar Margin's text and translucent
    fills (Material's tonal surfaces named one by one: a role mixed from another at the root comes resolved); the
    sidebar out over the page a card of `--m-bg`; Material's active indicator keeps its tonal container.
  - Liquid Glass: the ground is `--m-bg`, the lights go (the glass bends the background), and `color-scheme` follows
    `m-appearance`: its colours are all `light-dark()`, so the whole theme, panels included, follows the background.
  - Neubrutalism: the card keeps its ink shadow, its dots give way (Dots is a texture), the space's name takes
    `--m-fg`; cards stay paper and ink.
  - Pixel: the ground is `--m-bg`, the dots give way, the card keeps its pixel border; the sidebar stays its dark panel.
- **A theme without the contract** keeps its own look: its ground covers the layer, all but the smoothing of the
  page card's rounded corners (a pixel's worth of edge mixes in a little of the background). A larger cut would hide
  that but leave a seam of the page round the card in every theme that takes part, so the cut is exact.
- **Textures:** grain, sand, denim and tweed are Margin's own tiles, drawn on a canvas from a fixed seed (the same
  pixels every load), as `data:` PNGs; dots and grid are CSS gradients in `--m-fg`.
- **Switching spaces** between two with backgrounds cross-fades (0.3 s); at once with reduced motion. To or from none
  it's at once: the theme's own ground is above the layer, nothing to fade under. Two themes: the theme swap's own
  transition (`overlay.ts` swapTheme).
- **A picture alone** draws the underlay and the texture until step 7 serves the picture.

### 3. Appearance per space (built: step 3)

- The effective appearance is the space's own value, or the system's under `auto` (and with no background).
- **Mac (Margin.app's window):** the core's `Library::space_appearance(window)` (the space found as its theme is:
  the window's, else the first), the FFI's `margin_library_space_appearance` (0 the system's, 1 light, 2 dark),
  `Library.spaceAppearance`, the window source's `spaceAppearance(window:)`; `MarginWindowController.followAppearance`
  sets the web view's `appearance` (`.aqua`, `.darkAqua`, or nil: the window's) in `pageHello`, before the page draws,
  and in `stateChanged`, before the state that shows the space is pushed (both reach the page in order). WebKit takes a
  web view's appearance as the page's `prefers-color-scheme` and `light-dark()`, with the private system appearance
  off and on (Liquid Glass): checked on this Mac first (`space-appearance-tests.swift`). So every theme draws in it,
  its menus and panels too, with no CSS of its own for it. Only Margin's page: the hosted windows, Safari's pages among
  them, keep theirs.
- **Windows:** not yet: Margin's Windows app has no per-space theme or library window yet; its appearance (WebView2's
  `PreferredColorScheme`) comes with those. The extension's overlay over a browser's page stays the system's too.
- Neubrutalism (fixed light) and Pixel (fixed dark) keep their look. Only the background layer and its palette follow.
- Safari's pages aren't affected, and the tooltip says so.

### 4. The picker: Margin's own component (built: step 4)

- A Margin-owned panel (`ui/picker/panel.ts`: a top-layer popover in a closed shadow root, its own style pinned, its words in the component, not the theme's), so it looks the same in every theme. Its model is pure (`ui/picker/model.ts`: each edit a step from one picker state to the next), and the behaviour that saves it (`ui/behaviors/background-picker.ts`) runs without a host, so all three are tested in Node, Chromium and WebKit.
- **Controls, as in the prototype:**
  - appearance buttons (automatic, light, dark);
  - the field, a hidden wheel (the angle the hue, the distance from the centre the lightness, in OKLCH), with up to three knobs; the others follow the key by the rule (complementary 180°, or 120° and 240°; analogous 38°, or 38° each way: Margin's angles);
  - −/+ and the wheel pill;
  - preset pages (five pages of nine, today's 8 `SPACE_COLORS` on page one; a preset is its exact colour);
  - the wavy slider (the intensity);
  - the dial (turn the ring, drag the centre, scroll; a click or a sideways swipe the next texture; at 0 a texture starts at 25%);
  - Use for All Spaces, Done.
  - The picture button and drop come with step 7.
- **Live:** while a gesture runs, the background layer is redrawn once a frame (`rt.previewBackground`, held). Nothing is saved until the gesture ends.
- **Saving:**
  - Each gesture's end (a click, a drag let go, a burst of scrolling or keys at rest, 350 ms) saves once: `space.setBackground {space, background, color}` (Margin's own action, behaviour-only), sent as `renameSpace {spaceId, background, color}`, the key colour the space's colour. It's drawn ahead until the state has it. (The plan said one save on close. Saving per gesture lets the window's appearance, which follows the state (step 3), change at the click, and loses nothing when the window goes. `space.update` wasn't used because it is the editor's whole save, with a name and an emoji.)
  - ⌘Z goes back a saved step, saving it again. Escape restores the value from when the panel opened, then closes it.
  - Done, a press outside, another space shown, or the space gone: closed, what's saved kept.
  - "Use for all spaces" saves the same value to every space of the profile, one request each.
- **Where it opens:** "Edit Theme Color…" in the space's menu (`menu-items.ts`, after Rename Space), where the menu was. `space.editBackground` is a theme's to name too (a theme's button: the picker opens beside it). The space editor has no button yet: its save sends the colour it shows and would overwrite the key colour the picker saved, so it waits until the editor shows the background's.
- **While it's open**, Margin.app gives the page the keys and is told the panel takes the pointer (`overlay.ts`: `panelOpen`, `panelRect`), as for Margin's menus.
- **Its glass:** see step 5. **Its ticks:** an `onTick` hook, step 6.

### 5. The panel's glass: two candidates, settled by a spike (built: step 5)

Neither has been tried. Each has a known cost.

- **A: inside Margin's web view.** The panel is drawn like the command bar, with WebKit's `-apple-visual-effect: -apple-system-glass-material`.
  - For: no new window, no relay for the live preview, and placement and focus work like the menus.
  - Against: it needs `_setUseSystemAppearance` on the main web view in every theme (today only Liquid Glass's). That has a known side effect on fixed-`light` themes in Dark Mode. Turning it on only while the panel is open may restyle the theme visibly.
  - On Windows, WebView2 has no in-page material, so the panel there would be opaque.
- **B: its own child panel.** An `NSPanel` whose transparent web view sits on `NSGlassEffectView` (macOS 26; `NSVisualEffectView` before), placed against the button that opened it.
  - For: the real system glass in every theme, no change to the main web view, and Windows can use Acrylic (`DWMWA_SYSTEMBACKDROP_TYPE`).
  - Against:
    - a second web view (memory, warm-up);
    - key focus with Margin's non-activating panels;
    - full-screen Spaces (DECISIONS.md is full of child-window hazards there);
    - the live preview relayed through the app on every frame.

The spike's measurements, which decide between them:

1. How each looks.
2. What changes in the five themes, light and dark.
3. The time from a drag to the background layer's update, aiming under one frame at 120 Hz.
4. Opening while in a full-screen Space.

**Lean: A if its side effect is invisible, else B.** The component from step 4 is the same either way.

**Settled (spike, 2026-11-24): A.** Real glass on the picker in its closed shadow root and the top layer, the space's own light or dark, no measurable cost, and nothing visible changes in any theme's sidebar when the switch turns on. The one effect, Settings' native controls in a dark appearance (Neubrutalism's steppers, a sliver of Pixel's select), is avoided by drawing the picker solid while Margin's Settings page is on screen. B isn't built. The measurements: DECISIONS.md "M2.9 step 5 spike".

**Built (step 5):** the switch's coordination is `app/shared/host/materials.ts` (on while the theme or the open panel wants it; a theme's sheet never read with it on for the panel; an ask waits for one on its way). The runtime's `materials` option carries it to the picker's behaviour, which asks before it makes the panel and gives it back as it closes, asks nothing while Settings is shown or with more contrast, and closes if Settings comes while it holds it. The panel's CSS: `@supports (-apple-visual-effect: …) { @media not (prefers-contrast: more) { .panel { background: none; box-shadow: none; overflow: hidden; -apple-visual-effect: -apple-system-glass-material } } }`. No Swift change but words: the `appearance` message was already the switch. DECISIONS.md "M2.9 step 5".

### 6. Feedback: haptics or sound

- **The page decides, natively informed.** The Mac side tells the picker which device the current gesture comes from (`pointerKind: "trackpad" | "mouse"`). The picker then either:
  - sends `perform('haptic.alignment')` (the existing path; detents use `.alignment`, a texture change `.levelChange` through a new `haptic.level`, the `Said` enum, FFI code and `said()` case); or
  - plays a short click on WebAudio (generated, no file).
- **Detecting the device: a mouse unless proven a trackpad.** Haptics play only on positive trackpad evidence in the current gesture. Anything else gets sound, so a mouse lands on sound by construction.
  - The evidence (which one separates the cases is decided in the spike, step 0):
    - **Pointer gestures:** at mouse-down, the event's `subtype` (`.touch` vs `.mouseEvent`), or any `.pressure` event during the gesture (only Force Touch trackpads send these).
    - **Scrolls on the dial:** `hasPreciseScrollingDeltas` plus a non-empty `phase`.
    - **If neither works for tap-to-click:** indirect touches (`allowedTouchTypes = .indirect`) on the panel's host view.
  - **Haptics hardware:** the IORegistry's `AppleMultitouchDevice` entries carry `ActuationSupported`. With no such device connected, it's always sound.
  - **Tirth's Mac has** the built-in trackpad and a Magic Trackpad (both `ForceSupported` and `ActuationSupported`), and **no mouse**:
    - The trackpad cases are checked by hand on both: physical click, tap-to-click, a force click, and scrolling on the dial.
    - **The mouse case is checked with synthesized events.** `CGEvent` mouse-down, drag and line-scroll events carry what a plain USB mouse sends (subtype `.mouseEvent`, no pressure, no touches, no precise deltas, no phase). The classifier's Swift tests feed it those. They stand in for a real mouse, which stays a manual check (below).
  - Magic Mouse is untested (none available). Its surface may report touches and phases, which could look like a trackpad. If it does, haptics play to no effect: silence, not a wrong sound. The setting fixes it, and the manual check covers it.
- **Windows and Linux:** always sound (no haptics API used).
- **Setting** `pickerFeedback: "auto" | "haptics" | "sound" | "off"` (default `auto`), in Settings, validated in `model.ts`'s settings and the core's twin.
  - It covers the case where the system's "Force Click and haptic feedback" is off and haptics are silently suppressed.
  - Sound also respects macOS's "Play user interface sound effects" if Margin can read it. That gets checked in the spike.
- Ticks are limited to one per 20 ms, so a fast spin doesn't buzz.

### 7. Pictures

- **The store:**
  - `data/app/backgrounds/<sha256>.<ext>`, next to the library's set, written atomically like `core/src/data/themes.rs`.
  - It lives in the core, so Mac and Windows share it.
  - On the way in, the picture is decoded and re-encoded (long side ≤ 3840 px, ≤ 10 MB in, JPEG/PNG/WebP in, JPEG or PNG out), which strips metadata (EXIF, GPS). Anything that doesn't decode is refused.
  - The decoder: Rust's `image` crate, limited to those formats, or ImageIO on Mac and WIC on Windows. It's chosen in step 7 on size and on `cargo deny`. HEIC (iPhone photos) is possible only with the system decoders: Rust's `image` crate can't read it.
- **Getting a picture in:**
  - The picture button: on Mac, `NSOpenPanel` through `perform('background.choose')`, read natively.
  - A drop on the field: the page reads the file and sends its bytes once (`perform('background.add', {name, bytes})`, capped before sending).
  - Both answer with the id.
- **Serving:** `margin-app://app/background/<id>` from `OverlaySchemeHandler`, and `/background/<id>` from `serve.rs` on Windows.
  - The id must be 64 hex characters and present in the store. The content type comes from the stored extension. Nothing else is served, and no path is built from input.
  - Themes can't reach it: `sanitizeCss` refuses non-bundled URLs.
- **Cleaning up:** a file no space references is removed at launch, not at save, so ⌘Z and Escape can always bring one back.
- **The palette from a picture:** its average colour, computed at ingest, stored beside the file and sent with the snapshot.

### 8. Arc import

- Margin has no Arc importer. This step adds **spaces and their backgrounds only**:
  - read `StorableSidebar.json`;
  - make a space per Arc space (name, its key colour as `color`, and `background`).
- **The mapping:**

  | Arc | Margin |
  |---|---|
  | `blendedSingleColor.color` | `colors: [color]` |
  | `blendedGradient.baseColors` | `colors` (first three) |
  | `wheel` | `wheel` |
  | `intensityFactor` | `intensity` |
  | `noiseFactor` | `amount` (snapped to 0.05) |
  | `overlay` | `texture` |
  | `contentOverBackgroundAppearance` | `appearance` (absent → `auto`) |

  Extended-sRGB values are clamped to 0–1. `isVibrant` and `translucencyStyle` are ignored (decision 3).
- Pins, folders and tabs from Arc are a separate feature, not this milestone.
- The fixtures are made-up `windowTheme`s in Arc's exact shape (single colour, gradient, dark, absent appearance, extended-sRGB values out of range, unknown overlay). Tirth's own six go in only if he agrees, and then only the `windowTheme` objects, with no names or tabs.

## Order (one commit each; `npm run test:quick` before each; `npm run gate` once before merging)

| # | Commit | Touches | Tests |
|---|---|---|---|
| 0 | Spikes (no product code; results in DECISIONS.md) | throwaway, on this branch | A small event logger Tirth runs on both trackpads (click, tap-to-click, force click, scroll); synthesized `CGEvent` mouse events through the same logger; A vs B measurements; `NSView.appearance` on the web view, with and without system appearance; reading Arc's file from Margin.app; the UI-sound preference |
| 1 | `feat(m2.9)`: a space's background in the library | core `state.rs`, `model/spaces.rs`, `actions.rs` (`rename_space`), `values.rs`, `snapshot.rs` (an object-or-absent writer); TS `model.ts`, `library.ts`, `types/margin.d.ts`, `data-set.ts`; vectors (`generate.ts`, `edges.ts`, re-recorded); `docs/DATA.md` | Rust unit tests per rule, an edge case per wrong type, the vectors on both sides, data-set round-trip |
| 2 | `feat(m2.9)`: Margin's background layer and palette under every theme | `ui/background.ts`, `background-look.ts`, `color.ts`, `textures.ts` (new), `runtime.ts`, `render.ts`, `view-model.ts`, `host-app.ts` `cornerFill`, `overlay.ts`, the five themes' CSS, themes README | Theme tests: each theme with and without a background, light, dark, more contrast, every texture, a theme without the contract, `--m-fg` on `--m-bg` ≥ 4.5:1, corner fill sRGB, cross-fade, reduced motion |
| 3 | `feat(m2.9)`: appearance per space | core `object.rs`, FFI `data.rs`, `Library.swift`, `HostedSession.swift`, `MarginWindowController.swift` (Windows later, with its library windows) | Core and FFI tests; a Swift unit test of WebKit's side; end-to-end: the window and its page follow the shown space |
| 4 | `feat(m2.9)`: the Edit Theme Color picker (built) | `ui/picker/*`, `behaviors/background-picker.ts` (new), `extension/shared/space-background.ts` (the rule, out of `model.ts`), `menu-items.ts`, `menus.ts`, `actions.ts` (`space.editBackground`, `space.setBackground`), `runtime.ts`, `overlay.ts` | Behaviour tests in Chromium and WebKit: drag, wheel, −/+, presets, slider, dial (turn, drag, scroll, click, swipe), undo, Escape, save as one request, Use for all spaces, keyboard |
| 5 | `feat(m2.9)`: Margin's default picker on system glass (built: A) | `host/materials.ts` (new), `overlay.ts`, `runtime.ts`, `behaviors/background-picker.ts`, `picker/panel.ts`; Swift words; `tools/glass-shots` (a `picker` state); `tools/app-tests/run.sh` (the page rebuilt for the e2e part too) | Node: the switch's rules; Chromium and WebKit: asked before the panel is made, given back, every way it ends, Settings, more contrast; e2e in Margin.app: on while open, the page knows the property, off when closed; the real glass photographed |
| 5b | `feat(m2.9)`: a theme's own picker, the `background-picker` part (built: part 1 the mechanism, part 2 the three themes) | `ui/picker/panel.ts` (its elements as parts' slots: `<m-picker-field>`, `-appearance`, `-colors`, `-swatches`, `-intensity`, `-texture`, `-foot`), `render.ts`, `sanitize.ts`, themes README; Material's, Neubrutalism's and Pixel's parts | Theme tests: a part drawn and working in both engines, the default without one, an element left out, a part's bad CSS or markup refused; each built-in theme's picker opens, drags, saves |
| 6 | `feat(m2.9)`: haptic or sound ticks | Swift device detection, `said.rs`/FFI/`PageCore.swift` (`haptic.level`), picker, settings (`model.ts` + core) | Unit tests of the choice table (kind × setting × platform); the rate limit; Swift tests of the classifier with synthesized events |
| 7 | `feat(m2.9)`: pictures as backgrounds | core store (new), scheme route (Swift), `serve.rs`, picker button and drop, snapshot's average colour | Store tests (atomic, bad input, size cap, metadata stripped, cleanup); the route refuses everything but a stored id; security tests (a theme can't load it); e2e: add, show, remove |
| 8 | `feat(m2.9)`: Arc import of spaces and their backgrounds | core importer (new), Settings entry | Fixture tests over the six real `windowTheme`s and malformed input |
| 9 | `docs(m2.9)`: DECISIONS.md, themes README, TESTING.md manual checks | docs | |

Steps 1, 2 and 4 contain no Swift and can run alongside the Mac session's work. Steps 3, 5, 6 and 7 touch `MarginWindowController.swift` and `OverlayWebView.swift`, so they rebase onto `refactor/hosted-only` first.

## What only a Mac can confirm (manual checks, TESTING.md)

- Haptics on the built-in and Magic Trackpad, with click and tap-to-click, and nothing doubled.
- **With a real mouse (when one is at hand; none on Tirth's Mac):** sound on a USB or Bluetooth mouse, and what a Magic Mouse gets.
- The glass panel in all five themes, light and dark, in a window and in full screen.
- Per-space appearance switching Arcadia, Material and Liquid Glass. Safari's pages unchanged.
- Arc import from the real `StorableSidebar.json`.
- Windows: Acrylic panel (if B), sound ticks, `PreferredColorScheme`.

## Risks

- **The glass route (step 5)** is the one real unknown. The spike settles it before any Swift is written for the picker.
- **Device detection** may not separate tap-to-click from a mouse by event fields alone. The touch fallback and the setting cover it.
- **Theme contract:** a theme that paints its ground in more places than `.page` needs each place opted in. The theme tests list each surface per theme.
- **Merge:** the Mac session is changing `MarginWindowController.swift` now. Swift steps go last and rebase first.

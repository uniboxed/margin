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
8. **The picker's panel is glass in every theme.** This is an exception to "no blur anywhere" (DECISIONS.md:5138) and to "system glass only in Liquid Glass" (DECISIONS.md:5204). It is Margin's own chrome, not a theme's surface. It's recorded in DECISIONS.md with step 5.
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

### 2. Drawing: Margin's backdrop, under any theme

Margin draws the background itself, as one layer, so every theme gets the same result and only has to make room for it.

- **`<m-backdrop>`**, in Margin's own closed shadow root (like `theme-preview.ts`), behind the theme's root:
  - Layers, bottom to top: the underlay (light or dark), the picture, the colours at the intensity's alpha, then the texture at the amount.
  - It's masked out of the page's rect and corner radius, read from the theme's `.page` at layout, the same rect Margin already sends for the hole.
- **What the runtime sets on the theme's root**, from its own constructed sheet built only from validated values:

  | Variable | Value |
  |---|---|
  | `--m-ground` | `transparent` while a background is set |
  | `--m-bg` | the background flattened to one sRGB hex: the colours averaged over the underlay at the intensity |
  | `--m-fg`, `--m-fg-2`, `--m-accent`, `--m-hover`, `--m-sel` | the palette, derived in OKLCH and written as sRGB hex |
  | `--space-color` | as today |

  Also `data-appearance="light|dark"` on the root.
- **Corner fill:** `cornerFill` and `fill.rs` read the page corners. While a background is set, the corners take `--m-bg`, so they never read `transparent`.
- **The theme contract** (themes README, "Classes and variables Margin sets"):
  - A theme opts in by painting its ground (and any surface that should show the background) with `var(--m-ground, <its own>)`, and its text with `var(--m-fg, <its own>)`.
  - All five built-in themes take it in this work: Arcadia, Material, Liquid Glass, Neubrutalism (its dots become what it draws with no background), and Pixel.
  - A theme without the contract keeps its own look. Its ground covers the backdrop.
- **Textures:**
  - Grain, sand, denim and tweed are tiles generated once on a canvas and handed over as `blob:` URLs (CSP allows `blob:`). There are no files and nothing from Arc.
  - Dots and grid are CSS gradients in `--m-fg`.
- **Switching spaces** cross-fades the backdrop (Arc's `progress`), timed to the existing swipe and theme swap (`overlay.ts:638`). It's instant under reduced motion.
- **More contrast:** the picker can't push text below WCAG AA. Under `prefers-contrast: more`, the intensity caps where `--m-fg` on `--m-bg` would fall below 7:1.

### 3. Appearance per space

- The effective appearance is the space's own value, or the system's under `auto`. Arc-style: a picture with no colours uses the picture's lightness.
- **Mac:** the web view's `NSView.appearance` (`.aqua` or `.darkAqua`; `nil` for `auto`). This switches `prefers-color-scheme` for Arcadia and Material and `light-dark()` for Liquid Glass with no CSS change.
- **Windows:** WebView2's `PreferredColorScheme`.
- Neubrutalism (fixed light) and Pixel (fixed dark) keep their look. Only the backdrop and palette follow.
- Safari's pages aren't affected, and the tooltip says so.

### 4. The picker: Margin's own component

- A Margin-owned panel (closed shadow root, `all: initial`, its words in the component, not the theme's), so it looks the same in every theme. It's a TypeScript module that works without a host, so it's tested in Chromium and WebKit.
- **Controls, as in the prototype:**
  - appearance buttons;
  - the dotted field with up to three knobs;
  - −/+ and the wheel pill;
  - preset pages (Margin's own colours, today's 8 `SPACE_COLORS` on page one);
  - the wavy slider;
  - the dial (turn the ring, drag the centre, scroll; click or a sideways swipe changes texture);
  - the picture button and drop.
- **Live:** dragging redraws the backdrop on every animation frame. Nothing is saved until the gesture ends.
- **Saving:**
  - Closing (Done, a click outside) saves one `space.update {background, color}`. Escape restores the value from when the panel opened. ⌘Z undoes one gesture.
  - "Use for all spaces" sends the same `space.update` for every space of the profile, in one batch.
- **Where it opens:** "Edit Theme Color…" in the space's menu (`menu-items.ts`, after the theme items), and a button in the space's editor.
- **Its glass:** see step 5.

### 5. The panel's glass: two candidates, settled by a spike

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
3. The time from a drag to the backdrop's update, aiming under one frame at 120 Hz.
4. Opening while in a full-screen Space.

**Lean: A if its side effect is invisible, else B.** The component from step 4 is the same either way.

### 6. Feedback: haptics or sound

- **The page decides, natively informed.** The Mac side tells the picker which device the current gesture comes from (`pointerKind: "trackpad" | "mouse"`). The picker then either:
  - sends `perform('haptic.alignment')` (the existing path; detents use `.alignment`, a texture change `.levelChange` through a new `haptic.level`, the `Said` enum, FFI code and `said()` case); or
  - plays a short click on WebAudio (generated, no file).
- **Detecting the device** (verified on hardware in the spike, step 0):
  - Pointer gestures: at mouse-down, the event's `subtype` (`.touch` vs `.mouseEvent`) and any `.pressure` event (Force Touch trackpads only) during the gesture.
  - Scrolls on the dial: `hasPreciseScrollingDeltas` plus a non-empty `phase` (trackpad or Magic Mouse).
  - Fallback if those don't separate the cases: indirect touches (`allowedTouchTypes = .indirect`) on the panel's host view.
  - The cases to check: built-in trackpad (click, and tap-to-click), Magic Trackpad, Magic Mouse, a plain USB mouse.
  - Haptics on Magic Mouse do nothing, so it counts as a mouse.
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
| 0 | Spikes (no product code; results in DECISIONS.md) | throwaway, on this branch | Hardware matrix for device detection (Tirth); A vs B measurements; `NSView.appearance` on the web view, with and without system appearance; reading Arc's file from Margin.app; the UI-sound preference |
| 1 | `feat(m2.9)`: a space's background in the library | core `state.rs`, `model/spaces.rs`, `actions.rs` (`rename_space`), `values.rs`, `snapshot.rs` (an object-or-absent writer); TS `model.ts`, `library.ts`, `types/margin.d.ts`, `data-set.ts`; vectors (`generate.ts`, `edges.ts`, re-recorded); `docs/DATA.md` | Rust unit tests per rule, an edge case per wrong type, the vectors on both sides, data-set round-trip |
| 2 | `feat(m2.9)`: Margin's backdrop and palette under every theme | `ui/backdrop.ts` (new), `runtime.ts`, `view-model.ts`, `host-app.ts` `cornerFill`, `page/fill.rs`, the five themes' CSS, themes README | Theme tests: each theme with and without a background, light, dark, more contrast, every texture, a theme without the contract, `--m-fg` on `--m-bg` ≥ 4.5:1, corner fill sRGB, cross-fade, reduced motion |
| 3 | `feat(m2.9)`: appearance per space | `MarginWindowController.swift` (web view appearance), Windows `webview.rs`, runtime | Theme tests via `emulateMedia`; a Swift unit test that the appearance follows the shown space |
| 4 | `feat(m2.9)`: the Edit Theme Color picker | `ui/picker/*` (new), `menu-items.ts`, `editor.ts`, `actions.ts` (`space.update` carries `background`), `runtime.ts` | Behaviour tests in Chromium and WebKit: drag, wheel, −/+, presets, slider, dial (turn, drag, scroll, click, swipe), undo, Escape, save as one request, Use for all spaces, keyboard |
| 5 | `feat(m2.9)`: the picker on system glass (A or B per spike) | Swift; DECISIONS.md (the glass exception) | Swift unit tests; e2e: opens, places, closes, keeps focus |
| 6 | `feat(m2.9)`: haptic or sound ticks | Swift device detection, `said.rs`/FFI/`PageCore.swift` (`haptic.level`), picker, settings (`model.ts` + core) | Unit tests of the choice table (kind × setting × platform); the rate limit; Swift tests of the classifier with synthesized events |
| 7 | `feat(m2.9)`: pictures as backgrounds | core store (new), scheme route (Swift), `serve.rs`, picker button and drop, snapshot's average colour | Store tests (atomic, bad input, size cap, metadata stripped, cleanup); the route refuses everything but a stored id; security tests (a theme can't load it); e2e: add, show, remove |
| 8 | `feat(m2.9)`: Arc import of spaces and their backgrounds | core importer (new), Settings entry | Fixture tests over the six real `windowTheme`s and malformed input |
| 9 | `docs(m2.9)`: DECISIONS.md, themes README, TESTING.md manual checks | docs | |

Steps 1, 2 and 4 contain no Swift and can run alongside the Mac session's work. Steps 3, 5, 6 and 7 touch `MarginWindowController.swift` and `OverlayWebView.swift`, so they rebase onto `refactor/hosted-only` first.

## What only a Mac can confirm (manual checks, TESTING.md)

- Haptics on the built-in and Magic Trackpad, sound with a mouse, nothing doubled.
- The glass panel in all five themes, light and dark, in a window and in full screen.
- Per-space appearance switching Arcadia, Material and Liquid Glass. Safari's pages unchanged.
- Arc import from the real `StorableSidebar.json`.
- Windows: Acrylic panel (if B), sound ticks, `PreferredColorScheme`.

## Risks

- **The glass route (step 5)** is the one real unknown. The spike settles it before any Swift is written for the picker.
- **Device detection** may not separate tap-to-click from a mouse by event fields alone. The touch fallback and the setting cover it.
- **Theme contract:** a theme that paints its ground in more places than `.page` needs each place opted in. The theme tests list each surface per theme.
- **Merge:** the Mac session is changing `MarginWindowController.swift` now. Swift steps go last and rebase first.

# Margin logo

The mark is **dressed**: a plain app window wearing two stickers. The round red one is a tab, the square blue one is an app. The window underneath never changes, which is the whole idea of Margin: any UI around every tab and app.

## Which file to use

| You need | Use |
| --- | --- |
| The app icon, large (website, press, App Store art) | `png/margin-icon-1024.png` or `svg/margin-icon.svg` |
| The app icon in Xcode | `macos/AppIcon.appiconset` (drop it into `Assets.xcassets`) |
| A `.icns` file without Xcode | `macos/Margin.icns` |
| Liquid Glass (macOS 26) | `macos/icon-composer-layers/` in Icon Composer; previews in `svg/margin-icon-glass*.svg` |
| The logo in a header or footer | On colour (sky, pink, orange, purple, cork): `svg/margin-lockup-navy.svg` or `svg/margin-lockup.svg`. On dark: `svg/margin-lockup-white.svg`. On white, cream or putty: `svg/margin-lockup-icon.svg` |
| The mark on its own | `svg/margin-mark.svg` (printed) or `svg/margin-mark-flat.svg` (flat) |
| One colour (stamps, embossing, single-ink print) | `svg/margin-mark-black.svg`, `svg/margin-mark-white.svg` |
| A website's tab icon and share image | everything in `web/` (snippet below) |

### Printed or flat?

- **Printed** files have the paper grain, halftone dots and torn sticker edges. Use them at 64px and up, where the texture shows.
- **Flat** files are clean shapes with no SVG filters. Use them at 32px and below, in product UI, and in design tools: Figma, Sketch and Illustrator often drop or mangle the filters the printed SVGs use.
- The macOS icon set already switches to flat at 32px and below.

## Colours

| Part | Hex |
| --- | --- |
| Plate (sky paper) | `#58B8F2` |
| Window | `#F4F1E8` |
| Tab disc (vermilion) | `#E8452F` |
| App tile (cobalt) | `#3A5BE8` |
| Window dots and wordmark | `#17120E` |
| Sticker edges | `#FBFAF6` |

## Rules

- **Light grounds:** the window is cream, so on white, cream or putty the bare mark loses its window and only the two stickers show. There, use the lockup with the icon (`margin-lockup-icon.svg`) or the app icon.
- **Clear space:** keep a gap at least as wide as the red disc on every side of the mark.
- **Minimum size:** 16px for the app icon (flat). The mark beside the wordmark should be at least 20px tall.
- **Wordmark:** "margin" in lowercase, League Spartan ExtraBold, letter-spacing -0.045em. The lockup files have it outlined, so no font is needed.
- **Round is a tab, square is an app.** Never swap their shapes or colours.
- Don't rotate the mark, remove the white sticker edges, add a shadow or glow, or recolour it outside the one-colour versions.
- Don't add letters, a sidebar shape, or a third sticker.

## Liquid Glass with Icon Composer

1. Open Icon Composer and set the background to `#58B8F2`, or the gradient `#7AD0FF` to `#1B4FD8` used in the glass previews.
2. Import the four layers in order: `1-window.svg`, `2-window-dots.svg`, `3-tab-disc.svg`, `4-app-tile.svg`. They are flat fills on a full 1024 canvas; Icon Composer adds the glass, light and depth.
3. Check the dark and tinted modes; the dots layer may need its own colour in dark mode.

These layers were not tested in Icon Composer. They are scaled so the plate fills the whole canvas; if the artwork sits too close to the edge of Apple's icon shape, scale the group down slightly in Icon Composer.

## Web snippet

```html
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:image" content="https://unibox.company/og-image.png">
```

Change the `og:image` URL to wherever the site is hosted.

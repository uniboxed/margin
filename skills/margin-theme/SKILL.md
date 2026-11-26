---
name: margin-theme
description: Make or change a theme for Margin (the browser sidebar app): its look, layout, colours, type and motion, written as theme.json, theme.html and theme.css. Use when someone asks for a Margin theme, to restyle Margin's sidebar, or to fix a theme Margin refused. Checks it with Margin's own checker, and Margin can follow the folder live (Load Unpacked).
---

# Making a Margin theme

A Margin theme is a folder of three text files (and optional fonts and images) that draws Margin's whole window: the
sidebar, the page card around the web page, the command bar, menus, Settings. It's HTML and CSS only. Margin fills it
with data through bindings and runs every behaviour itself: a theme never runs JavaScript, never loads anything from
the network, and Margin's checker removes or refuses anything else.

## Files in this skill

- `reference/README.md`: the full theme guide. It covers the template language (`{{bindings}}`, `<m-if>`, `<m-for>`,
  `m-action`, behaviours), every part and slot, the view model, the actions, motion, a space's background, the
  security rules and the size caps. Read the parts you need before writing; it's the source of truth.
- `template/`: a complete working theme to start from (Margin's Neubrutalism under the id `my-theme`). It uses every
  binding, behaviour and part.
- `scripts/check-theme.mjs`: Margin's own import check, bundled to run with Node alone:
  `node scripts/check-theme.mjs <folder>`. It prints what's wrong, what Margin would remove, and motion that may not be
  smooth, and exits 1 when Margin wouldn't use the theme.

## How to work

1. **Start from a copy of `template/`** in a new folder, unless the person gave you a theme to change. Give it its own
   `id` in `theme.json` (lower-case letters, digits and dashes, 1–41 characters, not a built-in's: `arcadia`,
   `neubrutalism`, `pixel`, `liquid-glass`, `material`), a `name`, `author` and `version`.
2. **Change the look in `theme.css` first.** Colours, type, spacing, shapes and motion cover most requests. Change
   `theme.html` only when the layout itself must change, and keep every part and slot the template has.
3. **Keep the ways back out.** The `launcher`, `settings`, `prompt` and `notice` parts, `<m-launcher>`, `<m-prompt>`
   and `<m-notice>` in the window's tree, and `<m-settings>` in the launcher part. Without them Margin refuses the
   theme, because Settings is where someone switches away from it.
4. **Check it after every change:** `node scripts/check-theme.mjs <folder>`. Fix every error it prints before you say
   the theme is done. Read the "removes" list too: whatever Margin removes won't show.
5. **See it live:** ask the person to open Margin, choose Settings › Theme › Load Unpacked…, pick the folder and choose
   Use Theme. Margin then follows the folder: each save is checked and drawn at once when it passes. When it fails,
   Settings shows why on Load Unpacked's line, and the last version that passed stays drawn. Keep the same `id` while
   the folder is linked.
6. **To share it**, zip the folder and name it `<id>.margintheme`. People import it with Settings › Theme › Import
   Theme….

## Rules that matter most (the guide's "Security rules" has the full list)

- HTML and CSS only, in `theme.html` and `theme.css`. No `<script>`, `<style>`, `<link>`, frames or forms, no event
  attributes, no links that go anywhere. `img` takes only bundled images and `data:` images.
- CSS: no `@import`; `url()` only to files in the package or `data:` images and fonts; no `attr()`; functions from
  an allowlist. Fonts are `.woff2` files in `fonts/`, each with its licence text beside it, never a font service.
- **A stylesheet writes no text.** `content` and `quotes` take only `""` (an empty box to decorate). Labels come
  from bindings.
- **Margin's own words.** Inside the `menu`, `menu-item`, `notice`, `prompt`, `space-editor` and `settings` parts
  (and their slots), every visible text must be one of Margin's bound labels. Static text, `title`, `alt`,
  `placeholder` and `aria-label` there are removed.
- Ids named like Margin's globals (`webkit`, `marginApp`, `window`, `top`…) or starting with `margin` and a letter
  are removed.
- Animate `transform`, `opacity`, `translate`, `scale` and `rotate`. Animating layout properties (`width`, `height`,
  `left`, `margin`, `transition: all`) drops frames.
- Light and dark: honour `prefers-color-scheme`. Under `[m-background]` (a space with a background) stop painting the
  ground where the background should show, and use Margin's `--m-fg`, `--m-bg` and related colours on surfaces that
  lie on it.
- At most 64 files, two folders deep, within the guide's size caps. A key twice in `theme.json` refuses the theme.

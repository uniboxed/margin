# Writing a Margin theme

A theme is HTML and CSS, no JavaScript. Margin's runtime (`extension/ui/`)
renders it from a view model, runs its buttons as checked actions, and
gives it behaviors (drag and drop, resizing, menus…) through attributes.
The built-in themes are packages like any other: `arcadia/` (Margin's
default, today's look) and `neo-brutalism/` (uses every binding, behavior
and part). Read them next to this guide. The plan behind it is `PLAN.md`
§3 and §4.

## The files

```text
my-theme/
  theme.json   the manifest
  theme.html   the template: one root element, exactly one <m-page>
  theme.css    the styles
  fonts/*.woff2, images/*   bundled files (only what theme.json names)
```

`theme.json` (format 2, schema in `ui/theme-schema.js`):

```json
{
  "format": 2, "id": "my-theme", "name": "My theme", "version": "1.0.0", "author": "Me",
  "modes": ["fullscreen", "windowed", "inpage"],
  "fonts": [{ "family": "Space Grotesk", "file": "fonts/space-grotesk.woff2", "weight": "300 700" }],
  "images": ["images/grain.png"],
  "settings": { "sidebarWidth": { "type": "number", "default": 260, "min": 160, "max": 500, "step": 10, "label": "Sidebar width" } },
  "layout": { "reveal": "left", "sidebarMin": 160, "sidebarMax": 500, "sidebarDefault": 260 }
}
```

- A bad `id`, `name`, `version` or `format` refuses the theme; a bad font,
  image or setting, or an unknown field, is removed and reported.
- Fonts are loaded from their bytes (no `@font-face`, no URL); use the
  family name in CSS.
- Settings (`color`, `length`, `number`, `choice`, `toggle`) become CSS
  variables `--m-<kebab-name>` (`sidebarWidth` → `var(--m-sidebar-width)`,
  a toggle is 1 or 0) and `settings.<name>` in the view model.
  `sidebarWidth` is the one `m-resize` drags.
- `layout` is what Margin needs before rendering: the edge a hidden sidebar
  comes from and its widths.

## The template

| Write | What it does |
|---|---|
| `{{space.name}}` | text from the view model; dotted paths only, never expressions |
| `<m-for each="space.today" as="t" key="id">…</m-for>` | a keyed list (`key` defaults to `id`) |
| `<m-if test="space.hasToday">…<m-else>…</m-else></m-if>` | a condition; `test="!path"` negates |
| `title="{{t.title}}"` | a bound attribute: `aria-*`, `data-*`, `title`, `alt`, `hidden`, `disabled`, `lang`, `dir`, an input's `placeholder` |
| `m-attr:aria-pressed="{{s.active}}"` | the same, one value (`false`/null removes it) |
| `m-class:active="{{t.active}}"` | a class while the value is true |
| `m-style:--chip="{{s.color}}"` | a CSS variable (checked: no `url()`, strings, escapes) |
| `<img m-icon="{{t.icon}}">` | a stored `data:` icon, nothing else |
| `m-action="tab.activate" m-arg="{{t.id}}"` | on a `button` or `a`: a click runs one of Margin's actions |

Margin's slots:

| Slot | Shows | While |
|---|---|---|
| `<m-page>` (one, required) | the browser's page: its box is the page's place (insets and corner radius reported to the host); never paints, never takes the pointer | always |
| `<m-menu>` | the `menu` part; placed by Margin at `--m-menu-x`, `--m-menu-y` | `menu` |
| `<m-editor>` | the `space-editor` part | `editor` |
| `<m-palette>` | the `palette` part (or draw it yourself inside `<m-if test="palette.open">`) | `palette.open` |
| `<m-notice>` | the `notice` part | `notice` |
| `<m-prompt>` | the `prompt` part | `prompt` |
| `<m-launcher>` | the `launcher` part (Margin's new-tab page) | `launcher` |
| `<m-settings>` | the `settings` part (put it in your launcher) | `settingsForm` (Settings open) |
| `<m-window-controls>`, `<m-drag-region>` | the window's buttons and where a drag moves it (windowed mode) | always |

Parts are `<template m-part="name">` anywhere in the template: `menu`,
`menu-item`, `space-editor`, `palette`, `palette-row`, `notice`, `prompt`,
`launcher`, `settings`, `window-controls`. What a theme puts inside a slot
is used when it has no part for it.

**Never paint under `<m-page>`.** The browser's page shows through it: in a
page, Margin's UI lies over the page, and in Margin.app the page slot is a
hole in Margin's window. Draw a ground around the page as the page card's
spread `box-shadow` (Arcadia's frame), or mask it out (Neo-brutalism's dots).
Margin lets the pointer through to the page over the slot, past your root's
own background; what you draw over the page (a sidebar out over it, a
dialog) still takes it.

**Settings.** The `settings` part lays out `settingsForm.fields` (Margin's
words only: it's guarded like a menu). Each field has one of `isNumber`,
`isToggle`, `isChoice`, `isList`, `isShortcut`, `isButton`, `isInfo`,
`isGroup`, and `label`, `status`, `error`, `disabled`, `recording`. Draw
Margin's inputs for them, inside the field's `<m-for>`; Margin sets their
value, type, options and bounds, and saves them by its own rules:

```html
<m-for each="settingsForm.fields" as="f">
  <m-if test="f.isToggle"><label>{{f.label}}<input m-input="setting-toggle"></label></m-if>
  <m-if test="f.isNumber"><label>{{f.label}}<input m-input="setting-number"></label></m-if>
  <m-if test="f.isChoice"><label>{{f.label}}<select m-input="setting-choice"></select></label></m-if>
  <m-if test="f.isList"><label>{{f.label}}<textarea m-input="setting-list"></textarea></label></m-if>
  <m-if test="f.isShortcut"><label>{{f.label}}<input m-input="setting-shortcut"></label></m-if>
  <m-if test="f.isButton"><button m-action="settings.run" m-arg="{{f.id}}">{{f.label}}</button></m-if>
</m-for>
```

Modes: style `[data-mode="fullscreen|windowed|inpage"]` by binding
`m-attr:data-mode="{{window.mode}}"` on your root.

## The view model

One versioned object (`ui/view-model.js`, `VM_VERSION`), the same in every
host. Immutable: rows that didn't change are the same objects.

- `window`: `id`, `mode`, `focused`, `sidebar` (`open`, `hidden`, `peek`),
  `sidebarOpen`, `peek`, `pinnedOpen` (Keep open), `frameWhenHidden`.
- `space`: `id`, `name`, `emoji`, `color`, `abbr`, `index`, `tabCount`,
  `pinned` (folders and loose pins in order; `isFolder` tells them apart),
  `folders[]` (`name`, `open`, `count`, `pins`, `shown`, `hasShown`), `pins`,
  `today` (the other tabs, newest first), `hasToday`, `hasPinned`,
  `newTab.active`.
- Each tab or pin row: `id`, `title`, `url`, `host`, `icon` (or `letter` on
  `color`), `active`, `behind`, `audible`, `asleep`, `loading`; pins also
  `open`, `tabId`, `folderId`, `nested`.
- Tab rows also have `open` and `notOpen`. Margin's sidebar is the real list
  of tabs: a tab whose browser tab is gone (its window closed, the browser
  didn't bring it back after a relaunch, or Margin put it to sleep in Safari)
  stays in its space, in every window that shows the space, with `notOpen`
  true (its `id` is then Margin's own, a string). Draw it as not open, for
  example dimmed (`m-class:not-open="{{t.notOpen}}"`; Arcadia fades its icon
  and title, Neo-brutalism its title and icon box). Its row takes the same
  actions as any tab's: `tab.activate` opens it in the window it was clicked
  in, `tab.close` sends it to the archive, and its menu, drags and drops work
  as an open tab's. It's never `active`, `audible`, `asleep` or `loading`.
- `space.tabCount` counts the space's tabs open in this window and its tabs
  that aren't open.
- `spaces[]` (chips: `active` too; `label`, the name, or "Name · Profile"
  with several profiles), `profiles[]`, `profile` and `multiProfile`: with
  Margin.app and spaces in several browser profiles, `spaces[]` is every
  profile's spaces in one order; a chip's `profile` (`id`, `name`, `emoji`,
  `color`, `initial`, `here`), `foreign` (another profile's: a click switches
  to that profile's window, never `active`), `profileMark` (show its
  profile's mark), `profileStart` (the first of a run of one profile after
  another's: a divider) and `switching` (Margin.app is switching to it). With
  one profile `profile` is null and the rest false, `profiles` empty. The
  `editor` part also edits a profile (`editor.isProfile`: no delete).
- `tab` (the one in front), `archive[]`
  (`ago` too), `palette` (`open`, `query`, `rows[]`: `title`, `subtitle`,
  `badge`, `emoji`, `icon`, `letter`, `color`, `selected`, `goes`; `hasRows`),
  `menu` (`label`, `items[]`: `id`, `label`, `separator`, `danger`,
  `confirming`), `settingsForm` (`fields[]`, above), `editor` (`name`, `emoji`, `color`, `colors[]`,
  `deleteLabel`, `deleteTitle`, `cannotDelete`, `confirmDelete`, `labels`:
  `title`, `name`, `emoji`, `colors`, `save`, `cancel`), `notice` and
  `prompt` (`text`, `title`, `actions[]`: `id`, `label`, `primary`,
  `danger`), `launcher` (`pins`, `archive`, `hasPins`, `hasArchive`, `more`,
  `moreLabel`, `settingsOpen`), `settings`, `platform`.

## Actions

A theme's button runs one of these; each argument is checked against the
state first (an open tab, an existing space, a row on screen), and anything
else is ignored and logged.

- Tabs and pins: `tab.activate` (tab), `tab.close` (tab), `tab.new` (none:
  the palette for a new tab; or a space), `tab.pin` (tab), `tab.unpin` (pin),
  `pin.open` (pin).
- Folders: `folder.toggle`, `folder.new`, `folder.newWithTab` (tab),
  `folder.newWithPin` (pin), `folder.rename`, `folder.delete` (its pins stay).
- Spaces: `space.switch`, `space.new`, `space.edit`, `space.rename`,
  `today.clear`.
- The palette: `palette.open`, `palette.close`, `palette.run` (a row).
- Menus: `menu.open` (`add`), `menu.run` (an item), `menu.close`.
- The space editor: `editor.save`, `editor.cancel`, `editor.delete` (asks
  first), `editor.color` (a swatch).
- Notices and prompts: `notice.run`, `prompt.run` (one of their buttons),
  `notice.close`, `prompt.close`.
- The rest: `sidebar.toggle`, `nav.back`, `nav.forward`, `nav.reload`,
  `archive.open`, `archive.restore` (an archived entry), `settings.open`
  (opens or closes the launcher's Settings; on a web page, Margin's start
  page with them open), `settings.run` (a button of Settings),
  `launcher.more`, `window.close`, `window.minimise`, `window.fullscreen`.
- Only Margin's behaviors and menus run `tab.move`, `tab.pinAt`,
  `tab.moveToSpace`, `pin.move`, `folder.move`, `folder.setName`,
  `space.setName`, `space.update` and `space.delete`.

## Behaviors

Opt in with attributes; they stay on the element, so CSS can select them.

| Attribute | Values | What Margin does |
|---|---|---|
| `m-input` | `palette`, `space-name`, `space-emoji`, `launcher`, `setting-number`, `setting-toggle`, `setting-choice` (a `<select>`), `setting-list` (a `<textarea>`), `setting-shortcut` | Margin's own fields (the only inputs allowed): typing, keys, focus |
| `m-peek` | `left`, `right`, `top`, `bottom` | the hover zone that brings a hidden sidebar out (`--m-reveal-zone` is its size) |
| `m-resize` | `sidebar` | drags the `sidebarWidth` setting; double-click resets it |
| `m-drag` | `tab`, `pin`, `folder`, `space` | the row can be dragged |
| `m-drop` | `tabs`, `pins`, `folder`, `space` | where a drag can land |
| `m-rename` | `space`, `folder`, `tab` | double-click edits the name in place |
| `m-scroll` | `tabs`, `palette`, `archive` | the list's scroll is remembered per window |
| `m-swipe` | `spaces` | a sideways swipe moves between spaces |

Right-clicking a row with `m-drag` (or an action's row, or the space's
name) opens its menu. A mouse press on a tab, an open pin or a chip
switches at once.

Classes and variables Margin sets for you to style:

- `m-pressed` (a row while pressed), `m-renaming` (a name being edited);
- `m-dragging` (the row, and the root), `m-drag-tab|pin|folder|space` (the
  root), `m-drag-ghost` (the copy under the pointer), `m-drop-before`,
  `m-drop-after`, `m-drop-into`, `m-drop-end` (where it lands), `m-landing`
  (a dropped row while its copy glides in);
- `m-resizing` (the handle, and the root);
- `m-swiping`, `m-settling` and `--m-swipe-offset` (the `m-swipe` element);
- `--m-menu-x`, `--m-menu-y` (`<m-menu>`), `--m-reveal-zone` (`m-peek`),
  `--m-<setting>` (your settings).

## Security rules

A theme sees every tab's title and address, so it must not be able to run
code or send anything anywhere. Margin checks a theme when it's imported
and every time it loads (`ui/sanitize.js`), and the renderer enforces the
same rules again.

- Margin parses the template itself; allowed elements and attributes only.
  No scripts, frames, forms, `<style>`, `<link>`, event handlers, or links
  that go anywhere; `img` takes only bundled images and `data:` images;
  `input` only with `m-input`; buttons are never `submit`.
- CSS: no `@import`; `url()` only to bundled files or `data:` images and
  fonts; no `attr()`, no escapes outside strings, no string that looks like
  an address; functions from an allowlist.
- **A stylesheet writes no text**: `content` and `quotes` take only `""`
  (an empty box to decorate), no `var()` in them, counters and list markers
  only as numbers or symbols (no letters), no strings in `list-style`,
  `text-overflow`, `hyphenate-character` or `text-emphasis`. Its rules can
  reach Margin's own parts, so this is how they keep only Margin's words.
- **Margin's own words**: inside the `menu`, `menu-item`, `notice`,
  `prompt`, `space-editor` and `settings` parts, and the `<m-menu>`,
  `<m-notice>`, `<m-editor>`, `<m-prompt>` and `<m-settings>` slots, every
  visible text must come from
  Margin's bound labels (`{{i.label}}`, `{{notice.text}}`,
  `{{editor.labels.save}}`…). Text the theme writes there is removed and
  reported, and so are static `title`, `alt`, `placeholder`, `aria-label`
  (and the other text-bearing `aria-*`) values. Icons (svg shapes), images
  and decoration stay. So a theme can't make a menu item say "Delete" over
  "Close Tab", or a notice ask for a password.
- Bound values are checked at run time: CSS variables hold no `url()`,
  strings, escapes or `!important`; icons are `data:` images only.
- Actions come only from the list above, with checked arguments; a few only
  Margin's behaviors and menus may run.
- What no sanitizer can stop: a theme drawing an invisible button over the
  window, misleading text outside Margin's parts, or pictures of words (a
  bundled image, a font's glyphs). Imported themes show their name and
  author in Settings.

## Size caps

- `theme.html` and `theme.css` 256 KB each, `theme.json` 32 KB.
- Template: 6,000 nodes, 48 deep, 48 attributes an element, 4 KB an
  attribute value, `m-for` nested 3 deep.
- CSS: 4,000 rules, 20,000 declarations, nesting 8 deep, selectors 1 KB;
  a bound CSS value 256 characters; a `data:` URL 128 KB.
- Package: 3 MB in all, 64 files besides the three; fonts (woff2 only)
  512 KB each, images (png, jpg, gif, webp, avif, svg) 256 KB each, notes
  (txt, md) 64 KB each; stored, 4.5 MB with its base64.

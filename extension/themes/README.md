# Writing a Margin theme

A theme is HTML and CSS, no JavaScript. Margin's runtime (`extension/ui/`)
renders it from a view model, runs its buttons as checked actions, and
gives it behaviors (drag and drop, resizing, menus…) through attributes.
The built-in themes are packages like any other: `arcadia/` (Margin's
default, today's look), `neubrutalism/` (uses every binding, behavior
and part) and `pixel/` (an 8-bit game, dark only; every part, with pixel
svg icons where Margin's words are guarded). Read them next to this guide. The plan behind it is `PLAN.md`
§3 and §4.

## The files

```text
my-theme/
  theme.json   the manifest
  theme.html   the template: one root element, exactly one <m-page>
  theme.css    the styles
  fonts/*.woff2, images/*   bundled files (only what theme.json names)
  *.txt, *.md               licences and notes (kept, never loaded)
```

`theme.json` (format 2, schema in `ui/theme-schema.ts`):

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

## Making and importing a theme

1. **Start from a copy** of `neubrutalism/` (it uses every binding,
   behavior and part) or `arcadia/`.
2. **Give it your own `id`** in `theme.json`: lower-case letters, digits
   and dashes, not a built-in's. Bump `version` each time you change it.
3. **Keep the folder's layout:** `theme.json`, `theme.html` and
   `theme.css` at the top, fonts in `fonts/`, images in `images/`,
   licences and notes as `.txt` or `.md`. Two folders deep at most, 64
   files at most. Nothing else goes in: no scripts, no other kinds of file.
4. **Fonts:** woff2 only, each with its licence text beside it (the SIL OFL
   for Google Fonts). No font services, no addresses anywhere.
5. **Keep the ways back out:** the `launcher`, `settings`, `prompt` and
   `notice` parts, with `<m-launcher>`, `<m-prompt>` and `<m-notice>` in
   the window's tree and `<m-settings>` in the launcher part. An import
   without them is refused: Settings is where a theme is switched or removed.
6. **Check it** before you share it, as Margin will:
   `MARGIN_THEMES=~/my-theme npm run test:security`.
7. **Share it** as one file: zip the folder and name it
   `my-theme.margintheme`. Finder's Compress works (rename the `.zip`), and
   so does `npm run theme:pack ~/my-theme` (it also checks it, and says what
   it left out).
8. **Import it:** in Margin, Settings › Theme › Import Theme…, pick the
   folder or the `.margintheme` file, look at the preview, and choose Use
   Theme. Importing the same `id` again replaces it. Remove it from the
   same place.

What Margin does with it:

- It checks the theme when it's imported and every time it loads, with the
  rules under "Security rules" below. What it removed is listed in the
  preview, by count and kind.
- A `.margintheme` file must be a plain zip: stored or deflated entries, no
  links, no encryption, no zip64, at most 4 MB and 70 entries, nothing
  before the first entry. If everything is in one top folder
  (`my-theme/theme.json`), that folder is the theme. Finder's `__MACOSX/`
  and `.DS_Store` are skipped.
- Imported themes belong to the Mac: Margin.app keeps them (in
  `~/Library/Application Support/Margin/themes/`), and every profile and
  browser can use them. Each profile picks its own theme.
- If Margin can't draw your theme (it's refused, or its page is too small
  to use), it draws Arcadia and says so; Settings says why.

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
| `<m-cloud-tabs>` | the `cloud-tabs` part: iCloud Tabs, a live folder (put it above your new-tab row, outside any `m-drop`) | `cloudTabs` (Margin.app with Safari, "Show iCloud Tabs" on) |
| `<m-switch-cover>` | the `switch-cover` part, over the page's place (Margin's own centred card if you have none) | `switchCover` (Margin.app, switching to another profile) |
| `<m-window-controls>`, `<m-drag-region>` | the window's buttons and where a drag moves it (windowed mode) | always |

Parts are `<template m-part="name">` anywhere in the template: `menu`,
`menu-item`, `space-editor`, `palette`, `palette-row`, `notice`, `prompt`,
`launcher`, `settings`, `cloud-tabs`, `switch-cover`, `window-controls`. What a theme puts inside a slot
is used when it has no part for it.

**Never paint under `<m-page>`.** The browser's page shows through it: in a
page, Margin's UI lies over the page, and in Margin.app the page slot is a
hole in Margin's window. Draw a ground around the page as the page card's
spread `box-shadow` (Arcadia's frame), or mask it out (Neubrutalism's dots).
Margin lets the pointer through to the page over the slot, past your root's
own background; what you draw over the page (a sidebar out over it, a
dialog) still takes it. Two of Margin's slots are the exceptions, and paint
over the page's place on purpose: `<m-launcher>` (Margin's new-tab page)
and `<m-switch-cover>`.

**The switching cover.** While Margin.app switches to another profile, the
window being left shows `<m-switch-cover>` over its page for a moment, then
Margin hands the screen to the other profile's window. Put the slot where
the page's place is, above the launcher and under a sidebar out over the
page (so a swipe in the sidebar keeps going). Draw it solid: it hides the
page while the screen may be still. No fade (it comes and goes with the
switch). It's guarded: its words are Margin's (`{{switchCover.text}}`,
"Switching to Work…", and the space, `{{switchCover.space.name}}`). With
no part and nothing in the slot, Margin draws its own centred card, in
`--m-cover-ground`, `--m-cover-text` and `--m-cover-card` if your root sets
them.

```html
<m-switch-cover class="cover-slot"></m-switch-cover>
<template m-part="switch-cover">
  <div class="cover" role="status" m-attr:aria-label="{{switchCover.label}}">
    <span class="mark" m-style:--profile="{{switchCover.profile.color}}">{{switchCover.profile.emoji}}</span>
    <span>{{switchCover.text}}</span>
    <m-if test="switchCover.hasSpace"><span>{{switchCover.space.emoji}} {{switchCover.space.name}}</span></m-if>
  </div>
</template>
```

**Settings.** The `settings` part lays out `settingsForm.fields` (Margin's
words only: it's guarded like a menu). Each field has one of `isNumber`,
`isToggle`, `isChoice`, `isList`, `isShortcut`, `isColor`, `isButton`,
`isInfo`, `isGroup`, and `label`, `status`, `error`, `disabled`,
`recording`, `fromTheme`. Draw Margin's inputs for them, inside the
field's `<m-for>`; Margin sets their value, type, options and bounds, and
saves them by its own rules.

In Margin.app the form also has Import Theme… (a button), each imported
theme (an info line and a Remove button), and the active theme's own
settings from its `theme.json` under "Settings of “Name”", after Margin's
own settings and before the keyboard shortcuts: number, length
(a number input, saved with its default's unit), toggle, choice and color
(`isColor`, a colour well: `<input m-input="setting-color">`). Those
fields have `fromTheme` true: their label is the theme's own text (capped
at 40 characters, with no characters that reorder or hide text), so mark
them (`m-class:theme-own="{{f.fromTheme}}"`). They only ever save that
theme's settings.

```html
<m-for each="settingsForm.fields" as="f">
  <m-if test="f.isToggle"><label>{{f.label}}<input m-input="setting-toggle"></label></m-if>
  <m-if test="f.isNumber"><label>{{f.label}}<input m-input="setting-number"></label></m-if>
  <m-if test="f.isChoice">
    <label>{{f.label}}<select m-input="setting-choice"></select></label>
    <m-if test="f.hasStatus"><p role="status" m-class:error="{{f.error}}">{{f.status}}</p></m-if>
  </m-if>
  <m-if test="f.isList"><label>{{f.label}}<textarea m-input="setting-list"></textarea></label></m-if>
  <m-if test="f.isShortcut"><label>{{f.label}}<input m-input="setting-shortcut"></label></m-if>
  <m-if test="f.isColor"><label>{{f.label}}<input m-input="setting-color"></label></m-if>
  <m-if test="f.isButton">
    <button m-action="settings.run" m-arg="{{f.id}}">{{f.label}}</button>
    <m-if test="f.hasStatus"><span role="status" m-class:error="{{f.error}}">{{f.status}}</span></m-if>
  </m-if>
</m-for>
```

Draw `status` under a choice and a button (`hasStatus`). The theme
choice's status says why Margin fell back to Arcadia; a button's says
what it did.

**iCloud Tabs.** The tabs open in Safari on the person's other devices
(Margin.app reads them; Chrome and Edge get none yet). The `cloud-tabs`
part draws the whole folder from `cloudTabs`, so it stands on its own: put
`<m-cloud-tabs>` where it belongs in your layout (Arcadia and Neubrutalism:
above the new-tab row), and Margin may later show the same part elsewhere
(a button beside the sidebar's toggle, say). Make it read as a folder that's
plainly live, not one of the person's: it's read only, so never put `m-drag`
or `m-drop` in it or the slot inside a drop zone. A sketch:

```html
<template m-part="cloud-tabs">
  <div class="cloud" m-attr:aria-label="{{cloudTabs.labels.title}}">
    <button m-attr:aria-expanded="{{cloudTabs.open}}" m-action="cloud.toggle">{{cloudTabs.labels.title}} {{cloudTabs.count}}</button>
    <m-if test="cloudTabs.open">
      <m-if test="cloudTabs.hasMessage">
        <p>{{cloudTabs.message}}</p>
        <m-if test="cloudTabs.canFix"><button m-action="cloud.access">{{cloudTabs.labels.fix}}</button></m-if>
      </m-if>
      <m-for each="cloudTabs.devices" as="d">
        <button m-class:stale="{{d.stale}}" m-attr:aria-expanded="{{d.open}}" m-attr:aria-label="{{d.describe}}" m-action="cloud.toggleDevice" m-arg="{{d.id}}">{{d.name}} {{d.updated}}</button>
        <m-for each="d.shown" as="t">
          <a m-attr:aria-label="{{t.label}}" title="{{t.url}}" m-action="cloud.open" m-arg="{{t.id}}">{{t.title}} {{t.host}}</a>
        </m-for>
      </m-for>
    </m-if>
  </div>
</template>
```

It's a guarded part (below): every word in it is Margin's, since its one
button asks for a permission.

Modes: style `[data-mode="fullscreen|windowed|inpage"]` by binding
`m-attr:data-mode="{{window.mode}}"` on your root.

## The view model

One versioned object (`ui/view-model.ts`, `VM_VERSION`), the same in every
host. Immutable: rows that didn't change are the same objects.

- `window`: `id`, `mode`, `focused`, `sidebar` (`open`, `hidden`, `peek`),
  `sidebarOpen`, `peek`, `pinnedOpen` (Keep open), `frameWhenHidden`.
- `space`: `id`, `name`, `emoji`, `color`, `abbr`, `index` (from 0),
  `number` (its place counted from 1: Pixel's "WORLD 2-1"), `tabCount`,
  `pinned` (folders and loose pins in order; `isFolder` tells them apart),
  `folders[]` (`name`, `open`, `count`, `pins`, `shown`, `hasShown`), `pins`,
  `today` (the other tabs, newest first), `hasToday`, `hasPinned`,
  `newTab.active`.
- Each tab or pin row: `id`, `title`, `url`, `host`, `icon` (or `letter` on
  `color`), `active`, `behind`, `away`, `audible`, `asleep`, `loading`; pins also
  `open`, `tabId`, `folderId`, `nested`.
- `away` (with `active`): the row is this window's chosen tab, shown live in another window of the profile (two
  windows on one space list the same tabs, and the tab follows the window in front: docs/BROWSER-WINDOWS.md §9). Keep it
  highlighted, faded: Arcadia and Pixel fade the row, Neubrutalism fades the pressed button. Margin draws the
  tab's picture, faded, where its page was.
- `loading` (a row's, and `tab.loading` for the tab in front): the tab's
  page is loading, its page is being left (a link, ⌘R: before the next page
  arrives), or the site is running a navigation of its own. Draw it where it
  shows without a hover, the sidebar hidden too: Arcadia has a pill in the
  frame's top strip and pulses a loading row's icon; Neubrutalism spins the
  reload button, marches a stripe along the gutter above the page and blinks
  a loading row's icon box.
- Tab rows also have `open` and `notOpen`. Margin's sidebar is the real list
  of tabs: a tab whose browser tab is gone (its window closed, the browser
  didn't bring it back after a relaunch, or Margin put it to sleep in Safari)
  stays in its space, in every window that shows the space, with `notOpen`
  true (its `id` is then Margin's own, a string). The built-in themes draw it
  as any tab; yours may mark it (`m-class:not-open="{{t.notOpen}}"`). Its row takes the same
  actions as any tab's: `tab.activate` opens it in the window it was clicked
  in, `tab.close` sends it to the archive, and its menu, drags and drops work
  as an open tab's. It's never `active`, `audible`, `asleep` or `loading`.
- `space.tabCount` counts the space's tabs open in this window and its tabs
  that aren't open.
- `spaces[]` (chips: `active` and `number` too; `label`, the name, or "Name · Profile"
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
  `badge`, `spaceColor` (the badge's space's color, `''` for Archived,
  Search…), `emoji`, `isSearch` and `isOpen` (the typed text as a search or
  an address: draw an icon of your own), `icon`, `letter`, `color`,
  `selected`, `goes`; `hasRows`),
  `menu` (`label`, `items[]`: `id`, `label`, `separator`, `danger`,
  `confirming`), `settingsForm` (`fields[]`, above), `editor` (`name`, `emoji`, `color`, `colors[]`,
  `deleteLabel`, `deleteTitle`, `cannotDelete`, `confirmDelete`, `labels`:
  `title`, `name`, `emoji`, `colors`, `save`, `cancel`), `notice` and
  `prompt` (`text`, `title`, `actions[]`: `id`, `label`, `primary`,
  `danger`), `launcher` (`pins`, `archive`, `hasPins`, `hasArchive`, `more`,
  `moreLabel`, `settingsOpen`), `settings`, `platform`.
- `notice`: Margin's notices come from Margin's code only, never a theme or
  a message's words: a switch that didn't happen ("That tab is no longer
  open."), a page Margin isn't responding on (Reload, Not now), Margin
  updated while Safari was open (OK), Safari's "New tabs open with" setting
  (OK, Don't show again). Draw `notice.text` and its `actions` in the
  `notice` part; one is up at a time, and goes by itself.
- `gesture` (null unless one is under way): Margin's trackpad gestures on
  the page in front, pull to refresh (`pull`) and swipe back and forward
  (`swipe`, with `back` or `forward`), `armed` once letting go would do it,
  `done` for a moment once it did, `leaving` for a moment once it was let
  go of before it would (animate it back out), `progress` how far along (0
  to 1, in steps of 0.05, as of its last change of state; `percent` the same
  out of 100, for `m-style`). Margin.app eases the live progress into the
  CSS custom property `--gesture-live` every display frame (on the root,
  inherited: nothing is drawn again), so read that first, with `progress` as
  the fallback: `m-style:--gesture="{{gesture.progress}}"` and
  `--g: var(--gesture-live, var(--gesture))` (all three built-in themes).
  Draw a badge over the page (icons only: it's outside the guarded parts but
  has no words of its own), `pointer-events: none`, and let it come in with
  the progress; keep the per-frame part to `transform`, `opacity` and the
  like, which don't lay anything out.
- `palette.rows[]` also have `section` and `sectionStart`: rows from one
  place come as a run with a heading ("On iPhone": iCloud Tabs,
  after Margin's own rows). Draw `{{r.section}}` before a row whose
  `sectionStart` is true, inside the rows' `<m-for>`; Margin's own rows
  have `''` and false.
- `cloudTabs` (null unless Margin.app draws a Safari window with "Show
  iCloud Tabs" on): `open` (the folder expanded), one of `ready`, `empty`
  (no other device has tabs), `noAccess` (no Full Disk Access; `canFix`:
  its button runs `cloud.access`), `noData` (iCloud Tabs off or not
  synced), `failed`; `message` and `hasMessage` (Margin's words for the
  state), `count` and `hasCount` (tabs on all devices), `labels` (`title`,
  `toggle`, `fix`, `pinned`), and `devices[]`: `id`, `name` (told apart
  from another with the same name), `label` ("On …"), `updated` ("updated
  5 min ago", to the day when that's all Safari keeps), `describe` (both),
  one of `isPhone`, `isPad`, `isMac`, `isVision`, `isOther` (its icon),
  `open`, `stale` (not used for a week: dim it), `count`, `tabs` and
  `shown` (its tabs while it's open). Each tab: `id`, `title`, `url`,
  `host`, `icon` (Margin's stored icon for the site, else `letter` on
  `color`), `pinned` (pinned on that device), `label` (for screen
  readers).
- `switchCover` (null unless Margin.app is switching this window's view to
  another profile, and only before the switch hands over): `text`
  ("Switching to Work…"), `label` (with the space, for screen readers),
  `profile` (`name`, `emoji`, `color`, `initial`, `symbol`: a `data:`
  picture or null), `space` (`name`, `emoji`), `hasSpace`, and `id` (the
  target, Margin's own).

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
- iCloud Tabs: `cloud.toggle` (the folder), `cloud.toggleDevice` (a
  device), `cloud.open` (a tab: opened in this window and space, as an
  address typed in), `cloud.copy` (its address), `cloud.access` (System
  Settings at Full Disk Access). A right-click on a tab's row (its
  `cloud.open`) opens its menu: Open, Copy Link.
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
| `m-input` | `palette`, `space-name`, `space-emoji`, `launcher`, `setting-number`, `setting-toggle`, `setting-choice` (a `<select>`), `setting-list` (a `<textarea>`), `setting-shortcut`, `setting-color` (a colour well) | Margin's own fields (the only inputs allowed): typing, keys, focus |
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
and every time it loads (`ui/sanitize.ts`), and the renderer enforces the
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
  `prompt`, `space-editor`, `settings`, `cloud-tabs` and `switch-cover`
  parts, and the `<m-menu>`, `<m-notice>`, `<m-editor>`, `<m-prompt>`,
  `<m-settings>`, `<m-cloud-tabs>` and `<m-switch-cover>` slots, every
  visible text must come from
  Margin's bound labels (`{{i.label}}`, `{{notice.text}}`,
  `{{editor.labels.save}}`…). Text the theme writes there is removed and
  reported, and so are static `title`, `alt`, `placeholder`, `aria-label`
  (and the other text-bearing `aria-*`) values. Icons (svg shapes), images
  and decoration stay. So a theme can't make a menu item say "Delete" over
  "Close Tab", or a notice ask for a password.
- Inside those parts an svg `<use>` is removed too: it could draw text the
  theme wrote outside them (svg `<text>` in a `<symbol>`).
- Ids named like the globals Margin's code reads (`webkit`, `marginApp`,
  `browser`, `chrome`, `safari`, `Margin`, `T`, `window`, `top`… any case:
  `ui/sanitize.ts RESERVED_IDS`), and any id that is `margin` and then a
  letter, digit or `_` (`marginFallbackTheme`; `margin-results` is fine),
  are removed: in Margin.app's overlay the
  theme's ids are the window's names. One template per part: a second is
  removed.
- Files: each one's first bytes must match its kind (`wOF2` for a font,
  the PNG, JPEG, GIF, WebP or AVIF signature for an image, UTF-8 text that
  starts with `<svg` for an svg image, UTF-8 text for a note). Two paths
  that differ only by case are refused.
- `theme.json`: a key twice in one object refuses the theme. A name, author
  or label with control characters, bidi controls or zero-width
  characters is refused.
- Bound values are checked at run time: CSS variables hold no `url()`,
  strings, escapes or `!important`; icons are `data:` images only.
- Actions come only from the list above, with checked arguments; a few only
  Margin's behaviors and menus may run.
- What no sanitizer can stop: a theme drawing an invisible button over the
  window, misleading text outside Margin's parts, or pictures of words (a
  bundled image, a font's glyphs). Imported themes show their name and
  author in Settings.
- Checked as one command: `npm run test:security` runs every rule's
  payloads in Node and live in WebKit and Chromium (every request refused),
  every built-in theme through the checks an imported one goes through,
  and the overlay's own policy with the sanitizer skipped. To check your
  theme the same way: `MARGIN_THEMES=~/my-theme npm run test:security`
  (several: separate them with `:`).

## Size caps

- `theme.html` and `theme.css` 256 KB each, `theme.json` 32 KB.
- Template: 6,000 nodes, 48 deep, 48 attributes an element, 4 KB an
  attribute value, `m-for` nested 3 deep.
- CSS: 4,000 rules, 20,000 declarations, nesting 8 deep, selectors 1 KB;
  a bound CSS value 256 characters; a `data:` URL 128 KB.
- Package: 3 MB in all, 64 files besides the three; fonts (woff2 only)
  512 KB each, images (png, jpg, gif, webp, avif, svg) 256 KB each, notes
  (txt, md) 64 KB each; stored, 4.5 MB with its base64.

# Writing a Margin theme

A theme is HTML and CSS, no JavaScript. Margin's runtime (`app/shared/ui/`)
renders it from a view model, runs its buttons as checked actions, and
gives it behaviors (drag and drop, resizing, menus…) through attributes.
The built-in themes are packages like any other: `arcadia/` (Margin's
default: the window in the space's colour), `neubrutalism/` (uses every binding, behavior
and part), `pixel/` (an 8-bit game, dark only; every part, with pixel
svg icons where Margin's words are guarded) and `liquid-glass/` (macOS's
own glass where Margin.app has it, plain fills elsewhere: "The system's
materials" below) and `material/` (Material 3 on Arcadia's template: every
colour role worked out from the space's colour, at Material's tones with
relative `oklch()` colours). Read them next to this guide. The plan behind it is `PLAN.md`
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
  "layout": { "reveal": "left", "sidebarMin": 160, "sidebarMax": 500, "sidebarDefault": 260 },
  "systemMaterials": false
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
- `systemMaterials` (true or absent): the theme draws with macOS's own
  materials ("The system's materials" below).

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
| `<m-page>` (one, required) | the browser's page: its box is the page's place, where Margin.app puts the hosted window (its insets and corner radius reported to the host); never paints, never takes the pointer | always |
| `<m-menu>` | the `menu` part; placed by Margin at `--m-menu-x`, `--m-menu-y` | `menu` |
| `<m-editor>` | the `space-editor` part | `editor` |
| `<m-palette>` | the `palette` part (or draw it yourself inside `<m-if test="palette.open">`) | `palette.open` |
| `<m-notice>` | the `notice` part | `notice` |
| `<m-prompt>` | the `prompt` part | `prompt` |
| `<m-toast>` | the `toast` part (guarded: Margin's transient toast pill, e.g. `Copied URL`) | `toast` |
| `<m-preview>` | the `preview` part (guarded: the preview card and Quick Tab, below) | `preview` |
| `<m-preview-page>` (only in the `preview` part, one, empty) | where the card's page goes: Margin.app puts the card's Safari window exactly over it (measured as laid out, like `<m-page>`); never paint it while the card is `ready` | inside the part |
| `<m-launcher>` | the `launcher` part (Margin's new-tab page) | `launcher` |
| `<m-page-loader>` | the `page-loader` part (Margin.app: the page card while an item opens) | `pageLoader` (the page card is `loading`) |
| `<m-settings>` | the `settings` part (put it in your launcher) | `settingsForm` (Settings open) |
| `<m-window-controls>`, `<m-drag-region>` | the window's buttons and where a drag moves it (windowed mode) | always |

Parts are `<template m-part="name">` anywhere in the template: `menu`,
`menu-item`, `space-editor`, `palette`, `palette-row`, `notice`, `prompt`,
`toast`, `preview`, `launcher`, `settings`, `window-controls`, `page-loader`. What a theme puts
inside a slot is used when it has no part for it.

### The preview card and Quick Tab (the `preview` part)

Margin.app shows a link in a preview card over the page (Shift+click, or a click to another site from a pinned tab or a
favorite) and Quick Tab (⌥⌘N: an address field first) in the theme's guarded `preview` part, in `<m-preview>`. The card's
page is a Safari window of its own that Margin.app places exactly at your `<m-preview-page>`, so lay the part out with
it in mind:

- **Where.** While a card is up the root has `--m-page-left`, `--m-page-top`, `--m-page-right`, `--m-page-bottom`
  (px from the window's edges: the page's place) and `--m-page-radius`. Put `<m-preview>` over the page area with them
  (`position: fixed`, those four as its edges, `overflow: hidden`) and the card inside it. The built-in themes centre
  the card with 8% of the page area beside it and 7% above and below, at least 420×320 for its page, under a 52 pt bar
  (`left: clamp(0px, 8%, calc(50% - 210px))` and so on: no transform in its place, which the card's motion owns).
  **The bar must be opaque and cover at least the 52 pt above `<m-preview-page>` across its width:** the card's Safari
  window keeps its full-screen toolbar window resting just above its page, and anything of it not under an opaque part
  of yours shows through the dim (and takes hovers).
- **The page.** `<m-preview-page>` is measured as laid out (offsets, not the box as drawn: a scale on the card never moves
  the window). While `preview.loading` (its window isn't in place yet) paint it opaque (your panel's colour, a spinner):
  the window is under it. Once `preview.ready`, it must be clear and take no pointer (`pointer-events: none`): the card's
  window shows through and takes the clicks. As it goes (`preview.closing`) paint it again.
- **The dim.** Dim the page area around the card only, never over `<m-preview-page>`: Margin's window is above the hosted
  windows, so a dim drawn over the card's page darkens it. The built-ins use an element at the card's place with
  `box-shadow: 0 0 0 100vmax <dim>` (`<m-preview>`'s `overflow: hidden` keeps it in the page area); light and dark each
  their own strength. Once the card's window is in place the dimmed area takes no pointer (Margin.app catches a press
  there and closes the card); while it loads, and for Quick Tab's field alone, a full-size button with
  `m-action="preview.close"` under the card takes it.
- **The bar.** `preview.back`, `preview.forward`, `preview.copyUrl`, `preview.expand` (into the space, also ⌘↩), `preview.close`
  (also Esc and ⌘W), the address (`preview.host`); Quick Tab: `<input m-input="preview">` (Return takes it as the palette
  does: an address, else a search; Escape closes) in `<m-if test="preview.isQuickTab">`, with `<m-preview-page>` hidden.
  Its words are Margin's (`preview.labels`).
- **Motion.** Open: the dim fades in and the card comes from `scale(0.96)` and `opacity: 0` in about 150 ms; close
  (`preview.closing`, then the part is gone 150 ms later): the reverse. Transform and opacity only; with
  `prefers-reduced-motion`, opacity only.

A theme with no `preview` part (or no `<m-preview>` with anything in it) gets Margin's default card (`m-preview[m-default]`,
drawn in `Canvas` and `CanvasText`, restyled with rules on `m-preview[m-default]`; its own pieces are `[m-preview-card]`, `[m-preview-bar]`,
`[m-preview-host]`, `[m-preview-field]`, `[m-preview-button="preview.…"]` and `m-preview-page`, `[m-quick-tab]` on it for
Quick Tab): the same place, bar and motion. A
`preview` part with no `<m-preview-page>`: Margin.app puts the card's window at that default place, under whatever you draw.

**Never paint under `<m-page>`.** The browser's page shows through it: in a
page, Margin's UI lies over the page, and in Margin.app the page slot is a
hole in Margin's window. Draw a ground around the page as the page card's
spread `box-shadow` (Arcadia's frame), or mask it out (Neubrutalism's dots).
Margin lets the pointer through to the page over the slot, past your root's
own background; what you draw over the page (a sidebar out over it, a
dialog) still takes it. Two of Margin's slots are the exception, and paint
over the page's place on purpose: `<m-launcher>` (Margin's new-tab page) and
`<m-page-loader>` (below).

**The page card's state (Margin.app).** In Margin.app, Margin's window is
*in front of* the app or browser window it hosts: that window sits under it,
in the page's place, and everything you draw around and over the page (your
frame, the card's rounded corners, the palette, a menu) is drawn over that
app. The runtime tells you what the page's place holds with an attribute on
your root element, `m-page-state`:

| `m-page-state` | The page's place | What to draw there |
|---|---|---|
| `shown` | a hosted window is in place and ready, seen through the hole | **nothing**: no background, shadow or pseudo-element inside `<m-page>`'s content box; your frame and the corners outside the card's curve are yours, over the app. The pointer goes through to the app there. |
| `loading` | an item is being opened, made ready or fitted again | an opaque card with a loader: whatever happens to the app behind it isn't seen. The pointer is Margin's. |
| `empty` | nothing to show | your launcher, as before. |

```css
.root[m-page-state="loading"] .page { box-shadow: 0 0 0 1px var(--line), var(--frame); }
```

The loader is the `page-loader` part, shown in `<m-page-loader>` while the
state is `loading` (place the slot yourself: a sibling of `<m-page>` laid
over it). It's one of Margin's guarded parts: only Margin's words show in it,
`{{pageLoader.label}}` ("Opening Safari…") and `{{pageLoader.name}}` (the
app's or the item's name); shapes and icons are yours.

`{{pageLoader.icon}}` is the icon of what's opening: the app's own for an
app, the hosted browser's (Safari's) for a web page, a 64 px PNG `data:`
image (sharp up to 32 px on a 2x display), or null when Margin has none (an
app that isn't installed, before the list of apps is read). It binds the way
a row's icon does, and only in the loader: an `<img m-icon>` in the
`page-loader` part or its `<m-page-loader>` slot, or a test (`m-if`,
`m-class:`); anywhere else, as text or as another attribute's value, the
sanitizer removes it. Wrap it in `<m-if test="pageLoader.icon">` so a loader
with no icon draws as it did. (Why the browser's icon for a web page and not
the page's own: it's the browser that's being opened and brought in behind
the card, its icon is always there and sharp, and a site's icon is often a
16 px one, blurred at a loader's size.)

```html
<m-page class="page"></m-page>
<m-page-loader class="page-loader"></m-page-loader>
<template m-part="page-loader">
  <div class="loading-card">
    <m-if test="pageLoader.icon"><img class="app-icon" alt="" m-icon="{{pageLoader.icon}}"></m-if>
    <span class="spinner"></span><p>{{pageLoader.label}}</p>
  </div>
</template>
```

A theme with no `page-loader` part gets Margin's default: the opening app's
icon (32 px, when there is one), a quiet spinner and the label, centred on an opaque card laid exactly over the page's place
with its corner radii (`m-page-loader[m-default]`, drawn in `Canvas` and
`CanvasText`: restyle it with a rule on `m-page-loader` if you only want
your card's colour). Margin fades its default out over the hosted window as
the state turns `shown` (120 ms; at once with `prefers-reduced-motion`); a
part of your own is taken out as the state changes, so a fade of yours
belongs on the card around it (`[m-page-state]` transitions), at most 150 ms.
A switch between two items that are already open never passes through
`loading` (it only comes if the item isn't in place within about 120 ms).
Outside Margin.app (the Windows shell, a page's own Margin) the root has no
`m-page-state`: the browser's page is always there.

`m-starting` is on your root from its first frame until the frame after
the state's data was first drawn: draw a skeleton there if you like
(`.root[m-starting] .tabs { … }`). It's never set when the data is there at
the first draw, which is the usual case in Margin.app (its window is shown
only once its page is drawn).

The built-in themes each have a loader of their own, in their own language:
Arcadia a soft tile in the space's colour with a thin ring turning in it,
Neubrutalism Margin's words in its heavy type over a chunky bar with a
striped block running along it, Pixel an hourglass and a meter that fills
cell by cell (`steps()`), Liquid Glass one glass capsule on a card lit in
the space's colour, Material a many-lobed shape turning and breathing in a
round container (Material 3 Expressive's loading indicator, by transform alone). How they're built, to copy: the `<m-page-loader>` itself
is the opaque card (the page's place exactly, the card's inner radius),
see-through with `pointer-events: none` outside `loading` so that it fades
over the window that's shown (120 ms; the part in it goes at once); only
`transform` and `opacity` move, nothing while it isn't drawn, nothing at all
with `prefers-reduced-motion` (a still mark stays); sizes follow the card
(`100% - …`), so a long name is cut with an ellipsis in the smallest window.
Under `m-starting` with nothing hosted yet (`[m-starting][m-page-state="empty"]`)
the same card is drawn without words by the slot's own `::before` and
`::after`, and the sidebar draws a few placeholder rows on what's already
there (backgrounds and pseudo-elements, one soft `opacity` pulse).

### Split View's panes (Margin.app)

While the item in front is a pane of a split and a window is hosted in the page
area, Margin puts the split's boxes inside your `<m-page>` (docs/PEEK-SPLIT.md
§4). They're Margin's own elements: a template can't write them (the sanitizer
drops any `m-pane` or `m-divider` of yours), and you never place them; you
style them.

```
<m-page m-split="row" m-split-id="…">        (or m-split="column": stacked)
  <m-pane m-pane-id="…" m-index="0" m-focused></m-pane>
  <m-divider m-index="0" role="separator" tabindex="0" aria-orientation="vertical"></m-divider>
  <m-pane m-pane-id="…" m-index="1"></m-pane>
</m-page>
```

| What | Yours to style | Margin's |
|---|---|---|
| `m-page[m-split]` | nothing new | `display: flex` (row or column) |
| `m-pane` | the focused pane's ring (`m-pane[m-focused]`: a `box-shadow` outside the box, in the gap; never a background or anything inside it: the pane's window shows there) | its size: `flex-grow` by the split's ratios, `min-width` / `min-height` 220 (Arc's least; a window that needs more is shown cut, its arrows below) |
| `m-pane-arrow` | a cut pane's arrows (`[m-side="left\|right\|up\|down"]`, `[m-mode="slide"]`): their look (Margin's default is a small round chip in the system's colours with a chevron) | when they're shown (`m-pane[m-cut-hover]`: the pointer over that pane), their sides, their press, the pointer |
| `m-divider` | the gap's colour (paint it as your frame around the page card: the ground Margin draws under the gap is that), a grip (`::after`), its hover, `:focus-visible` and drag (`[m-dragging]`; the root has `m-split-resizing` meanwhile) | the gap's size: `--m-split-gap` (8 px if you set none: set it on your root), the cursor, the pointer, the drag |
| `m-divider[m-band]` | stacked, above a pane hosted in a Safari window: the band its full-screen toolbar window rests in (Arc's pane header); style it as the gap, and its `<m-band-title>` (the pane's name and host, Margin's text: colour, font, opacity) | its height (52 pt at least, your gap if that's more), its title's text and place |
| `m-pane[m-loading]` | that pane's loader while its window opens (its `<m-pane-loader>`: Margin's spinner and "Opening …"; colour, font) | when it's shown, its words; the other panes stay shown and usable |

The divider is dragged by Margin (the two panes beside it follow the pointer,
each stopping at its window's minimum; the hosted windows follow live where
they can), a double-click makes the panes equal, and ←/→ (↑/↓ stacked) move it
when it has the keys. Margin measures each `m-pane` with the page and places
each pane's window there: a border, padding or margin on `m-pane` moves the
window with it, so leave the box alone. Keep any transition on the grip (≤
150 ms, none with `prefers-reduced-motion`): nothing about the boxes animates.
All five built-in themes show how (each theme.css, "Split View").

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

**Settings as its own page.** In Margin.app, Settings is a tab of its own
(`margin://settings`: the palette's Settings, a `settings.open` button, its
row in the sidebar), drawn in your `launcher` part with `settingsTab` set;
the new-tab page's `#settings` is the same page. Draw it as macOS's System
Settings: `settingsTab.title`, its `categories[]` in a sidebar (`id`,
`label`, `help`, `selected`, and `isAppearance`, `isTabs`, `isBrowsing`,
`isKeyboard` for an icon of your own), each a button with
`m-action="settings.category"` and `m-arg="{{c.id}}"`, and beside them
`settingsTab.current` (`label`, `help`) over your `<m-settings>`. A theme
that reads `settingsTab` gets only the chosen category's fields in
`settingsForm`; one that doesn't gets the whole form with
`launcher.settingsPage` (a heading of its own and the form, as before).
Under the search field, show Settings only while `launcher.hasSettings`
(false in Margin.app's window, where it's its own tab).

```html
<template m-part="launcher">
  <m-if test="settingsTab">
    <main class="settings-page">
      <nav>
        <h1>{{settingsTab.title}}</h1>
        <m-for each="settingsTab.categories" as="c">
          <button m-class:selected="{{c.selected}}" m-action="settings.category" m-arg="{{c.id}}">{{c.label}}</button>
        </m-for>
      </nav>
      <section><h2>{{settingsTab.current.label}}</h2><m-settings></m-settings></section>
    </main>
    <m-else><main class="launcher">…<m-if test="launcher.hasSettings">…<m-settings></m-settings></m-if></main></m-else>
  </m-if>
</template>
```

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

Modes: style `[data-mode="fullscreen|windowed|inpage"]` by binding
`m-attr:data-mode="{{window.mode}}"` on your root.

## The view model

One versioned object (`ui/view-model.ts`, `VM_VERSION`), the same in every
host. Immutable: rows that didn't change are the same objects.

- `window`: `id`, `mode`, `focused`, `sidebar` (`open`, `hidden`, `peek`),
  `sidebarOpen`, `peek`, `pinnedOpen` (Keep open), `frameWhenHidden`.
- `space`: `id`, `name`, `emoji`, `color`, `abbr`, `index` (from 0),
  `number` (its place counted from 1: Pixel's "WORLD 2-1"), `tabCount`,
  `pinned` (top-level folders and loose pins in order; `isFolder` tells them apart),
  `pinnedFlat` (pre-order flattened list of all visible folders up to depth 4 and pins, each with `depth`),
  `folders[]` (`name`, `open`, `parentFolderId`, `depth`, `count`, `pins`, `shown`, `shownFlat`, `hasShown`), `pins`,
  `splits[]` (`id`, `axis`, `active`, `panes[]`, `ratios`, `count`, `title`) and `hasSplits`,
  `today` (the other tabs, newest first), `hasToday`, `hasPinned`,
  `newTab.active`, `background` (the space's background as stored, null for none: Margin draws it, "A space's
  background" below).
- `favorites`: `items[]` (web tabs & hosted apps, up to 12, sticky `open`/`active`/`drifted`/`rootUrl`/`audible`/`muted`), `hasItems`, `columns` (1–4).
- `media` (the background mini player: null unless a tab not in front of this window is playing, or paused within the last 30 s; hosted Mac apps later): `title`, `subtitle`, `artwork` (a data URL, or null), `icon`, `letter`, `color`, `playing`, `paused`, `muted`, `canPrev`, `canNext`.
- `toast` (null unless showing; guarded): `id`, `text`.
- `preview` (null unless open; guarded): `url`, `host`, `title`, `isQuickTab` (and `quickTab`), `loading` (its window not in place yet), `ready` (in place: `<m-preview-page>` clear), `closing`, `query` (Quick Tab's field), `canGoBack`, `canGoForward` (true unless the page said otherwise), `spaceId`, `spaceName`, `spaceEmoji`, `labels` (`expand`, `copyUrl`, `close`, `back`, `forward`, `search`).
- `split` (null unless the active tab is inside a Split View): `id`, `axis`, `isHorizontal`, `isVertical`, `panes[]`, `dividers[]`, `canAddPane`, `labels`.
- Each tab or pin row: `id`, `title`, `url`, `host`, `icon` (or `letter` on
  `color`; an app item's, in Margin.app: the installed app's icon, its name's
  letter when it has none), `active`, `behind`, `away`, `audible`, `muted`, `asleep`, `loading`, `hasCustomTitle`; pins also
  `open`, `tabId`, `folderId`, `nested`, `depth`, `drifted`, `rootUrl`.
- `away` (with `active`): the row is this window's chosen tab, shown live in another window of the profile (two
  windows on one space list the same tabs, and the tab follows the window in front: docs/BROWSER-WINDOWS.md §9). Keep it
  highlighted, faded: Arcadia and Pixel fade the row, Neubrutalism fades the pressed button. Margin draws the
  tab's picture, faded, where its page was.
- `loading` (a row's, and `tab.loading` for the tab in front): the tab's
  page is loading, its page is being left (a link, ⌘R: before the next page
  arrives), or the site is running a navigation of its own. Draw it where it
  shows without a hover, the sidebar hidden too: Arcadia has a pill in the
  frame's top strip and a small spinner in a loading row's icon's place; Neubrutalism spins the
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
- `spaces[]` (chips: `active` and `number` too; `label`, the name).
- `tab` (the one in front), `archive[]`
  (`ago` too), `palette` (`open`, `query`, `rows[]`: `title`, `subtitle`,
  `badge`, `spaceColor` (the badge's space's color, `''` for Archived,
  Search…), `emoji`, `isSearch` and `isOpen` (the typed text as a search or
  an address: draw an icon of your own), `isApp` (an installed app, in
  Margin.app: its `icon` is the app's own shape, best drawn without a
  tile), `icon`, `letter`, `color`, `selected`, `goes`; `hasRows`),
  `menu` (`label`, `items[]`: `id`, `label`, `separator`, `danger`,
  `confirming`), `settingsForm` (`fields[]`, above), `editor` (`name`, `emoji`, `color`, `colors[]`,
  `themes[]` (`id`, `name`, `selected`: each theme the space can have, its own
  chosen; each space has its own theme) and `theme` (the chosen one's id),
  `deleteLabel`, `deleteTitle`, `cannotDelete`, `confirmDelete`, `labels`:
  `title`, `name`, `emoji`, `colors`, `theme`, `save`, `cancel`), `notice` and
  `prompt` (`text`, `title`, `actions[]`: `id`, `label`, `primary`,
  `danger`), `launcher` (`pins`, `archive`, `hasPins`, `hasArchive`, `more`,
  `moreLabel`, `settingsOpen`, `settingsPage`, `hasSettings`), `settingsTab`
  (`title`, `categories[]`, `current`: Settings as its own page, above),
  `settings`, `platform`.
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
  place come as a run with a heading, after Margin's own rows. Draw
  `{{r.section}}` before a row whose `sectionStart` is true, inside the
  rows' `<m-for>`; Margin's own rows have `''` and false (no rows have a
  section today: iCloud Tabs, which had, were removed 2026-11-17).

## Actions

A theme's button runs one of these; each argument is checked against the
state first (an open tab, an existing space, a row on screen), and anything
else is ignored and logged.

- Tabs and pins: `tab.activate` (tab), `tab.close` (tab), `tab.new` (none:
  the palette for a new tab; or a space), `tab.pin` (tab), `tab.unpin` (pin),
  `tab.copyUrl`, `tab.mute`, `tab.duplicate`, `tab.unload`, `tab.reopenLast`,
  `tab.rename`, `tab.setTitle`, `pin.open` (pin), `pin.reset` (drifted sticky pin),
  `pin.rename`, `pin.setTitle`.
- Favorites: `favorite.open`, `favorite.add`, `favorite.remove`, `favorite.move`, `favorite.reset`.
- Folders: `folder.toggle`, `folder.new`, `folder.newSubfolder`, `folder.newWithTab` (tab),
  `folder.newWithPin` (pin), `folder.rename`, `folder.delete` (its pins stay).
- Media Mini Player: `media.toggle`, `media.prev`, `media.next`, `media.mute`, `media.focus`.
- The preview card and Quick Tab: `preview.close`, `preview.expand`, `preview.back`, `preview.forward`, `preview.copyUrl`, `preview.setSpace` (space), `quickTab.open`.
- Link Rules: `linkRules.addHost` (a tab: always open its site in this space), `linkRules.remove` (rule), `linkRules.toggle` (rule).
- Split View: `split.focus` (a pane's tab: the split shown with it focused), `split.add` (also `split.addPane`: a tab into the
  split of the item in front, or split with it), `split.open` (a split's id: shown), `split.remove` (a pane out, the rest
  shown), `split.breakOut` (a pane out, shown alone), `split.closePane` (its tab closed: the split goes on), `split.swap`
  and `split.toggleAxis` (a split's id). `split.resize` is Margin's own (its dividers), never a button's.
- Spaces: `space.switch`, `space.new`, `space.edit`, `space.rename`, `space.editBackground` (Edit Theme Color,
  Margin's own panel for the space's background, opened beside the button; the space's menu has it too),
  `today.clear`.
- The palette: `palette.open`, `palette.close`, `palette.run` (a row).
- Menus: `menu.open` (`add`), `menu.run` (an item), `menu.close`.
- The space editor: `editor.save`, `editor.cancel`, `editor.delete` (asks
  first), `editor.color` (a swatch), `editor.theme` (one of `editor.themes`'
  ids: the space's theme, saved with the rest; a space's menu offers the
  themes too, so a theme without this row still lets a space have its own).
- Notices and prompts: `notice.run`, `prompt.run` (one of their buttons),
  `notice.close`, `prompt.close`.
- The rest: `sidebar.toggle`, `nav.back`, `nav.forward`, `nav.reload`,
  `archive.open`, `archive.restore` (an archived entry), `settings.open`
  (opens or closes the launcher's Settings; on a web page, Margin's start
  page with them open; in Margin.app, its Settings tab), `settings.run` (a
  button of Settings), `settings.category` (one of the Settings page's
  categories, `settingsTab.categories[].id`),
  `launcher.more`, `window.close`, `window.minimise`, `window.fullscreen`.
- Only Margin's behaviors and menus run `tab.move`, `tab.pinAt`,
  `tab.moveToSpace`, `pin.move`, `folder.move`, `folder.setName`,
  `space.setName`, `space.update`, `space.setTheme`, `space.setBackground` and `space.delete`.

## Behaviors

Opt in with attributes; they stay on the element, so CSS can select them.

| Attribute | Values | What Margin does |
|---|---|---|
| `m-input` | `palette`, `space-name`, `space-emoji`, `launcher`, `preview` (Quick Tab's field, in the `preview` part), `setting-number`, `setting-toggle`, `setting-choice` (a `<select>`), `setting-list` (a `<textarea>`), `setting-shortcut`, `setting-color` (a colour well) | Margin's own fields (the only inputs allowed): typing, keys, focus |
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
- `m-swiping`, `m-settling` and `--m-swipe-offset` (the `m-swipe` element). By default
  the offset jumps to its end under `m-settling`, for your own transition. Set
  `--m-swipe-feel: arc` or `dia` on the `m-swipe` element for Arc's or Dia's own feel
  instead (the sidebar at half the fingers' distance, their choice of space at the
  lift, their rubber band; Arc's spring 0.4 s, Dia's 0.25 s and a haptic tick in
  Margin.app past halfway): under `m-settling` Margin then gives the settle as
  `--m-swipe-transition` (the spring sampled into a `linear()` easing), so use it on the
  moving part: `transition: var(--m-swipe-transition, none)` (Arcadia does this);
- `--m-menu-x`, `--m-menu-y` (`<m-menu>`), `--m-reveal-zone` (`m-peek`), `--m-page-left`, `--m-page-top`,
  `--m-page-right`, `--m-page-bottom`, `--m-page-radius` (on the root while the preview card is up: the page's place),
  `--m-<setting>` (your settings);
- `m-background` and `m-appearance`, and `--m-bg`, `--m-fg`, `--m-fg-2`, `--m-accent`, `--m-hover`, `--m-selected`:
  a space's background, below.

## A space's background

A space can have a background (Edit Theme Color: colours, intensity, a texture, light or dark). Margin draws it, not
the theme: one layer under everything the theme draws, over the whole window except the page card, which it is cut
out of exactly as `<m-page>` is drawn (its border box, its rounded corners). Your theme decides where it shows, by
letting it through.

While the space shown has one, Margin sets:

- `m-background` on your root, and `m-appearance` (`light` or `dark`): the appearance the background is drawn in, its
  own or the system's;
- on the container (`:host`, or `:root` in a document), plain colours worked out for it:
  - `--m-bg`, the background as one colour (its average), for anything solid that stands for the ground (a card over
    the page, a divider, a patch behind a label);
  - `--m-fg`, text on it: at least 4.5:1 against every part of it, 7:1 where it can (7:1 always with Increase
    contrast);
  - `--m-fg-2`, secondary text (4.5:1; 7:1 with Increase contrast);
  - `--m-accent`, the key colour as an accent (3:1, for non-text);
  - `--m-hover` and `--m-selected`, translucent fills for a row under the pointer and the row shown.

None of these are set while the space has no background, so `var(--m-fg, <yours>)` falls back to your own. (Don't
name a setting `bg`, `fg`, `accent`, `hover` or `selected`: its variable would have the same name.)

To take part, under `[m-background]`:

1. Stop painting your ground where the background should show: a spread `box-shadow` around the page card
   (`0 0 0 100vmax …`), the sidebar's own background, a layer of dots or lights. Keep what's drawn on the card itself
   (a border, an offset shadow).
2. Give what lies on the background Margin's text colours, or fills that suit it (translucent white over it, as the
   built-in themes do). Set them on the surfaces that lie on it, not on your root: menus and panels are drawn in the
   page's appearance, `prefers-color-scheme`. In Margin.app's window that is the background's (the window's web view
   takes the space's light or dark); in the extension's overlay over a browser's page, and on Windows for now, it is
   the system's, which can differ.
3. Anything solid that stands in for the ground (a sidebar out over the page as a card, a split's divider) takes
   `--m-bg`.

A theme that does nothing keeps its own look: its ground covers the background, all but the smoothing of the page
card's rounded corners, where a pixel's worth of the edge shows a little of it. Arcadia, Material, Liquid Glass,
Neubrutalism and Pixel take part; their `[m-background]` rules are a short example each. Liquid Glass shows the other
way: its colours are all `light-dark()`, so it sets `color-scheme` from `m-appearance` and its whole look follows.

## Motion

Animate `transform`, `translate`, `scale`, `rotate` and `opacity`: the browser moves those on its compositor, and
they stay smooth even on a busy machine. Animating `left`, `width`, `height`, `margin`, `padding` and the like (or
`transition: all`) makes the browser lay the theme out again on every frame, which drops frames. Colours and
shadows only repaint: fine on small elements.

`npm run theme:pack` lists the transitions and keyframes that animate layout, with their lines (it packs the theme
anyway). For a bar that grows, scale it from one end (`transform: scaleY(…)` with `transform-origin: bottom`, as
Pixel's playing bars do); for something that slides, `translate` it. Keep a `prefers-reduced-motion: reduce` rule
that stops what loops.

## The system's materials (Liquid Glass)

In Margin.app on macOS 26 and later a theme can put macOS's own materials
behind an element: the real Liquid Glass, drawn by the system (it bends and
blurs what's under it, and follows Reduce Transparency and the light and
dark modes by itself). No `backdrop-filter`: Margin's themes don't fake
glass. Liquid Glass (`liquid-glass/`) is the example.

1. Say so in `theme.json`: `"systemMaterials": true`. Margin.app then turns
   WebKit's system appearance on for its page while your theme is drawn.
   (It also turns it on for Margin's own Edit Theme Color panel while
   that's open, its glass; your theme's sheet is never read then, so
   without `systemMaterials` your theme never gets the materials.)
   That also changes two things in your theme: unstyled links take macOS's
   link colours, and in Dark Mode `color-scheme: light` is no longer
   honoured (use `light dark`, or `dark`).
2. Write the plain look first, then the material inside `@supports`. Every
   other browser (Chrome, Edge, Margin's pages in Safari, an older macOS)
   drops the property and reads only the plain look, so it must stand on
   its own:

```css
.panel { background: rgba(255, 255, 255, .6); box-shadow: 0 2px 7px rgba(0, 0, 0, .1); border-radius: 24px; }
@supports (-apple-visual-effect: -apple-system-glass-material) {
  .panel { background: none; box-shadow: none; overflow: hidden; -apple-visual-effect: -apple-system-glass-material; }
}
```

The values, and nothing else (no `var()`, one keyword): `none`,
`-apple-system-glass-material`, `-apple-system-glass-material-subdued`
(for glass inside glass), `-apple-system-blur-material` and its `-thin`,
`-ultra-thin`, `-thick` and `-chrome`, `-apple-system-vibrancy-label`,
`-apple-system-vibrancy-fill`.

What the glass needs (each seen off screen in a real web view,
`tools/glass-shots/`):

- **Nothing reaching past the element's box.** An outer `box-shadow`, an
  `outline` outside it or a child hanging out makes the glass grow to cover
  it all. So: `box-shadow: none` (the glass casts its own), `overflow:
  hidden`, focus rings inside (`outline-offset: -3px`). An inset shadow and
  a `background` over the glass (a tint) are fine.
- **One corner radius.** The first corner's is used for all four; `50%`
  gives a capsule, not an ellipse. `clip-path` is ignored.
- **A clipping ancestor** (`overflow: hidden`, a scrolling list) cuts the
  glass to what shows, as a smaller rounded shape.
- `transform`, `opacity`, a size that changes and elements that come and go
  all work; children are drawn over the glass; `visibility: hidden` hides it.
- **Few of them.** Each is a layer with a live picture of what's behind it:
  a panel, a few capsules, what floats. Never one per row.
- The glass is light or dark with the system, not with what's under it: give
  it a ground of the same mode.

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
  an address; functions from an allowlist; `-apple-visual-effect` only with
  one of the materials listed above.
- **A stylesheet writes no text**: `content` and `quotes` take only `""`
  (an empty box to decorate), no `var()` in them, counters and list markers
  only as numbers or symbols (no letters), no strings in `list-style`,
  `text-overflow`, `hyphenate-character` or `text-emphasis`. Its rules can
  reach Margin's own parts, so this is how they keep only Margin's words.
- **Margin's own words**: inside the `menu`, `menu-item`, `notice`,
  `prompt`, `space-editor` and `settings`
  parts, and the `<m-menu>`, `<m-notice>`, `<m-editor>`, `<m-prompt>`
  and `<m-settings>` slots, every
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

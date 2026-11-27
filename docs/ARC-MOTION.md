# Arc's motion and the UI Margin hasn't got yet (study, 2026-11-27)

Read from Arc 1.174.3's own binary (`Arc.app/Contents/MacOS/Arc`, arm64 slice, stripped) and checked on the real
screen. Nothing of Arc's goes into Margin: the numbers below are measurements, used to draw Margin's own motion.

## How it was read

- **Code**: `otool -tV` of the arm64 slice (14.2 M lines), its Objective-C selector stubs resolved (5,922 selectors,
  53,029 calls named) and its string literals resolved (93,829). Every call into SwiftUI's `Animation` constructors
  (434) and every `animationWithKeyPath:` (118) and `setDuration:` (167) site had the instructions before it emulated
  to read its constants. Each site is labelled by the Swift types whose metadata accessors lie nearest it (11,148 type
  descriptors parsed): a file-level label, not a symbol, so a label names the neighbourhood the code is in.
- **Field layouts**: `__swift5_fieldmd` parsed (8,776 types), which shows what each config struct holds.
- **Screen**: Arc full screen at 2x, recorded at 60 fps (`screencapture -v`), the pointer moved by CGEvent; only the
  sidebar's chrome touched (no typing, no tab changed, nothing deleted). Each motion fitted to a spring or a curve
  frame by frame.

## Arc's motion system

Arc has its own animation engine (`AnimationDriver`, `SpringAnimation`, `SpringFunction`, `DecayAnimation`,
`SettlingAnimation`, `ValueAnimation`) besides SwiftUI's and Core Animation's. A spring is `(response, dampingRatio)`;
`SpringFunction` turns it into stiffness, damping, ω₀ = 2π / response and ω_d.

**The seven presets** (`SpringAnimationStyle`, two tables in `__TEXT,__const`, four copies, in the enum's order):

| Style | Response (s) | Damping ratio | Overshoot |
|---|---|---|---|
| `firm` | 0.25 | 0.90 | 0.2% |
| `firmSlow` | 0.35 | 0.90 | 0.2% |
| `firmExtraSlow` | 1.25 | 0.90 | 0.2% |
| `firmFast` | 0.15 | 0.95 | 0% |
| `springy` | 0.28 | 0.63 | 7.8% |
| `springyFast` | 0.18 | 0.80 | 1.5% |
| `springyExtraFast` | 0.08 | 0.80 | 1.5% |

The same pairs recur in its SwiftUI code (`.spring(response: 0.25, dampingFraction: 0.9)` and the others), so they are
its house springs everywhere.

**Its timing curves** (`CAMediaTimingFunction` factories): easeOutCubic (0.215, 0.61, 0.355, 1), easeOutQuad (0.25,
0.46, 0.45, 0.94), easeOutQuint (0.22, 1, 0.36, 1), easeInOutQuad (0.455, 0.03, 0.515, 0.955), easeInQuad (0.55,
0.085, 0.68, 0.53), and three of its own: (0.5, 1.2, 0.5, 1) (a small overshoot), (0.68, 0, 0.22, 1), (0.25, 1, 0.25,
1). Its SwiftUI curves are mostly `timingCurve(0.25, 0.1, 0.25, 1)` (CSS `ease`) at 0.2 to 0.4 s.

**Reduced motion**: Arc has an `AnimationRespectingReduceMotionModifier` (what it does with it not observed).

## Measured on screen (2026-11-27)

| What | Arc | Arcadia now | Fit |
|---|---|---|---|
| The peek (sidebar hidden, pointer at the left edge), out | `springyFast` (0.18, 0.80) | response 205 ms, damping 0.79, `linear()` over 279 ms | 0.83 px RMS over 12 frames (free fit: 0.175 s, 0.80) |
| The peek, back in | `springyFast`, the same spring | `transform 180ms var(--ease)` | 1.7 px RMS |
| Switching spaces (a dock click) | a settle from a fast start, not one of the presets (`SettlingAnimation`/paging) | response 130 ms, damping 1.35, initial velocity | Arcadia's curve within 4.5 px RMS: already right |
| The "+" popover (`ArcMenu`), open | from 0.95 to 1 about its arrow, transform 100 ms easeOutCubic, opacity 0 to 1 in 50 ms easeOutCubic | none (at once) | code, seen frame by frame |
| The "+" popover, close | transform 70 ms easeOutCubic, its opacity out in about 50 ms | none | code; three frames on screen |
| The space's ••• menu and right-click menus | macOS's own `NSMenu`: at once in, a fade of about 117 ms out | Margin's own menu: at once both ways | screen |

The space's ••• menu in Arc: Change Space Icon…, Rename Space…, Edit Theme Color…, Set Profile ▸, New Folder, Live
Folders ▸, Share Space…, Export "Work" into Folder ▸, Manage Spaces…, Delete Space.

## Read from the code (not yet checked on screen)

Labelled by the code's neighbourhood (see "How it was read").

| What | Arc | Arcadia now |
|---|---|---|
| The dock's item transform (the hover swap) | 130 ms easeOutCubic, fill forwards (`SidebarDockItemView`) | 230 ms ease-in-out |
| The dock's layout change (icons ↔ dots) | 160 ms easeOut (`SidebarDockView`) | at once |
| The tooltip window | opacity in 50 ms easeOut (`TooltipWindowController`) after its delay | `visibility` after 470 ms, no fade |
| Section headers, the Today divider | 100 ms easeOut, 70 ms (`SidebarSectionHeaderView`, `UnpinnedSectionDividerCellView`) | at once |
| "↓ Clear" | 175 ms (`SidebarClearButton`) | at once |
| The sidebar's rows in its tree (insert, remove, move) | 120 ms (`OutlineViewDiffableDataSource`) | Arc's folder curves (210 / 250 ms), measured on folders |
| A tab row's hover subtitle | 180 ms (`HoverSubtitleState`) | none |
| A sidebar cell's shadow | 100 ms easeOut (`SidebarCellButton`) | none |
| The sidebar's scroll edges (gradient) | locations and colours 100 ms (`SidebarViewController`) | none |
| The sidebar's resize indicator | 200 ms; 80 ms easeOutCubic | 150 ms opacity |
| The hover card (a link's or tab's card) | its window 150 ms (`HoverCardsController`); its content spring (0.4, 0.75) | its link preview card 150 ms |
| The split view: a drop target / its handle | 200 ms easeOut / 160 ms | — |
| Modals | 300 ms easeOut; their controls `spring(0.28, 0.63)` (`springy`) | — |
| Tidy Tabs' button | CASpringAnimation mass 1.5, stiffness 150, damping 15, velocity 8 | — |
| Buttons | hover scale `spring(0.18, 0.8)` (`springyFast`, `ScaleHoverEffect`); press `spring(0.2, 0.4, blend 0.5)` (`ScaleButtonStyle`); back/forward 300 ms ease | tabs 0.98 on press, 100 ms |
| The media mini player | `spring(0.25, 0.9)` (`firm`); its scrubber and corner buttons 200 to 300 ms ease | — |
| Toasts | `spring(0.4, 0.7, blend 0.1)` (`ToastAnimator`) | — |
| The sidebar banner | `spring(0.6, 0.4)`, `interpolatingSpring(mass 2, stiffness 200, damping 20, velocity 1)` | — |
| Little Arc | `spring(0.28, 0.63)` (`springy`); its window opening `WindowExpansionAnimator` (response, ratio) | — |
| Space creation | `spring(0.8, 1)`; its buttons `spring(0.15, 0.95)` (`firmFast`) | — |
| The command bar's placeholder | `spring(0.2, 1)`; another read as `spring(1.4, 0)` | — |

## Arc's UI that Margin hasn't got (from its types and strings)

Margin already has (Arcadia): the page card, rows, folders and their morph, the space switcher and its tooltip, the
Library and its icons, Create a Space, "+" and its popover, the media player, favorites, the archive, split view,
drags, the peek, the page loader.

Not yet, in the sidebar:
- **The ↑ / ↓ over the list** when it's scrolled away from its top or bottom (`TablistOverflowIndicatorView`, its
  spring (0.15, 0.95) = `firmFast`, an `interpolatingSpring(1, 350, 25, 10)` bounce).
- **Collapse pinned tabs** (the title row's chevron; `CollapsedPinnedSection`; inert in Arcadia).
- **Site controls** (`SiteControlCenter`; inert in Arcadia).
- **Live subtitles and unread badges on pinned tabs** ("Unread Emails" under Gmail; `SidebarItemUnreadBadgeView`,
  `LiveItem`, Slack/Gmail/GitHub/Calendar).
- **Back to the tab a link came from** (`BackToTabButton`).
- **Tidy Tabs** (AI titles and grouping) and **auto-archive's education** (`AutoArchiveEducationView`).
- **The download progress badge** on the Library button (`DownloadProgressBadge`), the download bin (`DownloadBin`,
  `spring(1.2, 1)` then `spring(0.3, 1)`).
- **Sidebar banners and cards** (update, new icon unlocked).
- **Sound effects** (`SoundEffects`), **confetti** (`ConfettiView`).

Elsewhere: Little Arc, Peek of a link (`EmailPeeking`, `PeekState`), Capture, Boosts, Ask Arc, Instant Links, Live
Folders (GitHub PRs and others), hover cards, toasts, the glowing page-load indicator
(`GlowProgressLoadingIndicator`).

## The next changes this suggests for Arcadia (in order of what's seen most)

1. The peek on `springyFast` both ways (one `linear()` from (0.18, 0.80)).
2. The "+" popover: in from 0.95 about its arrow, 100 ms easeOutCubic with opacity in 50 ms; out in 70 ms.
3. The dock's swap: 130 ms easeOutCubic (`cubic-bezier(0.215, 0.61, 0.355, 1)`); its layout change 160 ms easeOut.
4. The tooltip: a 50 ms fade after its delay.
5. Margin's menus: a ~120 ms fade out (as macOS's), in at once.
6. "↓ Clear" 175 ms and the Today divider 100 ms easeOut, as fades.
7. The ↑ / ↓ scroll indicator (a behaviour: CSS can't know the list is scrolled).
8. To measure: a tab's close and a new tab's arrival (the tree's 120 ms against the folder curves Arcadia uses), a
   drag's lift and drop.

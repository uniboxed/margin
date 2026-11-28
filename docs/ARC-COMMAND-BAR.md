# Arc's command bar: what it is, measured and read (spec for Margin's palette)

Arc's command bar (⌘T, "Search or Enter URL…"), studied on 2026-11-27 so Margin's palette can work and look as it does,
with Margin's own code: Arc's names, numbers and behaviour are references only, nothing of Arc's is copied. Two
sources, each marked: **seen on screen** (Arc 1.174.0 on a 1512 × 982 pt display, macOS in dark mode, its window
1512 × 949 below the menu bar; Arc driven by synthetic key presses and clicks on its own chrome, frames measured from
2× captures) and **read from Arc's code** (the arm64 slice of Arc 1.174.0, statically; Part 2). Where the two differ, the
screen wins (the code's numbers are unnamed constants).

## Part 1: seen on screen

### Place and size
| Part | Arc |
|---|---|
| Horizontal | centred on the window (its middle at x 756 of 1512) |
| Vertical | **top at 32.2% of the window's height** (305.5 of 949 pt), growing down with its rows: not centred (Margin's earlier note "Arc measured: centred on the window, top 32.25vh" agrees) |
| Width | **766 pt** in a 1512 pt window (one window size measured: fixed or a share of the window is open; the code has a 720 constant, read as a maximum, which the screen contradicts) |
| Corner radius | about 12–14 pt (the code: the window's content corner radius, the page card's) |
| Edge | a 0.5 pt near-black line outside (4,3,3), a 1 pt lighter line inside it (114,108,105) |
| Fill (dark mode) | a dark warm grey (61,53,47); the code has light and dark colours for everything, so light mode is light |
| Shadow | large and soft round the panel |
| Height | fits its rows: the header alone with none (site search before typing), one row more per row; 5 rows seen at most |

### Header and rows
| Part | Arc |
|---|---|
| Header | about 64 pt (the edge to the divider): the leading icon (a magnifier, or the selected row's icon), then the field; the caret system blue; the text starting about 54 pt from the panel's left edge |
| Divider | 0.5 pt (85,78,74), under the header; the rows start 6 pt below it |
| Row | **46 pt tall, 4 pt between rows**, about 10 pt in from the panel's sides (744 pt wide in a 766 pt panel); corner radius 4 (code) |
| Bottom | about 10 pt under the last row |
| Selected row | filled with the space's colour (a rose space: 168,91,121), its text white; in site search, the site's brand colour (YouTube red) |
| Row parts | icon · title · " — " and a grey subtitle (a site's domain or a page's address) · on the right a pill (a favourite's space, "Personal"; an open tab, "Switch to Tab") and a square arrow button (white on the selected row) |

### Behaviour
- **Empty ⌘T**: the favourites (GitHub, YouTube, Gmail, Disney+), each with its space and the arrow, then "Contact the Team". The sidebar shows a "New Tab" row as the selected one while it's open.
- **Typing "weath"**: 1. Weather.com — weather.com (the top site, selected); 2. "weath" (search what's typed); 3. National Weather Service — weather.gov; 4–5. "weather nyc", "weather nj" (the engine's suggestions). No section headings.
- **Inline completion**: the field shows what's typed and, selected after it, the rest of the selected row's text ("weath|er.com"); the field's icon is the selected row's (the site's icon, the magnifier for a search). ↑/↓ move the selection and rewrite both: a site row completes its domain ("er.gov"), a suggestion its words ("er nyc"), the plain search shows only what's typed.
- **An open tab typed by its title** ("sfd" → "sfdfd"): first, "Switch to Tab" and the arrow on the right; its title isn't completed into the field (the field's icon a globe).
- **Typing a site's name** ("youtu"): the field completes "youtube.com" and shows, on its right, "Search YouTube" and a "Tab" key cap. Rows: the site, the search, then that site's pages from history (title — address).
- **Site search**: Tab puts a pill in the site's brand colour ("YouTube", red) at the start of the field, the placeholder "Search…", and empties the list (the panel shrinks to the header). Typing shows one row, the query, selected in the site's colour (no suggestions there).
- **Escape** closes the bar at once, even with text typed. A click outside it closes it.
- **Motion: none.** It appears and goes between two frames (no fade, no scale); the selection moves at once.

## Part 2: read from Arc's code

### How it was read (method, so every claim can be re-checked)

- **Types and fields**: `__swift5_types` (11,131 descriptors) and `__swift5_fieldmd` parsed by a small script
  (`swifttypes.py` → `types.json`, CommandBar/ASE2 listings in `cmdbar_types.txt`, `ase2_types.txt`, `other_cb_types.txt`).
  Field types are shown in raw mangled form with symbolic refs resolved (`SS` = String, `Sb` = Bool, `Si` = Int, `Sd` = Double, `Sg` = Optional).
- **Code**: `llvm-objdump --macho -d` of the whole slice (`all.asm`, 14.2 M lines). ObjC selector stubs resolved from `__objc_stubs`
  (5,922). A constant emulator (`annotate.py` → `calls.txt`, 1.61 M calls) records the integer/double register values and decoded Swift
  strings at every call. A string scanner (`strscan.py` → `codestrings.txt`, 45k literals) recovers Swift small strings (≤15 bytes,
  built with `mov/movk`) and literal strings in code order. Each address is labelled with the nearest preceding Swift type metadata
  accessor (`accessors.json`): a neighbourhood label, not a symbol (same method as docs/ARC-MOTION.md).
- **Resources**: `ARC_CommandBar.bundle` (`command_bar_behavior.json`, `Assets.car`), `ARC_URLInputter.bundle`, `ARC_TopDomains.bundle`,
  `Base.lproj/MainMenu.nib` (decoded with a NIBArchive parser, `nib.py` → `menu.json`, `commands.md`).
- Arc was not launched, clicked or typed into. Nothing below was seen on screen: everything is static. Marked **(inferred)** where the
  meaning comes from names/neighbourhood rather than decoded control flow.

(The working files of that reading — the type dump, the disassembly, the call table — stay outside the repository.)

---

### 1. Structure

The command bar is its own Swift module **`CommandBar`** (source paths `Frameworks/ARC/Sources/CommandBar/{Store,Instance,Suggestions,UI_macOS}/…`),
written in **The Composable Architecture** (TCA: `ComposableArchitecture.Store/ViewStore`, `Dependencies`), with **AppKit** views
(NSTableView rows, NSTextField) and a few SwiftUI islands (banners). Ranking lives in a separate engine module **`ASE2`**
("autocomplete/search engine", bundle id string `company.thebrowser.ase2.client`), fed by providers in **`SearchClientManager`**;
commands come from **`TypeTravel`** (Arc's internal name for "type to run an action"). Placement inside the window is in the app module
(`Arc.WindowViewController`, `WindowState+CommandBarHelpers.swift`, `WindowState+CommandBarPlaceholder.swift`).

#### Store (TCA)
- `CommandBar.CommandBar` (reducer). Dependencies: `analyticsClient`, `adkClient: SearchEngineClient`, `searchClient: SearchClient`,
  `commandBarInteractionPerformanceTracker`, `aseConfigurationClient`; `delegatePassthrough` (Combine subject of `CommandBarDelegateAction`).
- `CommandBarState`: `inputs`, `destinationType`, `displayInfo`, `query`, `searchOutput?`, `pendingSelection?`, `instanceID`, `windowID`,
  `isFirstSearchOfVisibleLifecycle`, `scopedSearchType?`, `scopedSearchColor?`, `postScopedSearchRestoration`, `activeSearchEngines`
  (OrderedDictionary String→SearchEngine), `siteSearchSpaceTriggerEnabled`, `pendingWindowContent?`, `entryPoint`,
  `currentHighlightedResultIndex?`, `shouldDisplayCloseAccessory`, `searchSuggestionPrivacyState`, `featureFlags`.
- `CommandBar.Action` (every input the bar handles): `updateQuery(query, didBackspace)`, `updateSearchOutput`, `_onSelectSuggestion(index, flags)`,
  `_onKeyboardReturn(selectedItemIndex, flags, selectionPerformanceTrackingID?)`, `onAttemptToCopyCommandBarText(selectedText)`,
  `onCopyCurrentSuggestionURLShortcut`, `onTabKeyPressed(index)`, `onBackspacePressed(isCursorAtStart)`, `onDeleteSuggestion(sourceInfo)`,
  `onDidClickDefaultBrowserPromptButton`, `siteSearch(SiteSearch)`, `onHighlightedResultIndexChanged(Int?)`, `searchSuggestionsPrivacy`,
  `addSearchEngine(SearchEngine)`, `onInputsUpdated`, `onKeyboardUp/Down/Left/Right`, `onTrailingAccessoryPressed`, `onEscapePressed`,
  `onRequestClose`, `onDidClickDismissDefaultBrowserPrompt`, `onASEConfigurationUpdated`, `setup`, `teardown`, `platform`.
- `CommandBar.Action.SiteSearch`: `change(to: SearchEngine)`, `loadedSiteSearchDominantColor(NSColor, isFromAutoActivatedList)`, `removeCurrent`,
  `learnMore`, `manage`, `didRestoreQuery`, `reloadActiveEnginesAndPreferences`.
- `CommandBarDelegateAction` (out to the window): `onDidSelectSuggestion(suggestion, flags, metadata)`, `onDidAttemptToCopyCommandBarText`,
  `onDidCopyCurrentSuggestionURLShortcut`, `onDidUpdateObservableOutputs`, `onDidReturn`, `onDidRequestClose`,
  `onDidRequestSearchSuggestionsPrivacySettings`, `onDidSelectSiteSearchManageSettings`, `onDidSelectSiteSearchLearnMore`,
  `onKeyboardUp/Down`, default-browser prompt clicks.
- `CommandBarSelectionOptions.Action` (what a selection does): `navigateToURL(url)`, `openURL(url, disposition?, insertionStrategy?, presetTabID?,
  targetWebContentFrameIdentifier?)`, `openBrowseForMe(query, …)`, `openBrowseForMePip(query)`, `openTab(tabID, disposition)`,
  `executeTypeTravel(candidate, context)`, `executeInstantLinksQuery`, `executeInstantLinksIntentQuery`; plus `shouldDismissCommandBar`.
- `CommandBarSelectionFlags { rawValue: Int }` (OptionSet: the modifier keys at selection; bit meanings not decoded).
- `CommandBarSelectionMetadata`: `query`, `entryPoint`, `scopedSearchType?`, `selectionIndex`, `suggestionCount?`.
- `TypeLetterInCommandBarStateMachine` (`noTypingInProgress` ⇄ `letterTyped`, events `newLetterTyped`, `allResultsCollected`): performance
  tracing of "first character → results" only.
- `CommandBarRemoteConfiguration { dedupByTitleAndHostList: Set<String> }`, fetched as `command_bar_behavior` (`.json`, host string
  `resources.arc.net` beside it) with the bundled default in `ARC_CommandBar.bundle/…/command_bar_behavior.json`:
  `figma.com, maps.google.com, notion.so, app.notion.com, zoom.us, opentable.com, zillow.com, github.com, app.mode.com,
  console.cloud.google.com` — sites whose history rows are de-duplicated by **title + host** instead of URL.

#### Instances and integration
- `CommandBarIntegrationClient { setup, addInstance(config), removeInstance(id), instance(id), allInstances }`: one bar **instance per window**
  (`CommandBarInstanceID(rawValue: String)`, `StandardCommandBarInstance`, `NoopCommandBarInstance`).
- `CommandBarInstanceConfiguration`: `instanceID`, `windowID`, `destinationType`, `displayInfo`, `query` (prefill), `scopedSearchType?`,
  `scopedSearchColor?`, `entryPoint`, `activeSearchEngines`, `siteSearchSpaceTriggerEnabled`, `shouldDisplayCloseAccessory`,
  `searchSuggestionPrivacyBannerHasBeenExplicitlyDismissed`, `initialInputs`, `featureFlags`.
- `CommandBarDisplayInfo { showSuggestions, showInCenter, switchToTabAllowed, beginEditPolicy }`.
- `CommandBarDestinationType`: `overrideCurrentTab(showCurrentURL: Bool)`, `createNewTab`, `noop`.
- `BaseModels.CommandBarEditPolicy`: `at(position)`, `selection(range)`, `selectAll`, `beginningOfLine`, `endOfLine`.
- `CommandBarPresentation`: `activeNoQuery`, `activeWithQuery`. `CommandBarObservableOutputs { presentation, isInScopedSearch, hasSuggestions }`.
- `CommandBarState.EntryPoint`: `appMenu(newTab | addressBar | commandBar)`, `contentPanel(id)`, `placeholderClick`, `newStandardWindowOpen`,
  `newLittleWindowOpen`, `topBarURL`, `sidebarNewTabButton`, `sidebarPlusButton`, `sidebarDoubleClick`, `keyboardShortcutT`,
  `keyboardShortcutL`, `keyboardShortcutCommandOptionG`, `keyboardShortcutFocusSidebar`, `toggleBetweenTypeTravelAndCommandBar`,
  `littleArcPlaceholderClick`, `splitViewPaneCreated`.

#### View model
- `CommandBarViewState`: `query`, `destination`, `presentation`, `suggestionsOutput?`, `initialInput`, `currentHighlightedResultIndex?`,
  `beginEditPolicy`, `windowID`, `isCentered`, `borderDisplayType? (keyboardHighlight)`, `trailingAccessoryType?`, `tidyTabTitles`,
  `searchSuggestionPrivacyBannerIsVisible`, `semanticColorPalette`, `primaryColorPalette` (the window theme), `isFirstSearchOfVisibleLifecycle`,
  `browserContextID`, `appearance`, `typeTravelContext`, `postScopedSearchQuery?`, `scopedSearchViewState?`, `isContentPanelThemed`,
  `cornerRadius`, `allowTextBasedSizing`, `currentSecureContext?`, `newDefaultBrowserPromptType?`, `useResetInsteadOfDiffingForSuggestions`,
  `scrollViewEnabled`.
- `SuggestionViewState` (one row): `dedupKey: ASE2.DedupKey`, `index`, `data: ASE2.Archetype`, `sourceInfo`, `title: .string | .attributedString`,
  `iconsInfo { icons: [IconSource(.image | .faviconCache(url) | .globalFavicon(url))], layoutOrientation: .horizontal | .vertical }`,
  `score: Double`, `leadingAccessory? (.icon(NSImage))`, `trailingAccessory? (.tab(text) | .arrow(text) | .delete)`, `aseDebugInfo?`,
  `isCentered`, `isContentPanel`.
- `SuggestionsOutputViewState { query, suggestions: IdentifiedArray<DedupKey, SuggestionViewState> }` (rows keyed by dedup key → diffable).
- `CommandBarAutocompleteSuggestion { query, autocompleteString?, iconType, faviconURL?, highlightedIndex, archetype?, iconColor }` — the
  inline-completion model (see §2).
- `TrailingAccessoryType` (in the input): `scopedSearch(scopeName, spaceTriggerEnabled)`, `cancel`, `tabToGoBack`, `searchPrivacyInfo`.

#### AppKit views (`UI_macOS`)
| Type | Super | Holds |
|---|---|---|
| `CommandBarContainer` | NSView | `commandBarView`, `stackView`, `spacerView`, `heightConstraint`, `stackViewBottomConstraint`, a SwiftUI `SplashView` (blur radius + opacity, `splashColor`) |
| `CommandBarView` | NSView | `textView: CommandBarInputContainer`, `suggestionsView`, `hairlineBorderView` (+ leading/trailing/height constraints), `stackView`, `backgroundView: ARCUI.PopoverBackgroundView`, `contentPanelInputHeightConstraint`, `inputFieldFullHeightConstraints` |
| `CommandBarInputContainer` | ARCUI.HoverableView | `textField: CommandBarTextField`, `iconView` (+ size constraints, `iconPositionConstraintForDevTheme`), `scopedSearchPillView`, `trailingAccessoryView`, `commandBarUndoManager`, `inputDataSource` (a `DISPATCH_SOURCE_DATA_REPLACE` coalescing keystrokes), `latestInputAndDidBackspace`, `localEventMonitor`, `highlightedSuggestionIndex`, `isBackspacingStatus (no/pending/yes)` |
| `CommandBarTextField` | ARCUI.CustomSelectionColorTextField | `shouldIntrinsicContentSizeHugText`, `isMultiline`, `beginEditPolicy` |
| `CommandBarInputScopedSearchPillView` | NSView | `titleView`, `theme.focusColor`, `menuProvider` (its right-click menu) |
| `ScopedSearchTrailingAccessoryView` | SwiftUI | `text`, `spaceTriggerEnabled`, `triggerKeyPadding` ("Tab" / "Space or Tab" hint) |
| `SuggestionsView` | ARCUI.FlippedView | `tableView`, `scrollView`, `searchPrivacyView`, `defaultBrowserPromptView`, `suggestions`, palettes for rows |
| `CommandBarSuggestionRowView` | NSTableRowView | `selectionHighlightLayer: CALayer`, `isHovered`, tracking area, `theme { selectedColor, hoveredColor }` |
| `DefaultSuggestionView` | NSTableCellView | `iconContainerView`, `titleStackView: DefaultSuggestionTitleView (title + subtitle)`, leading/trailing accessory containers, `onDeleteSuggestion`, `onTrailingAccessoryPressed` |
| `DefaultSuggestionIconContainerView` | NSView | single icon or a SwiftUI "tray" stack of several icons (`IconStackView`, AppTray layout) |
| `SuggestionArrowAndLabelView` / `SuggestionArrowView` | NSStackView / NSView | the "→ Switch to Tab" style trailing arrow + label |
| `SuggestionPillView`, `ColorizedIconContainerView` | NSView | the capsule ("Personal ›", space/folder chips) with prefix title, title, coloured icon |
| `SuggestionInstantLinksView`, `KeyboardShortcutView` | NSStackView / NSView | "Instant Open" hint with a keycap |
| `TypeTravelSuggestionTableViewCell` / `TypeTravelSuggestionView` | NSTableCellView / NSView | command rows: icon in a rounded background, title items (text + capsules), keyboard shortcut keycap, optional pill |
| `SearchSuggestionsPrivacyView`, `DefaultBrowserPromptView` | NSView + SwiftUI | banners under the rows |
| `CommandBarDebugView` / `…WindowController` | — | internal ranking debug window ("Command Bar Ranking Configuration") |

---

### 2. Result kinds, sources, ranking, ordering

**There are no sections.** The bar is one flat ranked list (`SearchOutput { query, maxCountToDisplay, suggestions: [ASE2.Suggestion] }`,
one `NSTableView` column, `setHeaderView: nil`, no group rows found in `SuggestionsView`). Grouping is visual only (icon, subtitle,
trailing accessory). The single exception is **scoped search** (`ASE2.ScopedSearchType`: `siteSearch(SearchEngine)` or `typeTravel`, the
latter titled **"Actions"** — "title for scoped search of browser actions in Arc").

#### Sources (`ASE2.SourceType`, one provider each in `SearchClientManager`)
`sidebar` (tabs, pinned, favorites, folders — `SidebarCandidatesProvider`, per-window and global caches), `chromium`
(`ChromiumCandidatesProvider`: Chromium's omnibox), `topDomains` (`TopDomainsCandidatesProvider`, 458 bundled domains in
`TopDomains.json`, e.g. google.com "Google", youtube.com "YouTube"), `searchOrNavigateWhatYouTyped`, `documents` (Google Docs etc.),
`easels`, `typeTravel` (commands), `askGPT`, `instantLinks`, `recentAssistantQueries`, `onboardingSuggestions`
(+ analytics names `staticQuerySuggestions`, `memorySearch`). Each source has a timeout (`ASE2.Input.timeoutValue` ms → Combine
`.timeout`; log "Received a timeout from source:' … ' for query length:").

#### Row kinds (`ASE2.Archetype`)
| Archetype | Payload | What it is |
|---|---|---|
| `navigateWhatYouTyped(url)` | URL | "go to what you typed" (debug name "Navigate What You Typed") |
| `searchWhatYouTyped(search)` | String | search the default engine |
| `askGPTWhatYouTyped(message)` | String | "Ask ChatGPT" row (caption "Ask ChatGPT"), Arc Max only |
| `tab(TabInfo)` | tabID, url, originalURL?, title?, customTitle?, isVisible?, savedContext? (`global` = favorites / `scoped` = pinned in a space), containerID? (space) | open/pinned tab → **"Switch to Tab"** (caption "for switch-to-tab results that do not change spaces"), **"Switch to Split View"** when the tab is in a split |
| `document(DocumentInfo)` | documentID, url, title, isOwned, sidebarItemID?, savedContext? | Arc Notes / web docs |
| `easel(EaselInfo)` | easelID, url, title, sidebarItemID?, savedContext? | Easels |
| `typeTravel(TypeTravelCandidate)` | see §"Every feature" | a command |
| `topDomain(TopDomainInfo)` | url, siteName | a well-known site |
| `instantLinks(query)` | — | "Instant Open" (Arc Max) |
| `askAssistant(query)`, `assistantHistory(query, supertabSessionID…)` | — | assistant rows |
| `chromiumArchetype(ChromiumArchetype)` | — | everything Chromium's omnibox returns: |

`ChromiumArchetype`: `chromiumSearchWhatYouTyped(query,url)`, `chromiumNavigateWhatYouTyped(title,url)`, **`chromiumSearchSuggestion(query,url)`**
(search-engine suggestions), **`chromiumSearchHistory(query,url)`** (past searches), **`chromiumNavigateSuggestion(title,url)`**,
**`chromiumHistory(title,url)`**, **`chromiumSearchOtherEngine(title,url)`** (keyword engine), **`chromiumSearchCalculatorAnswer(query, answer, url)`**
(calculator), **`chromiumBookmark(title,url)`**.

Selection analytics add more kinds that the bar can show (`AnalyticsEventProperties.CommandBarItemType`): `list`, `project`, `file`,
`newV1Boost`, `browseForMe` ("Browse for Me"), `sendCurrentTabToDia`, `extensionOmnibox` (an extension's omnibox keyword),
`onboardingSuggestion`.

#### Dedup (`ASE2.DedupKey`)
`search(String)`, `normalizedHumanReadableURL(String)`, `titleAndHost(title, host)` (hosts in `dedupByTitleAndHostList`), `tab(id)`,
`document(id)`, `easel(id)`, `project(id)`, `typeTravel(id)`, `custom(String)`. Rows are an `IdentifiedArray` keyed by this.

#### Scoring (ASE2) — a weighted linear model with normalised features and boosts
- Every candidate gets `featureScores: [Feature: Double]` (`ASE2.Candidate`). Features: `archetype`, `urlMatchScore`, `urlMatchPosition`,
  `urlMatchPercentage`, `titleMatchScore`, `titleMatchPosition`, `titleMatchPercentage`, `hotWordsMatchScore/Position/Percentage`
  (hot words = command trigger phrases), `fuzzySearchConfidence`, `lastNavigated`, `frequencyEver`, `typedCountEver`, `mostVisitedRank`,
  `siteEngagementScore` (Chromium's), `globalSiteRank`, `typeTravelCandidateBump`, `chromiumRank`, `chromiumRelevanceScore`, `saveLevel`.
- Features are z-normalised per query (`ASE2.Normalizer.dataByFeature: [Feature: (mean, standardDeviation)]`, assertion "Should not calculate
  normalization info for empty array"), grouped into **categories** `archetype | match | importance | recency | chromium | save`, each a
  `ConfigurationSection { weight, items }`; `ScoreAndWeights.generateScore()` sums score × weight ("Unexpectedly received 0 total weight").
- `ArchetypeConfiguration` gives each kind a prior: `searchAutocomplete, tab, list, project, navigateWhatYouTyped, searchWhatYouTyped,
  askGPTWhatYouTyped, document, easel, typeTravel, topDomains, scopedSearch, please, instantLinks, memoryStore, askAssistant,
  assistantHistory`, and the nine Chromium kinds.
- **Boosts** (`ASE2.Boost`, each `{weight, score}`): `exactBaseDomain`, `exactURL`, `exactHotWord`, `baseDomain`, `autocompleteDefault`,
  `autocompleteSearchOnly`, `chromiumSpecialSearchFunction`, `customTitlePrefix` (tab renamed by the user), `veryRecentTabOrDocumentBoost`,
  `topApp` (favorites), `recentlyUseTypeTravel`, `typeTravelPrefixForLongQuery`, `unboxingPromotedAction`, `highFuzzySearchConfidence`.
- Personalisation (`AdditionalFeatureInfo`, persisted as `StorableCommandBarAdditionalRanking.json`): `mostVisitedRank`,
  `siteEngagementScores`, `recentlySwitchedToTabs` (a capped stack per tab), **`queriesToSelectedArchetypes`** (query → what you picked
  last time, with date: Arc learns "typing *gi* means GitHub"), `typeTravelUsage` (executed times + frequency per command),
  `currentItemInfo` (the current tab; `derankCurrentItemURLEnabled` pushes the page you're on down), `menuItemIDsToBoost`.
- Caps: `ASE2.Input.maxSuggestions`, `PreferredMaxRankConfig` (an optional max **rank** per kind: tab, list, project, document, easel,
  typeTravel, topDomain, please, navigateWhatYouTyped, searchWhatYouTyped, askGPTWhatYouTyped, instantLinks, memoryStore, askAssistant,
  assistantHistory, and the Chromium kinds), `TypeTravelContext.limit`, `SearchOutput.maxCountToDisplay`.
- The weights themselves are **not in the binary**: `ASE2.Configuration` (0x1A0 bytes = 51 doubles + the boosts array) is decoded from
  a stored/remote JSON (`StorableASEConfiguration { version, configuration }`, `ASEConfigurationClient.configurationStream`) and editable in
  the internal "Command Bar Ranking Configuration" window ("Reset to Default"). **Open**: the default numbers.
- Matching: tokenised + fuzzy (`ARCFoundationBase.TokenizedTextMatchingInfo`, `fuzzyMatchScoreCache`, `CacheMatchScoreKey`), against
  `SearchableProperty`: `humanReadableURL`, `title`, `hotWords` (command triggers). Commands match on `TypeTravelSearchableProperty`:
  `target(key, lowercaseQuery)` and `action(key, lowercaseQuery)` (e.g. "move … to *Work*": action words + target names), with
  `minQueryLengthForMatch` per command.

#### Inline completion (inferred from types)
`CommandBarAutocompleteSuggestion { query, autocompleteString?, highlightedIndex, iconType, faviconURL?, archetype?, iconColor }` and the
`autocompleteDefault` / `autocompleteSearchOnly` boosts: the top row's completion is written into the field after the typed text (selected),
with that row's icon in the field's icon slot (`CommandBarInputContainer.iconView`). `BackspacingStatus (no / pending / yes)` +
`updateQuery(didBackspace:)`: after a backspace the completion is not re-applied (as in browsers). **Screen**: confirm the look.

#### Empty query
`CommandBarPresentation.activeNoQuery` vs `activeWithQuery`. `SearchNullStateProvider` supplies the null-state rows (titles from comments:
"Null state Help Center suggestion" → **Help Center** `https://resources.arc.net`, "Null state sidebar organization suggestion" →
**Tips for Organizing** (resources.arc.net Features), "Null state Air Traffic Control suggestion" (Spaces article), "Null state BCNY YouTube
channel" → youtube.com/c/TheBrowserCompany, and `contactTheTeam`) — onboarding rows for new users (inferred). `CommandBarDisplayInfo.showSuggestions`
can hide rows entirely. **Screen**: what a seasoned profile shows on an empty ⌘T (probably no rows, or recent tabs).

---

### 3. Search suggestions

- Suggestions come from **Chromium's omnibox** inside Arc (ArcCore.framework = Chromium; `ChromiumCandidatesProvider`, archetype
  `chromiumSearchSuggestion`), so the endpoint is the **default search engine's suggest URL** as Chromium defines it (for Google
  `https://www.google.com/complete/search?q=` appears in the binary). Arc itself does not call a suggest API.
- Default engine: Chromium's search-engine settings (`arc://settings/searchEngines`, typeTravel command "Search Settings"; triggers
  "search engines", "site search", "domain search"). Engines are `BaseModels.SearchEngine { name, keyword, status (active / inactive / unspecified),
  isPrepopulated, searchURLTemplate, faviconURL? }`, `SearchTermsWildCard (escaped / unescaped)` for `%s`.
- Privacy banner under the rows the first time: "We talk to your search engine to help us suggest results." + "Learn more about your data on
  Arc **here**", buttons to General settings and **Dismiss** (permanent, `commandBarSearchSuggestionsPrivacyHasBeenExplicitlyDismissed`).
- Debounce: keystrokes are coalesced by a GCD `DISPATCH_SOURCE_TYPE_DATA_REPLACE` source in `CommandBarInputContainer` (`inputDataSource`)
  — the latest text wins on the next main-queue turn, no fixed delay found (inferred). `UpdateQueryID` is a TCA cancel ID (each new query
  cancels the previous search). A `.milliseconds(30)` scheduler stride is used in `CommandBarContainer.swift` (0x10222fa80; purpose not
  decoded). Per-source timeouts come from `Input.timeoutValue`.
- Count: not fixed in code that I could decode; caps come from the remote ASE config (`maxSuggestions`, `PreferredMaxRankConfig`). Constant
  tables near `CommandBar.SuggestionConstants.MaxSuggestions` hold the integers **1, 4, 4, 1, 5, 3, 3, 3** (0x103847c68…c90) and doubles
  64, 50, 3, 8, 14, 24, 30, 12, 4, 480, 300, 2, 4, 280, 750, 15, 5, 100 — names stripped, so which cap is which is **open** (inferred: max
  rows per kind).

---

### 4. Keyboard

`CommandBarInputContainer` implements `control:textView:doCommandBySelector:` (selector refs in order at 0x10224a1f8–0x10224a8b8) plus
`performKeyEquivalent:` and a local `NSEvent` monitor:

| Key | Selector | Effect (from the action it sends) |
|---|---|---|
| ↑ / ↓ | `moveUp:` / `moveDown:` | move the highlighted row (`SuggestionsView` select previous/next, `onKeyboardUp/Down`, `onHighlightedResultIndexChanged`) |
| ← / → | `moveLeft:` / `moveRight:` | `onKeyboardLeft/Right` (accept inline completion / caret; inferred) |
| ⏎ | `insertNewline:` | `_onKeyboardReturn(selectedItemIndex, flags)` — flags from `NSApp.currentEvent.modifierFlags` |
| ⌥⏎ | `insertNewlineIgnoringFieldEditor:` | same path with the Option flag |
| ⎋ | `cancelOperation:` | `onEscapePressed` (leave site search first, else close; inferred from `postScopedSearchRestoration`) |
| ⌫, ⌥⌫, decomposing ⌫ | `deleteBackward:`, `deleteWordBackward:`, `deleteBackwardByDecomposingPreviousCharacter:` | `onBackspacePressed(isCursorAtStart)` — ⌫ at the start of the field leaves site search (restores `queryBeforeEnteringScopedSearch`) |
| ⇥ | `insertTab:` | `onTabKeyPressed(index)`: enter site search on a site row ("Hint for using the Tab key to enter Site Search"), or take a row's alternative action ("Hint for using the Tab key to enter an alternative action": trailing "Tab" keycap + "→ *action*") |
| Space | — | enters site search too when `siteSearchSpaceTriggerEnabled` (hint "Space or Tab") |
| ⇧⌘C | `copyCurrentURL:` | `onCopyCurrentSuggestionURLShortcut` (copy the highlighted row's URL) |
| ⌘C with text selected | — | `onAttemptToCopyCommandBarText(selectedText)` |
| ⌫ on a row's ✕ | `deleteButtonClicked` | `onDeleteSuggestion(sourceInfo)` → `SearchClient.deleteSuggestion` (history rows carry `SourceInfo.deletionID`; row trailing accessory `.delete`, label "Delete Suggestion") |

Modifiers on ⏎ / click become `CommandBarSelectionFlags` → `WindowContentPresentationDisposition` (`splitView(target)` | `modalV2(target)`)
and `SidebarInsertionStrategy`: so ⏎ variants open in **split view** or in a **modal (Peek / Little Arc style)**. Which modifier maps to which
is **open** (screen: ⌘⏎, ⇧⏎, ⌥⏎, ⌃⏎). `TypeTravel` commands also show their own keyboard shortcut keycap (`KeyboardShortcutView`).

---

### 5. Layout and look

#### Placement (`Arc.WindowViewController`)
`CommandBarLayoutDisposition`: **`centered`** (⌘T, new tab), **`overCommandBarPlaceholder`** (⌘L: drops down over the sidebar's URL
field — `Placement.topLeftCommandBar(CGRect)` = the placeholder's frame), `overFocusedContent`, `overContentPanel` (inside a pane:
`Placement.onContentPanel(view)`). `CommandBarPresentationAndPlacement { placement, presentation, shouldAppearAsEmpty, needsPopoverBackdrop }`:
a centred bar gets a **backdrop** behind it.

#### Numbers decoded at the views' construction sites (pt)
| Where | Value | Evidence |
|---|---|---|
| Max width (inferred) | **720** | CommandBarConstants static (0x103848450), used cross-module |
| Other CommandBarConstants statics | 12, 10, 12, 10, 9, 7, 12, 5, 20, 36, 16, 24, 4, 16, 22, 12, 2, 4, 2, 12, 28, 0, 2, 350, 12, 4 | 0x103848458–0x103848520 (names stripped; 9 and 12/16/2 used by `CommandBarPlaceholderPopoverState`) |
| Input row | 10 and 16 (an `edgeInsets` read with d0=10, d1=16; inferred insets); constants 12/16 | CommandBarInputContainer |
| Input leading icon | SF Symbol config **14 pt** | `configurationWithPointSize:weight:` d0=14 |
| Input (centred, `SecondaryWindowInput*`) | shadow blur **8**, offset (0, **2**), border alpha 0.15/0.3 | `setShadowBlurRadius:`, `setShadowOffset:` |
| Text field | text shadow offset (0, −0.25) | CommandBarTextField |
| Split-view placeholder bar | height **40**, insets 12 / −12 | SplashView region `constraintEqualToConstant:` 40 |
| Row highlight | corner radius **4** (`selectionHighlightLayer`) | CommandBarSuggestionRowView.Theme ×2 |
| Row content | stack spacing **8**, left inset **12**, custom spacing **16** after the title | DefaultSuggestionTitleView / DefaultSuggestionView |
| Row title max width | **480** (`setPreferredMaxLayoutWidth:`) | DefaultSuggestionIconContainerView region; also static 480 |
| Row subtitle symbol | 12 pt | `configurationWithPointSize:` 12 |
| Command row | insets left/right **12**, spacing **8**, icon background radius 4 | TypeTravelSuggestionTableViewCell |
| Command capsule icon | 13 pt symbol; tiny 7 pt glyph | TypeTravelSuggestionViewModel |
| Pill (space / site chip) | height **24**, corner **12**, right inset 8, spacings 2 / 4 | SuggestionPillView |
| Colorized icon box | corner **6** | ColorizedIconContainerView |
| Site-search hint capsule | corner **12**, shadow opacity 0.15 | ScopedSearchTrailingAccessoryView |
| "→ action" accessory | arrow box 16 × 16, corner 4, spacing 12, 14 after, opacity 0.66 | AlternativeActionTrailingAccessoryView |
| Suggestions area | corner radius **12** on the MaxY pair of corners (`setMaskedCorners: 0xC`), vertical elasticity none (2), 8 / 1 pt hairline frames | SuggestionsView |
| Table | `rowSizeStyle` custom (3), no automatic heights, style `.plain` (4), no header, no scrollers | SuggestionsView |
| Debug | 9 pt system font | SuggestionDebugView |

Fonts: every label's font comes from Arc's `FontsManager` (user-selectable app font via a key path: `sub_100da0b44` / `sub_100da0784`), so
sizes are dynamic (`allowTextBasedSizing`). **Open**: title/subtitle/input font sizes and row height (measure on screen).

#### Colours (`ARC_CommandBar.bundle/Assets.car`; light / dark)
| Name | Light | Dark |
|---|---|---|
| CommandBarTextPrimaryColor | black 80% | white 80% |
| CommandBarTextSecondaryColor | black 33% | white 33% |
| CommandBarRowHoverBackgroundColor | black 5% | white 5% |
| CommandBarHairlineDividerColor | black 10% | white 10% |
| CommandBarAccessoryBackgroundColor / Foreground | black 5% / black 50% | white 5% / white 66% |
| CommandBarSuggestionHintPillText | P3 (0.271, 0.541, 1.0) | P3 (0.98, 0.984, 1.0) 33% |
| SecondaryWindowInputBackground | P3 (0.98, 0.984, 1.0) | P3 (0.055, 0.059, 0.063) |
| SecondaryWindowInputBorder | P3 (0.055, 0.059, 0.063) 10% | P3 (0.98, 0.984, 1.0) 20% |
| TypeTravelCapsuleBackground | sRGB 0.92 gray | sRGB (0.067, 0.106, 0.192) |
| CommandBarBannerBackground | (0.992, 0.992, 0.996) | 0.086 gray |
| Banner secondary button bg / border / text | white / 0.859 / 0.090 | 0.137 / 0.435 / white |

The selected row's colour is **not** an asset: `CommandBarSuggestionRowView.Theme { selectedColor, hoveredColor }` and every palette
(`DefaultSuggestionTitleView.ColorPalette` selected/deselected primary + secondary text, icon backgrounds, arrow colours) are built from the
**window theme** (`semanticColorPalette`, `primaryColorPalette`: the space's colour). Scoped search recolours the bar with the site's brand
colour (`scopedSearchColor`, `SearchEngineClient.autoActivatedEngineURLToPrimaryColor`, `siteSearchDominantColor` read from the favicon).
Background: `ARCUI.PopoverBackgroundView` (Arc's popover material; same as its other popovers). `SuggestionsView` uses colour alphas 0.12
and 0.5 (inferred: hairline/scrim). **Open**: blur material, shadow and corner radius of the whole bar (the `cornerRadius` view-state value comes
from the window's `contentCornerRadius`, i.e. it matches the page card).

---

### 6. Motion

- **Banner in/out** (privacy banner, default-browser prompt under the rows): a `CASpringAnimation` built by Arc's spring factory
  (`sub_100a11dd4(dampingRatio, response)`: stiffness = (2π/response)², damping = 4π·ζ/response, duration = settlingDuration) with
  **damping 1.0, response 0.3**, on `transform` from a translation of the banner's own height to identity (`entrance_animation`), and back
  out to its height with `removedOnCompletion = NO`, fill forwards, then `removeFromSuperview` (`exit_animation`). (0x1022613d4, 0x102263e24.)
- **Rows**: no row insertion/removal animation found; rows are diffed by dedup key (`useResetInsteadOfDiffingForSuggestions` can force a
  reload). Highlight is a `CALayer` (`selectionHighlightLayer`) moved per row — no animation call found near it (inferred: instant).
- **Bar bounce**: `arc_commandBarBounce` key on `transform` (a CAAnimation with `anchorPoint` (0.5, 0.5), scale 0.95 → 1, `repeatCount` 1
  in the `ArcSearch` neighbourhood) — the "nothing happened" bounce (inferred).
- **Arc Search / Browse for Me placeholder**: `easeOut(duration: 1.2)`; constants 0.4, 0.8, 0.75, 0.95 and 133, 60, 60, 200, 22 (CommandBarConstants.ArcSearch statics).
- **Placeholder (sidebar URL field)**: first-run hint text "Click New Tab or press ⌘T to open the Command Bar and create your very first tab in
  Arc.": `spring(response 1.4, …)`, delays 0.15 / 0.25 / 1 / 2.3 s, a gradient mask (stops 0.25 / 1); placeholder buttons `springy` (0.28, 0.63)
  and a 0.15 s duration (matches docs/ARC-MOTION.md's "placeholder spring(0.2, 1) / (1.4, 0)" rows).
- **Open/close of the bar itself**: not found in the CommandBar module; it is presented by `WindowViewController` (backdrop + placement).
  **Open** for the screen (scale/opacity, duration).
- Splash (`SplashView`): SwiftUI blur radius + opacity animated on a colour splash (`splashColor`) — inferred: a flash of the site's colour
  when entering site search.

---

### 7. Modes: ⌘T vs ⌘L, Little Arc, content panel

- **⌘T** → entry `keyboardShortcutT` / `appMenu(.newTab)`, `destinationType = createNewTab`, disposition `centered` (popover backdrop).
- **⌘L** → `keyboardShortcutL` / `appMenu(.addressBar)` (menu item "Open Command Bar", id `addressBar`), `destinationType =
  overrideCurrentTab(showCurrentURL: true)`, placed `overCommandBarPlaceholder` (over the sidebar's URL bar, top-left), prefilled with the
  current URL (`CommandBarInstanceConfiguration.query`, `CommandBarObservableInputs.currentItemURL`) and an edit policy (`selectAll` most
  likely; `CommandBarEditPolicy`). ⇧⌘C copies, ⌘C copies selected text. (`toggleBetweenTypeTravelAndCommandBar` switches into the Actions scope.)
- **Little Arc** → `newLittleWindowOpen`, `littleArcPlaceholderClick`; `CommandBarWindowSidebarContext.isStandardWindow = false`;
  `switchToTabAllowed` (in `CommandBarDisplayInfo`) is the switch that turns off "Switch to Tab" rows where they don't make sense (inferred
  for Little Arc). Little Arc's own window is `LittleBrowser`'s; its URL field is `URLInputter` (separate module, `URLInputterFeature`,
  colours Background white / (0.071, 0.059, 0.18), TextFieldBackground 0.922 / blue 15%).
- **Content panel / split pane** → `contentPanel(id)`, `splitViewPaneCreated`, layout `overContentPanel`, input height constraint
  `contentPanelInputHeightConstraint`, bar height 40.
- Other entries: sidebar "+" (`sidebarPlusButton`), New Tab button, double-click in the sidebar, ⌘⌥G (`keyboardShortcutCommandOptionG`),
  "focus sidebar" shortcut, new standard window opening with the bar shown (`newStandardWindowOpen`).

---

### Every feature (inventory for a full migration)

#### A. Site search ("Search YouTube")
- **Model**: a site search is a Chromium keyword search engine (`BaseModels.SearchEngine { name, keyword, status, isPrepopulated,
  searchURLTemplate (%s), faviconURL }`), held per profile (`SearchEngineClient._activeSearchEngines(browserContextID)` → ordered dict keyed by
  keyword). Entering one sets `CommandBarState.scopedSearchType = .siteSearch(engine)` and `scopedSearchColor`.
- **Entering**: type the site's keyword/domain (e.g. "youtu…" matches keyword `youtube.com`), then **Tab** — or **Space** when
  `siteSearchSpaceTriggerEnabled` (a per-profile setting, `siteSearchSpaceTriggerEnabledForBrowserContext`). The highlighted row shows the
  hint capsule "**Tab**" or "**Space or Tab**" (`ScopedSearchTrailingAccessoryView`, corner 12). Also from a row's alternative action, from
  Instant Links (`SiteSearchAction`), and with an auto-activated list (`isFromAutoActivatedList`).
- **In the mode**: the field shows a **pill** at its start with the site name (`CommandBarInputScopedSearchPillView`, `theme.focusColor` =
  the site's colour) and the placeholder "**Search %@**" (site name), "**Ask %@**" for ChatGPT. The whole bar takes the site's colour: the
  brand colour from the built-in table below, else the favicon's **dominant colour** (`siteSearchDominantColor`), and a colour splash
  (`SplashView`, inferred). Rows become that engine's suggestions (inferred: Chromium keyword-mode suggestions).
- **Pill menu** (right-click/click on the pill): "Change Site Search ▸" (submenu of the other engines), **Remove "%@" Site Search**,
  "Manage…" (menu item to manage site searches → `arc://settings/searchEngines`), **Learn More**.
- **Leaving**: ⌫ with the caret at the start (`onBackspacePressed(isCursorAtStart: true)`), Esc (inferred), or the trailing "Back"
  accessory (`tabToGoBack`; "Title for action to go back to the previous search state" = **Back**). The query typed before entering is
  restored (`PostScopedSearchRestoration.queryBeforeEnteringScopedSearch`, `didRestoreQuery`).
- **Adding engines**: `CommandBar.Action.addSearchEngine(SearchEngine)` → `ADK.BrowserContext.addSearchEngine(_:)` (Chromium's
  auto-added engines from sites you searched on / OpenSearch, inferred from Chromium); removal `removeSearchEngineFromBrowserContext`.
- **Built-in list with brand colours** (`ADK.Engine` table at 0x100532000, `init:keyword:url:faviconUrl:` + hex colour):

| Name | Keyword | URL template | Colour |
|---|---|---|---|
| Google Drive | drive.google.com | https://drive.google.com/drive/search?q=%s | #0F9D58 |
| Gmail | mail.google.com | https://mail.google.com/mail/ca/u/0/#apps/%s | #D44638 |
| Google Maps | maps.google.com | https://www.google.com/maps/search/%s | #FBBC05 |
| Google Calendar | calendar.google.com | https://calendar.google.com/calendar/u/0/r/search?q=%s | #9C27B0 |
| Google Docs | docs.google.com | https://docs.google.com/document/u/0/?q=%s | #4285F4 |
| Dropbox | dropbox.com | https://www.dropbox.com/search/personal?&query=%s | #007EE5 |
| Amazon | amazon.com | https://www.amazon.com/s?k=%s | #FF9900 |
| GitHub | github.com | https://github.com/search?q=%s | #743FC7 |
| Figma | figma.com | https://www.figma.com/files/search?q=%s | #F24E1E |
| X | x.com | https://x.com/search?q=%s | #000000 |
| X | twitter.com | https://twitter.com/search?q=%s | #000000 |
| YouTube | youtube.com | https://www.youtube.com/results?search_query=%s | #FF0000 |
| Wikipedia (inferred name) | wikipedia.org | https://wikipedia.org/w/index.php?search=%s | (#FF4500 read; looks shifted, check) |
| Reddit | reddit.com | https://www.reddit.com/search/?q=%s | #FF4500 |
| SoundCloud | soundcloud.com | https://soundcloud.com/search?q=%s | #F85216 |
| Asana | asana.com | https://app.asana.com/0/search?q=%s | #F06A6A |
| LinkedIn | linkedin.com | https://linkedin.com/search/results/all/?keywords=%s | #0B66C2 |
| Apple Music | music.apple.com | https://music.apple.com/us/search?term=%s | #FA2A44 |
| Spotify | spotify.com | https://open.spotify.com/search/%s | #1DB954 |

  Plus Chromium's prepopulated engines (Google default `https://www.google.com/search?q=%s`). Instant Links (Arc Max) has its own
  site list: google, youtube, amazon, wikipedia, reddit, twitter, threads, linkedin, pinterest, tiktok, spotify, github, stackoverflow,
  goodreads, netflix (+ Google News `&tbm=nws`, Images `&tbm=isch`, Flights, Maps; GitHub code `&type=code`).

#### B. Commands ("Type Travel")
Two sources, both shown as command rows (`TypeTravelSuggestionView`: SF Symbol in a rounded box, title made of text + capsules, the
shortcut keycap on the right, `isEnabled` greys it):
1. **Every main-menu item that has a Type-Travel ID** (`TypeTravel.TypeTravelMainMenuIndex` snapshots `NSApp.mainMenu`; items carry
   `arcTypeTravelID`, `arcTypeTravelIcon`, `arcTypeTravelTriggers` (aliases, `;`-separated), `arcTypeTravelTitle` (override),
   `arcTypeTravelCandidateBump` (ranking bump), `arcTypeTravelDisregardCache`). Disabled menu items show disabled
   (`MenuItemSnapshot.State`). The full table (117 entries, decoded from `Base.lproj/MainMenu.nib`) is in the appendix. Shortcuts shown are the
   nib defaults; Arc's key bindings (`arcKeyBindingID`, `KeyBindingsState`) override them at run time.
2. **Built-in parameterised candidates** (`ASE2.TypeTravelCandidate`; titles from `codestrings.txt` in `ASE2.TypeTravelCandidate`):
   - `focusSpace(spaceID, name)` → "**Focus on** <space>" / "Switch to <space>" (capsule with the space icon/colour)
   - `moveToSpace(spaceID, name, containerType)` → "**Move to Today in** <space>", "**Move to Pinned in** <space>", "**Move to Explore in** <space>", "… and switch there"
   - `moveToTopApps` / `removeFromTopApps` → "**Move to Top Apps**", "**Favorite Tab**" / "**Remove from Top Apps**", "Unpin from Top Apps", "**Unfavorite Tab**"
   - `moveToFolder(folderID, name)` → "**Pin to** <folder>", "Move to <folder>"; `moveToNewFolder` → "Create a new folder with items"; `createNewFolder` → "**Create New Folder**" (inline name prompt "What are you organizing?", **Create** / **Cancel**)
   - `openFolder(folderID, name)` → "**Open** <folder>"; `collapseAllFolders` / `expandAllFolders` → "**Collapse All Folders**" ("Close All Folders", "Clean up Folders") / "**Expand All Folders**" ("Open Folders", "Reveal All Folders")
   - `undoAction(name)` / `redoAction(name)` → "**Undo** <action>" / "**Redo** <action>" (from `TypeTravelUndoManager`)
   - `joinNextMeeting(title, time, link)` → "**Join** <meeting>" ("Join next video conference", zoom)
   - `toggleSidebar` → "**Toggle Sidebar**"; `renameCurrentTab` → "**Rename Current Tab…**"; `duplicateCurrentTab` → "**Duplicate Current Tab**"
   - `resetCurrentTab` → "**Reset Tab**"; `replacePinnedTab` → "**Replace Pinned Tab with the Current Site**" / "Replace Pin with Current Page"
   - Split: `newVerticalSplitViewPane` "**New Vertical Split View**"/"Add Vertical Split View", `convertToHorizontalSplitView` / `convertToVerticalSplitView` ("Flip to … split view"), `addTopSplit` / `addBottomSplit` / `addLeftSplit` / `addRightSplit` ("**Add Top Split**", "New Top Split", …)
   - `muteAllTabs` / `unmuteAllTabs` → "**Mute All Tabs**" / "**Unmute All Tabs**"
   - `newArcNote` → "**New Arc Note**" (triggers "new note", "new arc note")
   - `menuItem(MenuItemInfo)` (source 1 above), `browserExtension(name, id, icon)` → "**Extension** <name>" (run an extension's action)
   - `newWebDocument(WebDocumentType)` → "**New** <Google Doc / Sheet / …>" (alternate phrase "repl" for New Repl)
   - `openPreferencePane(identifier, triggers, bump, headline, title, icon, shortcut)` → each Settings pane, "**Edit Keyboard Shortcuts**"
   - `openPasswordManager` → "**Manage Passwords**" (`arc://password-manager/passwords`); `openSearchSettings` → "**Search Settings**" (`arc://settings/searchEngines`); `openAirTrafficControl` → "**Air Traffic Control**" (triggers "air traffic control(ler)", "link preferences")
   - Debug: `commandBarRankingDebugMode` ("Toggle Command Bar Ranking Info in Suggestion Views"), `toggleCommandBarRankingWindow`, `copyBuildInfo`
   SF Symbols used on these rows: square.split.2x1, arrow.uturn.backward/forward, arrow.down.and.line.horizontal.and.arrow.up (and up/down),
   puzzlepiece, square.on.square.dashed, character.cursor.ibeam, speaker.wave.2.fill, speaker.slash.fill, plus.square.on.square,
   arrow.backward.to.line, gearshape, circle.fill (space dot).
- **Scope**: `ScopedSearchType.typeTravel` = an "**Actions**" scope that searches commands only (entry `toggleBetweenTypeTravelAndCommandBar`).
- Ranking: `hotWords` = triggers; `typeTravelUsage` (frequency + capped stack of executions) and `recentlyUseTypeTravel` boost; `typeTravelPrefixForLongQuery`; per-command `candidateBump`, `minQueryLengthForMatch`.

#### C. Other result types
- **Open tabs** (any space, any window; `SidebarCandidatesProvider`, `perWindow` and `global`) → "**Switch to Tab**", in split → "**Switch to
  Split View**"; tabs in another space show the space capsule (`SuggestionPillView`: prefix title + title + coloured icon, inferred "Personal ›").
  Pinned/favorites carry `savedContext` (`scoped` = pinned in a space, `global` = favorites/Top Apps). Renamed tabs match their custom title (`customTitlePrefix` boost). Tidy-Tabs titles are used (`tidyTabTitles`).
- **History, bookmarks, past searches, search suggestions, calculator, other engines**: Chromium omnibox kinds (§2). History rows are deletable
  (✕, "Delete Suggestion").
- **Top domains** (458 sites) for typing a bare name.
- **Arc Notes / documents / Easels** (`DocumentsCandidateProvider`, `EaselCandidatesProvider`).
- **Ask / AI**: "Ask ChatGPT" (`askGPTWhatYouTyped`), "Instant Open" (Instant Links), "**Browse for Me**" (placeholder "Browse for Me…", "Browse for Me - Tell us what you're looking for!"), assistant history, "Send a Message…" (GPT site search placeholder). Arc Max features; Margin can skip.
- **Extensions' omnibox keywords** (`extensionOmnibox`).
- **Null state**: Help Center, Tips for Organizing, Spaces article, BCNY YouTube channel, Contact the Team (onboarding).
- **Banners**: search-suggestions privacy, default-browser prompt ("Set Arc as default" / "Try for a week" / ✕).
- Not found in code: clipboard-URL row, "recently closed" row (only the "Restore Last Closed Tab" command), unit conversion (only Chromium's calculator answer).

#### D. Modifiers and copy
See §4. Copy: ⇧⌘C copies the highlighted row's URL; ⌘C copies selected field text. Selection opens via `openURL(disposition: splitView |
modalV2, insertionStrategy)`: split-view and modal (peek) destinations exist; the exact modifier mapping is a screen question.

#### E. Prefixes / syntax
- No Arc-specific prefix syntax (`@`, `/`, `!`) appears in the CommandBar/ASE2/SearchClientManager code. "Prefixes" are keyword engines (site search) and
  command trigger phrases. URL detection: `SearchOrNavigateWhatYouTypedProvider` checks for `.`, `:`, `/` (string ".:/") and Chromium's URL
  fixup; `javascript:` is special-cased in the Chromium provider. Chromium's own `?` force-search likely passes through (a lone "?" string sits
  in `TrailingAccessoryType`'s neighbourhood; inferred).
- Matching is tokenised + fuzzy (word-prefix and fuzzy scores, `highFuzzySearchConfidence` boost), with exact domain/URL/hot-word boosts.

---

### Open questions for the screen

1. Bar width (720 is the best candidate for the max), its position for ⌘T (centred vertically? an offset from the top?), corner radius, shadow, blur material and backdrop dimming.
2. Row height, title/subtitle/input font sizes and weights (fonts come from the user's font setting), icon size in rows (16? 20?).
3. How many rows show at most (and per kind); whether the list scrolls.
4. Empty ⌘T: which rows (none? recent tabs? null-state help rows?).
5. ⌘L: prefilled URL fully selected? Bar anchored over the sidebar URL field (size = sidebar width?) or a wider drop-down?
6. Modifier mapping on ⏎: ⌘⏎, ⇧⏎, ⌥⏎, ⌃⏎ (split view? Little Arc/peek modal? background tab?).
7. Inline completion look (selected completion text after the caret? icon swap in the field?) and Tab vs → behaviour on a normal row.
8. Subtitles per row kind (URL? "Search Google"? space name?) and the trailing accessory text ("Switch to Tab" arrow, "Tab to search" hint).
9. Open/close motion of the bar, the highlight's movement (instant or animated), rows' insertion.
10. Site search: the pill's look, the whole-bar recolour, the splash, and whether Space also enters (setting).
11. The Wikipedia row colour (the decoded table looked shifted by one there).

### Confidence summary
- **Confirmed from shipped artifacts**: all type and field names, enum cases, action/delegate lists, entry points, destination/edit
  policies, sources/archetypes/boosts/features, the built-in site-search table, the menu command registry (nib), asset colours, the
  doCommandBySelector selectors handled, the banner spring (ζ 1.0, response 0.3), the constants listed in §5 at their call sites.
- **Inferred**: meanings of stripped static constants (720 = width, the 1/4/4/1/5/3/3/3 caps), exact key → action mapping beyond the
  selector names, Escape/⌫ leaving site search, inline completion behaviour, banner vs row animation target, Little Arc differences.
- **Not in the binary**: the ranking weights (remote/stored JSON), font sizes (font manager), the suggest endpoint (Chromium's per-engine).

---

### Appendix: menu commands with Type-Travel data (`Base.lproj/MainMenu.nib`)

| Menu title | Command-bar title | ID | SF Symbol | Trigger phrases | Bump / cache | Nib key |
|---|---|---|---|---|---|---|
| Boost Gallery |  | `openBoostGallery` | paintbrush | Boost Gallery; Boosts Gallery; Boost Store; Boosts Store |  |  |
| Show/Hide Sidebar |  | `toggleSidebar` | sidebar.left | Toggle Sidebar; | bump 0.5 | ⌘S |
| Go Forward |  | `goForward` | arrow.right | Go Forward; Forward; Navigate Forward |  | ⌘] |
| Cancel Trace |  | `cancelTrace` | exclamationmark.triangle |  |  |  |
| Change Profile |  | `changeProfile` | person.fill |  |  |  |
| Zoom Out |  | `zoomOut` | minus.magnifyingglass |  |  | ⌘- |
| Visit Help Center |  | `visitHelpCenter` | heart.circle | Question; Inquiry; Help Center; Help; Resources |  |  |
| About Arc |  | `aboutArc` | book.closed |  |  |  |
| Redo |  | `redo` | arrow.uturn.forward |  |  | ⇧⌘Z |
| View Downloads |  | `openDownloads` | arrow.down.circle | Downloads | disregardCache | ⇧⌘J |
| Pin/Unpin Tab |  | `pinTab` | pin | save |  | ⌘D |
| Add Split View |  | `addSplitView` | square.split.2x1 | Add Split View; Split View; Create Split View Pane; New Split View; Split |  | ⌃⇧= |
| Tab Switcher (backward) |  | `—` |  | Toggle Tabs; Switch tabs; Recent tabs |  |  |
| Close this Split Pane |  | `removeSplitView` | xmark.square | Close Split View |  | ⌃⇧- |
| Set as Default Browser |  | `defaultBrowser` | heart | Default Browser; |  |  |
| Capture… |  | `capturePage` | camera | Capture; Screenshot; Snapshot; Cut Out; |  | ⇧⌘2 |
| Record Trace |  | `recordTrace` | flag |  |  |  |
| Show Spelling and Grammar |  | `showSpellingAndGrammar` | textformat | Show Spelling; Show Grammar; Spelling; Grammar |  | ⌘: |
| Dark | Switch to Dark Mode | `darkMode` | moon.stars.fill | Switch to Dark Mode; Switch Dark Mode; Dark Mode; Night Mode |  |  |
| Essential Keyboard Shortcuts |  | `essentialKeyboardShortcuts` | keyboard | Essential Keyboard Shortcuts; keyboard; shortcuts | bump 0.1 |  |
| Reset all tabs in this Space |  | `expandPinnedTabs` | arrow.backward.to.line |  |  |  |
| Show All |  | `showAll` | book |  |  |  |
| Privacy Policy |  | `privacyPolicy` | book.closed | Privacy Policy |  |  |
| Share Arc |  | `giftArcToAFriend` | gift | Refer; Refer a friend; Referral; Invite; Share Arc; Gift Arc | bump 1.3 |  |
| Open Task Manager |  | `openTaskManager` | exclamationmark.triangle | "Task; Manager; Task Manager; Cpu; Memory: RAM" |  |  |
| New Profile |  | `newProfile` | person.fill | Profile |  |  |
| Copy URL as Markdown |  | `copyCurrentURLAsMarkdown` | doc.on.doc | Copy Link as Markdown; Copy Markdown |  | ⌥⇧⌘C |
| Edit Boost |  | `editBoost` | paintbrush | Boost; New Boost; Create boost; extension; Boost the Current Page; Edit Boost |  |  |
| Enter/Exit Full Screen |  | `togglefullscreen` | arrow.up.left.and.arrow.down.right | Enter Full Screen; Exit Full Screen; Full Screen; Toggle Full Screen | disregardCache | ⌃⌘F |
| Rename Space |  | `renameSpace` | character.cursor.ibeam |  |  |  |
| View Library |  | `openLibrary` | archivebox | Library | disregardCache | ⇧⌘L |
| New Little Arc Window |  | `newLittleBrowserWindow` | macwindow.on.rectangle | Quick Lookup, Mini Window, Floating Window |  | ⌥⌘N |
| Hide Arc |  | `hideArc` | macwindow | Hide Arc |  | ⌘H |
| Find Previous |  | `findPrevious` | arrow.left | Previous |  | ⇧⌘G |
| Clear Unpinned Tabs |  | `clearUnpinnedTabs` | bubbles.and.sparkles | Close Unpinned Tabs; Clear Tabs; Clear Today |  | ⇧⌘K |
| Network Inspector |  | `networkInspector` | wifi | Network Inspector; |  |  |
| Select All |  | `selectAll` | square.grid.2x2.fill |  |  | ⌘A |
| Jump to Selection |  | `jumpToSelection` | arrow.turn.right.down | Jump to Selected; Selection |  | ⌘J |
| Manage Spaces… |  | `openSpaceManager` | rectangle.portrait.on.rectangle.portrait | Space Management; Organize; Toggle Space Manager; View Spaces |  |  |
| Close Window |  | `closeWindow` | xmark.circle | Exit Window |  | ⇧⌘W |
| Copy Arc Info |  | `copyArcInfo` | list.clipboard |  | bump 0.1 |  |
| Reveal Arc Data |  | `revealArcData` | list.clipboard |  | bump 0.1 |  |
| Share… | Share URL | `share` | square.and.arrow.up | Share |  |  |
| Expand Pinned Section |  | `expandPinnedSection` | chevron.down | Expand Pinned Tabs; Show Pinned Tabs; Pinned |  |  |
| Expand Current Split |  | `expandSplitViewPane` | arrow.up.left.and.arrow.down.right | Expand; Expand Split View; Maximize |  |  |
| Automatic | Switch to Automatic Appearance | `automaticMode` | sparkles | Switch to Automatic Appearance; Switch Automatic Mode; Automatic Mode |  |  |
| View Source |  | `viewSource` | curlybraces | View Source; |  | ⌥⌘U |
| View Media |  | `viewScreenshotsAndCaptures` | photo.on.rectangle.angled | Screenshots; Captures; Videos; Media |  |  |
| New Window |  | `newWindow` | plus.rectangle | Create Window; Copy Window; Duplicate Window |  | ⌘N |
| New Note |  | `newNote` | note.text | Create Note; Note; Scratchpad |  | ⌃⇧N |
| Refresh the Page |  | `reloadPage` | arrow.clockwise | Reload Page |  | ⌘R |
| Restore Last Closed Tab |  | `reopenClosedTab` | arrow.uturn.backward | Reopen Closed Tab |  | ⇧⌘T |
| Hide Other Windows |  | `hideOthers` | macwindow | Hide Others |  | ⌥⌘H |
| Paste and Match Style |  | `pasteAndMatchStyle` | list.clipboard | Paste Without Formatting |  | ⇧⌘V |
| Reveal Tab in Sidebar |  | `revealTabInSidebar` | arrow.left.circle | Show Tab in Sidebar; Reveal in Sidebar; Go to Current Tab |  |  |
| Zoom to Actual Size |  | `actualSize` | magnifyingglass | Reset Zoom |  | ⌘0 |
| Reveal Current Tab |  | `focusSidebar` | sidebar.left |  | bump 0.5 |  |
| Getting Started |  | `welcomeToArc` | safari | Welcome to Arc |  |  |
| Find… |  | `find` | magnifyingglass | Find in Page |  | ⌘F |
| Next Space |  | `nextSpace` | arrow.right.to.line | Focus Next Space |  | ⌥⌘ |
| Find and Replace |  | `findAndReplace` | magnifyingglass |  |  | ⌥⌘F |
| Collapse Pinned Section |  | `collapsePinnedSection` | chevron.right | Collapse Pinned Tabs; Hide Pinned Tabs; Pinned |  |  |
| Previous Tab |  | `previousTab` | arrow.left |  |  | ⌥⌘ |
| View Boosts |  | `viewBoosts` | paintbrush | Boosts |  |  |
| New Boost |  | `newBoost` | paintbrush | Boost; New Boost; Create boost; extension; Boost the Current Page; Edit Boost |  |  |
| Copy URL |  | `copyCurrentURL` | doc.on.doc | Copy URL; Copy Link |  | ⇧⌘C |
| Print |  | `printPage` | printer | Print Page |  | ⌘P |
| Capture in Portrait Mode |  | `capturePrettyScreenshot` | camera.macro | Screenshot in Portrait Mode; Capture Portrait; Portrait Mode; Screenshot |  |  |
| Use Selection to Find |  | `useSelectionForFind` | magnifyingglass | Find Selection; Find Selected |  |  |
| View Archive |  | `viewArchive` | archivebox | Archive | disregardCache |  |
| Go Back |  | `back` | arrow.backward | Go Back; Back; Navigate Back |  | ⌘[ |
| Archive Tab |  | `archiveTab` | archivebox | Exit Tab; Unload; Deselect; Close |  | ⌘W |
| Manage Extensions… |  | `manageExtensions` | puzzlepiece | Manage Extensions; Extensions; Plugins; Chrome Extensions |  |  |
| Quit Arc |  | `quitArc` | hand.wave | Quit App |  | ⌘Q |
| Minimize Window |  | `minimize` | arrow.down.right.and.arrow.up.left |  |  | ⌘M |
| Tab Switcher (forward) |  | `—` |  | Toggle Tabs; Switch tabs; Recent tabs |  | ⌃⇥ |
| New Incognito Window |  | `newIncognitoWindow` | macwindow.on.rectangle | Create Incognito Window; New Private Window; Incognito |  | ⇧⌘N |
| Force Refresh the Page |  | `forceReloadPage` | arrow.clockwise | Force Reload; Force Refresh |  | ⇧⌘R |
| Zoom In |  | `zoomIn` | plus.magnifyingglass |  |  | ⌘+ |
| Export Arc Notes |  | `exportArcNotes` | arrow.down.doc | Export Notes; Backup Notes; Download Notes | bump 1.5 |  |
| Paste |  | `paste` | list.clipboard |  |  | ⌘V |
| Clear Cache and Refresh |  | `clearCache` | trash | Clear Cache |  |  |
| Show/Hide Toolbar |  | `toggleToolbar` | rectangle.topthird.inset.filled | Toggle Hide Show Toolbar; |  | ⇧⌘D |
| Previous Space |  | `previousSpace` | arrow.left.to.line | Focus Previous Space |  | ⌥⌘ |
| Light | Switch to Light Mode | `lightMode` | sun.max | Switch to Light Mode; Switch Light Mode; Light Mode |  |  |
| View History |  | `history` | book | Show History; History |  | ⌘Y |
| Send to Dia | Send Tab to Dia | `sendCurrentTabToDia` | sunrise | Send Tab to Dia |  |  |
| Clear Archive |  | `clearArchive` | archivebox | Clear Archive; Delete Archive |  |  |
| New Legacy Boost (Advanced) |  | `newLegacyBoost` | burst | Create legacy boost; legacy boost | bump 0.5 |  |
| New Space… |  | `newSpace` | plus.rectangle.portrait | Create New Space |  |  |
| Save Page As |  | `save` | square.and.arrow.down | Save Page; Save File |  | ⇧⌘S |
| New Note (in Split) |  | `newNoteInSplitView` | note.text | Create Note in Split View; Note Split; Scratchpad Split | bump 0.9 | ⌃⌥N |
| Add Extension… |  | `addExtension` | plus.circle | Install Extensions; Extension Store; Plugins; Chrome Extensions; Chrome Store |  |  |
| Capture Full Page |  | `captureFullPage` | newspaper | Full Page Capture; Capture Entire Page; Screenshot Full Page; Capture Full Page; Screenshot |  |  |
| Find Next |  | `findNext` | arrow.right | Next |  | ⌘G |
| New Easel |  | `newEasel` | scribble.variable | Mood Board |  | ⌃⇧E |
| Toggle Developer Mode |  | `toggleDeveloperMode` | hammer.fill | Developer Mode; Enable Developer Mode; Disable Developer Mode; |  | ⌃D |
| Contact the Team |  | `contactTheTeam` | ellipsis.message | Idea; Feedback; Request; Feature Request; Send Feedback; Report Bug; Bug; Question |  |  |
| Separate Page from Split View |  | `separateTabFromSplitView` | scissors | Separate from split view; separate tab |  |  |
| JavaScript Console |  | `javaScriptConsole` | terminal | Toggle console; Console; Javascript Console; JS console |  | ⌥⌘J |
| Exit |  | `exit` | escape | Exit; Exit Modal; Exit Full Screen | disregardCache |  |
| Check for Updates… |  | `checkForUpdates` | sparkles | Download; Update; Check for Updates |  |  |
| Reset Tab to Original URL |  | `—` |  | Reset Tab; |  |  |
| Release Notes |  | `resourcesReleaseNotes` | clock | Changelog;Whats new;What's new;arc updates |  |  |
| Cast |  | `cast` | rectangle.portrait.and.arrow.right.fill |  |  |  |
| Inspect Elements |  | `inspectElements` | scope | Inspect Element; |  | ⌥⌘C |
| Cut |  | `cut` | scissors |  |  | ⌘X |
| Next Tab |  | `nextTab` | arrow.right |  |  | ⌥⌘ |
| Copy URL as Quote |  | `copyCurrentURLAsQuote` | quote.bubble | Copy URL as Quote; Copy Quote; Copy Link to Highlight |  | ⌃⇧⌘C |
| Edit Theme… |  | `editSpaceTheme` | paintbrush.pointed.fill | Theme; Edit Theme; Edit Space Theme |  |  |
| Clear Cookies and Refresh |  | `clearCookies` | trash | Clear Cookies |  |  |
| Import from Another Browser… |  | `importFromAnotherBrowser` | arrow.turn.right.down | Import Bookmarks; Import Settings; Import Logins; Import Passwords; Transfer Bookmarks; Transfer Settings; Transfer Logins; Transfer Passwords; Bookmarks |  |  |
| Copy |  | `copy` | doc.on.doc |  |  | ⌘C |
| Developer Tools |  | `devTools` | hammer.fill | Developer Tools; Debug Tools; Devtools |  | ⌥⌘I |
| Blank Window |  | `blankWindow` | macwindow.on.rectangle | Create Window |  | ⌃⌘N |
| Restore Data |  | `restoreData` | opticaldiscdrive | Restore; Backup |  |  |
| View Easels & Notes |  | `viewEaselsAndNotes` | scribble.variable | Easels; Notes |  |  |


## Part 3: Margin against Arc, and the plan

Margin's palette as of 2026-11-27 (main b838bad7): dead centre, 680 pt, its own ranking (top hit, Search for, up to 4
engine suggestions, the person's rows, archived), fading in, no inline completion, no site search, a short list of
actions. Tirth, 2026-11-27: **Arc's position**, its look and **all its functionality**, built with Margin's own code.

| # | Step | What |
|---|---|---|
| 1 | Place and look | Arc's position (top at 32.2% of the window, centred across it) and width; the header, divider, rows (46 + 4, 10 in, radius 4), row parts (title — subtitle, right-hand pill, arrow button), the edge lines, light and dark; no open/close motion |
| 2 | Inline completion | the selected row's completion written after what's typed (selected), its icon in the field; ↑/↓ rewrite both; no completion after a Backspace |
| 3 | Rows as Arc's | the site row (title — domain) from tabs, pins, favourites and the top sites; "Switch to Tab"; a favourite's space pill; the plain search; suggestions; deletable history rows (where there's history) |
| 4 | Site search | Tab (and Space, a setting) on a site row; the pill in the site's colour, "Search …", the list emptied; Backspace at the start or Escape leaving it, what was typed restored; the built-in sites (Part 2's table) and the person's own |
| 5 | Commands | Margin's actions as Arc's commands: titles, aliases, an Actions scope; "Focus on <space>", "Move to … in <space>", "Pin to <folder>", folders, split view, mute all, rename, duplicate, archive, Settings panes … (those Margin has) |
| 6 | Ranking | one flat list ranked as Arc's: match (title, address, aliases), recency, frequency, exact-domain and exact-alias boosts, the current tab lowered, what was picked for a query learned |
| 7 | History and bookmarks | Safari's history and bookmarks (a one-time pick of Safari's data folder, proven 2026-11-18, not built), Chrome's and Edge's through their APIs |
| 8 | ⏎ with modifiers | open in a split or a peek (which modifier: to check on screen) |

Each step its own branch, tests in both engines, the gate once before main.

### Still to check on screen
- The width at another window size (fixed 766, or a share?); the corner radius exactly; the shadow's numbers.
- ⏎ with ⌘, ⇧, ⌥, ⌃: which opens a split, which a peek.
- ⌘L: Arc drops it down from the sidebar's address field (`overCommandBarPlaceholder`), the current address selected (most likely).
- Escape and Backspace in site search (the code: Backspace at the start leaves it; Escape most likely too).
- Text sizes and weights (from Arc's font setting).

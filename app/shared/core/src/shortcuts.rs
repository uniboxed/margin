//! Margin's keys as the app's own hot keys (app/platforms/macos/shell/Shortcuts.swift; PLAN.md §6, docs/PROTOCOL.md "Keys"): a key
//! registered so never reaches the browser, so they're held only while a linked browser is the active app and its
//! front window has Margin's overlay, and let go the moment it isn't (another app in front must get its own keys).
//!
//! The keys: next and previous tab and space (the window's copy's `navigate`, or across profiles the app's switch:
//! `across.rs`), the palette (opened in the front window's overlay, which then takes the typing), the sidebar's
//! show/hide key, and a new Margin window (docs/BROWSER-WINDOWS.md §5). A held tab or space key repeats at the OS's key
//! repeat, each repeat marked as one (requested 2026-11-05): the copy takes repeats like presses, and a repeat never
//! starts a switch to another profile's space. Which combinations is the copy's to say (its Settings shortcuts: the
//! `keys` message); until it does, the defaults for the OS ([`defaults`]).
//!
//! Combinations are written as the extension's Settings write them (`extension/shared/shortcuts.ts`): modifiers
//! `Ctrl`, `Alt`, `Shift`, `Meta`, then a `KeyboardEvent.code` (`Ctrl+Meta+ArrowDown`, `Alt+KeyS`). A `code` is a
//! key's place on the keyboard, not its character, so Option+K still matches on the Mac.
//!
//! Left out (the shell's): registering a hot key with the OS (Carbon's `RegisterEventHotKey` on the Mac,
//! `RegisterHotKey` on Windows) behind [`HotKeyRegistrar`], and the Mac's quit guard (⌘Q held while windows are
//! parked: parking is the Mac's).
//!
//! **`Meta` on Windows (decided here).** Settings write `event.metaKey` as `Meta`, and Chrome and Edge on Windows
//! set `metaKey` for the Windows key, so a combination recorded in Settings on Windows means what it says: `Meta` is
//! the Windows key there (registered with `MOD_WIN`; most Windows-key combinations are the system's, and are then
//! reported unavailable). But some combinations reach the app written for the Mac whatever the OS: the copy always
//! sends `Meta+KeyT` for the palette (`background/link.ts keyBindings`), and its built-in navigation defaults are the
//! Mac's (`shared/capabilities.ts`: `Ctrl+Meta+Arrow…`, Safari's `Alt+Meta+Arrow…`). Mapping every `Meta` to `Ctrl`
//! would make those `Ctrl+Arrow…` (the text keys of every Windows app) and break a Windows recording. So on Windows
//! only those Mac-written combinations, for the command they're written for ([`mac_written`]), are taken as that
//! command's Windows default; everything else is as written. When the extension gets Windows defaults of its own
//! (the Chromium link), this stays harmless: they're taken as written.

use crate::time::Secs;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::hash::Hash;

/// The OS whose keys these are.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Os {
    MacOs,
    Windows,
}

/// What a key does (Swift `AppCommand`), in its order (`ALL`): a combination two commands name goes to the first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AppCommand {
    NextTab,
    PrevTab,
    NextSpace,
    PrevSpace,
    Palette,
    ToggleSidebar,
    /// A Margin window of its own (docs/BROWSER-WINDOWS.md §5).
    NewWindow,
    CopyUrl,
    FocusAddress,
    TogglePin,
    ReopenArchived,
    /// Quick Tab (its key's name kept from when it was "Little Arc").
    LittleArc,
    AddSplit,
    Space1,
    Space2,
    Space3,
    Space4,
    Space5,
    Space6,
    Space7,
    Space8,
    Space9,
    Item1,
    Item2,
    Item3,
    Item4,
    Item5,
    Item6,
    Item7,
    Item8,
    Item9,
}

impl AppCommand {
    pub const ALL: [AppCommand; 31] = [
        AppCommand::NextTab,
        AppCommand::PrevTab,
        AppCommand::NextSpace,
        AppCommand::PrevSpace,
        AppCommand::Palette,
        AppCommand::ToggleSidebar,
        AppCommand::NewWindow,
        AppCommand::CopyUrl,
        AppCommand::FocusAddress,
        AppCommand::TogglePin,
        AppCommand::ReopenArchived,
        AppCommand::LittleArc,
        AppCommand::AddSplit,
        AppCommand::Space1,
        AppCommand::Space2,
        AppCommand::Space3,
        AppCommand::Space4,
        AppCommand::Space5,
        AppCommand::Space6,
        AppCommand::Space7,
        AppCommand::Space8,
        AppCommand::Space9,
        AppCommand::Item1,
        AppCommand::Item2,
        AppCommand::Item3,
        AppCommand::Item4,
        AppCommand::Item5,
        AppCommand::Item6,
        AppCommand::Item7,
        AppCommand::Item8,
        AppCommand::Item9,
    ];

    /// Its name in the `keys` message and the overlay's `command` push.
    pub fn name(self) -> &'static str {
        match self {
            AppCommand::NextTab => "next-tab",
            AppCommand::PrevTab => "prev-tab",
            AppCommand::NextSpace => "next-space",
            AppCommand::PrevSpace => "prev-space",
            AppCommand::Palette => "palette",
            AppCommand::ToggleSidebar => "toggle-sidebar",
            AppCommand::NewWindow => "new-window",
            AppCommand::CopyUrl => "copy-url",
            AppCommand::FocusAddress => "focus-address",
            AppCommand::TogglePin => "toggle-pin",
            AppCommand::ReopenArchived => "reopen-archived",
            AppCommand::LittleArc => "little-arc",
            AppCommand::AddSplit => "add-split",
            AppCommand::Space1 => "space-1",
            AppCommand::Space2 => "space-2",
            AppCommand::Space3 => "space-3",
            AppCommand::Space4 => "space-4",
            AppCommand::Space5 => "space-5",
            AppCommand::Space6 => "space-6",
            AppCommand::Space7 => "space-7",
            AppCommand::Space8 => "space-8",
            AppCommand::Space9 => "space-9",
            AppCommand::Item1 => "item-1",
            AppCommand::Item2 => "item-2",
            AppCommand::Item3 => "item-3",
            AppCommand::Item4 => "item-4",
            AppCommand::Item5 => "item-5",
            AppCommand::Item6 => "item-6",
            AppCommand::Item7 => "item-7",
            AppCommand::Item8 => "item-8",
            AppCommand::Item9 => "item-9",
        }
    }

    pub fn parse(name: &str) -> Option<AppCommand> {
        Self::ALL.into_iter().find(|c| c.name() == name)
    }

    /// Held down, these run again at the key repeat (a hot key itself fires once).
    pub fn repeats(self) -> bool {
        matches!(self, AppCommand::NextTab | AppCommand::PrevTab | AppCommand::NextSpace | AppCommand::PrevSpace)
    }

    /// Margin's or a hosted browser's, never taken from a hosted app that isn't a browser (Terminal, Notes keep
    /// their own ⌘L, ⌘D, ⌘1–9: [`held`]).
    pub fn browser_only(self) -> bool {
        matches!(
            self,
            AppCommand::CopyUrl | AppCommand::FocusAddress | AppCommand::TogglePin | AppCommand::ReopenArchived
        ) || self.item_number().is_some()
    }

    /// A space key's number (space-1…9).
    pub fn space_number(self) -> Option<u32> {
        Self::number(self, AppCommand::Space1, AppCommand::Space9)
    }

    /// A sidebar row key's number (item-1…9).
    pub fn item_number(self) -> Option<u32> {
        Self::number(self, AppCommand::Item1, AppCommand::Item9)
    }

    fn number(command: AppCommand, first: AppCommand, last: AppCommand) -> Option<u32> {
        let at = |c: AppCommand| Self::ALL.iter().position(|x| *x == c);
        let (i, a, b) = (at(command)?, at(first)?, at(last)?);
        (a..=b).contains(&i).then(|| u32::try_from(i - a + 1).unwrap_or(0))
    }
}

/// A combination's modifiers, OS-neutral: `Meta` is ⌘ on the Mac and the Windows key on Windows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Modifiers(u8);

impl Modifiers {
    pub const CTRL: Modifiers = Modifiers(1);
    pub const ALT: Modifiers = Modifiers(2);
    pub const SHIFT: Modifiers = Modifiers(4);
    pub const META: Modifiers = Modifiers(8);
    pub const NONE: Modifiers = Modifiers(0);

    pub fn contains(self, m: Modifiers) -> bool {
        self.0 & m.0 == m.0
    }
    pub fn union(self, m: Modifiers) -> Modifiers {
        Modifiers(self.0 | m.0)
    }
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }
    fn named(name: &str) -> Option<Modifiers> {
        match name {
            "Ctrl" => Some(Self::CTRL),
            "Alt" => Some(Self::ALT),
            "Shift" => Some(Self::SHIFT),
            "Meta" => Some(Self::META),
            _ => None,
        }
    }
    /// Carbon's modifier bits (`cmdKey` 0x100, `shiftKey` 0x200, `optionKey` 0x800, `controlKey` 0x1000), as the Mac's
    /// `RegisterEventHotKey` takes them.
    pub fn carbon(self) -> u32 {
        let mut out = 0;
        for (m, bit) in [(Self::META, 0x100), (Self::SHIFT, 0x200), (Self::ALT, 0x800), (Self::CTRL, 0x1000)] {
            if self.contains(m) {
                out |= bit;
            }
        }
        out
    }
    /// From Carbon's modifier bits (others ignored).
    pub fn from_carbon(bits: u32) -> Modifiers {
        let mut out = Self::NONE;
        for (m, bit) in [(Self::META, 0x100), (Self::SHIFT, 0x200), (Self::ALT, 0x800), (Self::CTRL, 0x1000)] {
            if bits & bit != 0 {
                out = out.union(m);
            }
        }
        out
    }
    /// `RegisterHotKey`'s `fsModifiers` (MOD_ALT 1, MOD_CONTROL 2, MOD_SHIFT 4, MOD_WIN 8), without MOD_NOREPEAT.
    pub fn windows(self) -> u32 {
        let mut out = 0;
        for (m, bit) in [(Self::ALT, 1), (Self::CTRL, 2), (Self::SHIFT, 4), (Self::META, 8)] {
            if self.contains(m) {
                out |= bit;
            }
        }
        out
    }
}

/// The keys Margin's hot keys can be, each with its PS/2 set-1 scan code (0xE0 prefixed in the high byte for the
/// extended ones) and its Mac virtual key code (Carbon's `kVK_*`). A `code` is a key's place, so the Windows shell gets
/// the key for the person's layout with `MapVirtualKeyW(scan, MAPVK_VSC_TO_VK_EX)`, as Carbon's `kVK_ANSI_*` are places
/// too. (The Mac's column is checked against Carbon's own constants by the app's tests.)
const KEYS: &[(&str, u16, u16)] = &[
    ("ArrowDown", 0xE050, 0x7D),
    ("ArrowUp", 0xE048, 0x7E),
    ("ArrowLeft", 0xE04B, 0x7B),
    ("ArrowRight", 0xE04D, 0x7C),
    ("KeyA", 0x1E, 0x00),
    ("KeyB", 0x30, 0x0B),
    ("KeyC", 0x2E, 0x08),
    ("KeyD", 0x20, 0x02),
    ("KeyE", 0x12, 0x0E),
    ("KeyF", 0x21, 0x03),
    ("KeyG", 0x22, 0x05),
    ("KeyH", 0x23, 0x04),
    ("KeyI", 0x17, 0x22),
    ("KeyJ", 0x24, 0x26),
    ("KeyK", 0x25, 0x28),
    ("KeyL", 0x26, 0x25),
    ("KeyM", 0x32, 0x2E),
    ("KeyN", 0x31, 0x2D),
    ("KeyO", 0x18, 0x1F),
    ("KeyP", 0x19, 0x23),
    ("KeyQ", 0x10, 0x0C),
    ("KeyR", 0x13, 0x0F),
    ("KeyS", 0x1F, 0x01),
    ("KeyT", 0x14, 0x11),
    ("KeyU", 0x16, 0x20),
    ("KeyV", 0x2F, 0x09),
    ("KeyW", 0x11, 0x0D),
    ("KeyX", 0x2D, 0x07),
    ("KeyY", 0x15, 0x10),
    ("KeyZ", 0x2C, 0x06),
    ("Space", 0x39, 0x31),
    ("F19", 0x6A, 0x50),
    ("Digit0", 0x0B, 0x1D),
    ("Digit1", 0x02, 0x12),
    ("Digit2", 0x03, 0x13),
    ("Digit3", 0x04, 0x14),
    ("Digit4", 0x05, 0x15),
    ("Digit5", 0x06, 0x17),
    ("Digit6", 0x07, 0x16),
    ("Digit7", 0x08, 0x1A),
    ("Digit8", 0x09, 0x1C),
    ("Digit9", 0x0A, 0x19),
    ("Enter", 0x1C, 0x24),
    ("Backquote", 0x29, 0x32),
    ("Minus", 0x0C, 0x1B),
    ("Equal", 0x0D, 0x18),
    ("BracketLeft", 0x1A, 0x21),
    ("BracketRight", 0x1B, 0x1E),
    ("Backslash", 0x2B, 0x2A),
    ("Semicolon", 0x27, 0x29),
    ("Quote", 0x28, 0x27),
    ("Comma", 0x33, 0x2B),
    ("Period", 0x34, 0x2F),
    ("Slash", 0x35, 0x2C),
    ("F1", 0x3B, 0x7A),
    ("F2", 0x3C, 0x78),
    ("F3", 0x3D, 0x63),
    ("F4", 0x3E, 0x76),
    ("F5", 0x3F, 0x60),
    ("F6", 0x40, 0x61),
    ("F7", 0x41, 0x62),
    ("F8", 0x42, 0x64),
    ("F9", 0x43, 0x65),
    ("F10", 0x44, 0x6D),
    ("F11", 0x57, 0x67),
    ("F12", 0x58, 0x6F),
];

/// One combination: its modifiers and a key's `code`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Combo {
    code: &'static str,
    modifiers: Modifiers,
}

impl Combo {
    /// "Ctrl+Meta+ArrowDown" → the key and its modifiers; `None` if it isn't one: a key not known, no modifier,
    /// a modifier twice or not known, or only Shift (a bare or shifted key would take typing). As the Swift's: the
    /// parts aren't trimmed, and empty ones are skipped ("Meta++KeyT" is ⌘T).
    pub fn parse(text: &str) -> Option<Combo> {
        let parts: Vec<&str> = text.split('+').filter(|p| !p.is_empty()).collect();
        let (&last, mods) = parts.split_last()?;
        let code = KEYS.iter().find(|(c, _, _)| *c == last)?.0;
        if mods.is_empty() {
            return None;
        }
        let mut modifiers = Modifiers::NONE;
        for p in mods {
            let m = Modifiers::named(p)?;
            if modifiers.contains(m) {
                return None;
            }
            modifiers = modifiers.union(m);
        }
        let any = Modifiers::CTRL.union(Modifiers::ALT).union(Modifiers::META);
        if modifiers.0 & any.0 == 0 {
            return None;
        }
        Some(Combo { code, modifiers })
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn modifiers(&self) -> Modifiers {
        self.modifiers
    }
    /// Its key's set-1 scan code (0xE0 in the high byte for an extended key): see `KEYS`.
    pub fn scan_code(&self) -> u16 {
        KEYS.iter().find(|(c, _, _)| *c == self.code).map(|k| k.1).unwrap_or(0)
    }
    /// Its key's Mac virtual key code (Carbon's `kVK_*`): see `KEYS`.
    pub fn mac_key_code(&self) -> u16 {
        KEYS.iter().find(|(c, _, _)| *c == self.code).map(|k| k.2).unwrap_or(0)
    }
    /// The combination of a Mac key code and Carbon modifier bits (`None`: not one of `KEYS`, or not a combination
    /// [`Combo::parse`] would make).
    pub fn from_mac(key_code: u16, carbon: u32) -> Option<Combo> {
        let code = KEYS.iter().find(|k| k.2 == key_code)?.0;
        let modifiers = Modifiers::from_carbon(carbon);
        Combo::parse(&Combo { code, modifiers }.text())
    }
    /// As Settings write it, modifiers in their order (`Ctrl+Alt+Shift+Meta+Code`).
    pub fn text(&self) -> String {
        let mut out = String::new();
        for (m, name) in
            [(Modifiers::CTRL, "Ctrl"), (Modifiers::ALT, "Alt"), (Modifiers::SHIFT, "Shift"), (Modifiers::META, "Meta")]
        {
            if self.modifiers.contains(m) {
                out.push_str(name);
                out.push('+');
            }
        }
        out.push_str(self.code);
        out
    }
}

/// For the log, as the Swift's: "⌃⌥⇧⌘ArrowRight" (⌘ is the Windows key on Windows).
impl fmt::Display for Combo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (m, s) in [(Modifiers::CTRL, "⌃"), (Modifiers::ALT, "⌥"), (Modifiers::SHIFT, "⇧"), (Modifiers::META, "⌘")]
        {
            if self.modifiers.contains(m) {
                f.write_str(s)?;
            }
        }
        f.write_str(self.code)
    }
}

/// The app's default combination for a command on an OS (`None`: the command isn't on that OS yet). macOS: exactly
/// the Mac app's own. **Windows: provisional, to be decided** (⌘ → Ctrl, ⌥ → Alt: tabs Ctrl+Alt+↓/↑, spaces
/// Ctrl+Alt+→/←, palette Ctrl+T, sidebar Alt+S, new window Ctrl+N). Open questions there: Ctrl+Alt is AltGr on many
/// European layouts, and some graphics drivers take Ctrl+Alt+arrows to rotate the screen; Ctrl+T and Ctrl+N are the
/// browser's own new tab and window, which Margin then takes only while it draws over the front window, as ⌘T on
/// the Mac. The Mac app's later commands (copy-url, focus-address, the pin, the archive, Quick Tab, Add Split, the
/// numbered space and row keys) have none on Windows until its hosted design decides them: the Windows shell's old
/// design binds none of them, whatever a copy sends ([`bindings_from`]).
pub fn default_for(command: AppCommand, os: Os) -> Option<&'static str> {
    use AppCommand as C;
    Some(match (os, command) {
        (Os::MacOs, C::NextTab) => "Alt+Meta+ArrowDown",
        (Os::MacOs, C::PrevTab) => "Alt+Meta+ArrowUp",
        (Os::MacOs, C::NextSpace) => "Alt+Meta+ArrowRight",
        (Os::MacOs, C::PrevSpace) => "Alt+Meta+ArrowLeft",
        (Os::MacOs, C::Palette) => "Meta+KeyT",
        (Os::MacOs, C::ToggleSidebar) => "Alt+KeyS",
        (Os::MacOs, C::NewWindow) => "Meta+KeyN",
        (Os::MacOs, C::CopyUrl) => "Shift+Meta+KeyC",
        (Os::MacOs, C::FocusAddress) => "Meta+KeyL",
        (Os::MacOs, C::TogglePin) => "Meta+KeyD",
        (Os::MacOs, C::ReopenArchived) => "Shift+Meta+KeyT",
        (Os::MacOs, C::LittleArc) => "Alt+Meta+KeyN",
        (Os::MacOs, C::AddSplit) => "Ctrl+Shift+Equal",
        (Os::MacOs, C::Space1) => "Ctrl+Digit1",
        (Os::MacOs, C::Space2) => "Ctrl+Digit2",
        (Os::MacOs, C::Space3) => "Ctrl+Digit3",
        (Os::MacOs, C::Space4) => "Ctrl+Digit4",
        (Os::MacOs, C::Space5) => "Ctrl+Digit5",
        (Os::MacOs, C::Space6) => "Ctrl+Digit6",
        (Os::MacOs, C::Space7) => "Ctrl+Digit7",
        (Os::MacOs, C::Space8) => "Ctrl+Digit8",
        (Os::MacOs, C::Space9) => "Ctrl+Digit9",
        (Os::MacOs, C::Item1) => "Meta+Digit1",
        (Os::MacOs, C::Item2) => "Meta+Digit2",
        (Os::MacOs, C::Item3) => "Meta+Digit3",
        (Os::MacOs, C::Item4) => "Meta+Digit4",
        (Os::MacOs, C::Item5) => "Meta+Digit5",
        (Os::MacOs, C::Item6) => "Meta+Digit6",
        (Os::MacOs, C::Item7) => "Meta+Digit7",
        (Os::MacOs, C::Item8) => "Meta+Digit8",
        (Os::MacOs, C::Item9) => "Meta+Digit9",
        (Os::Windows, C::NextTab) => "Ctrl+Alt+ArrowDown",
        (Os::Windows, C::PrevTab) => "Ctrl+Alt+ArrowUp",
        (Os::Windows, C::NextSpace) => "Ctrl+Alt+ArrowRight",
        (Os::Windows, C::PrevSpace) => "Ctrl+Alt+ArrowLeft",
        (Os::Windows, C::Palette) => "Ctrl+KeyT",
        (Os::Windows, C::ToggleSidebar) => "Alt+KeyS",
        (Os::Windows, C::NewWindow) => "Ctrl+KeyN",
        (Os::Windows, _) => return None,
    })
}

/// Every command's default on an OS (the commands it has).
pub fn defaults(os: Os) -> Vec<(AppCommand, &'static str)> {
    AppCommand::ALL.into_iter().filter_map(|c| default_for(c, os).map(|d| (c, d))).collect()
}

/// The combinations a copy sends for a command written for the Mac whatever the OS (see the module's "`Meta` on
/// Windows"): the palette's `Meta+KeyT`, the extension's built-in navigation defaults (Chrome's and the manifest
/// commands' `Ctrl+Meta+Arrow…`, Safari's `Alt+Meta+Arrow…`), and the Mac app's ⌘N.
pub fn mac_written(command: AppCommand) -> &'static [&'static str] {
    match command {
        AppCommand::NextTab => &["Alt+Meta+ArrowDown", "Ctrl+Meta+ArrowDown"],
        AppCommand::PrevTab => &["Alt+Meta+ArrowUp", "Ctrl+Meta+ArrowUp"],
        AppCommand::NextSpace => &["Alt+Meta+ArrowRight", "Ctrl+Meta+ArrowRight"],
        AppCommand::PrevSpace => &["Alt+Meta+ArrowLeft", "Ctrl+Meta+ArrowLeft"],
        AppCommand::Palette => &["Meta+KeyT"],
        AppCommand::NewWindow => &["Meta+KeyN"],
        _ => &[],
    }
}

/// Safari's own sidebar key, Margin's sidebar key too there (ShellSafariSidebar.swift: Safari's sidebar kept closed
/// under Margin). The Mac's only.
pub const SAFARI_SIDEBAR_KEY: &str = "Shift+Meta+KeyL";

/// The hot keys: each combination and its command.
pub type Bindings = BTreeMap<Combo, AppCommand>;

/// The defaults' bindings (Swift `ShortcutSet.bindings`).
pub fn default_bindings(os: Os) -> Bindings {
    bindings_from(&HashMap::new(), os, false)
}

/// The copy's `keys` (`{ command: [combination] }`) as bindings (Swift `ShortcutSet.bindings(from:safari:)`): a
/// command it doesn't name keeps its default; one it names with nothing usable has none; the palette always has
/// the OS's palette default too (⌘T, Ctrl+T); a combination two commands name goes to the first in
/// [`AppCommand::ALL`]'s order (the copy's Settings refuse that anyway). `safari` (the Mac's): ⇧⌘L is the sidebar's
/// too, unless another command has it. On Windows, a Mac-written combination is its command's Windows default.
pub fn bindings_from(keys: &HashMap<String, Vec<String>>, os: Os, safari: bool) -> Bindings {
    let mut out = Bindings::new();
    for command in AppCommand::ALL {
        // (A command not on this OS yet: none, whatever the copy sends.)
        let Some(default) = default_for(command, os) else { continue };
        let mut texts: Vec<&str> = match keys.get(command.name()) {
            Some(list) => list.iter().map(String::as_str).collect(),
            None => vec![default],
        };
        if os == Os::Windows {
            for t in texts.iter_mut() {
                if mac_written(command).contains(t) {
                    *t = default;
                }
            }
        }
        if command == AppCommand::Palette && !texts.contains(&default) {
            texts.push(default);
        }
        if command == AppCommand::ToggleSidebar && safari && !texts.contains(&SAFARI_SIDEBAR_KEY) {
            texts.push(SAFARI_SIDEBAR_KEY);
        }
        for text in texts {
            if let Some(combo) = Combo::parse(text) {
                out.entry(combo).or_insert(command);
            }
        }
    }
    out
}

/// The front window's bindings (Shell.updateKeys): its copy's, and while its page is in full screen (a video)
/// only the tab and space keys: the palette and the rest are the page's then.
pub fn bindings_for_front(
    keys: &HashMap<String, Vec<String>>,
    os: Os,
    safari: bool,
    page_fullscreen: bool,
) -> Bindings {
    let mut b = bindings_from(keys, os, safari);
    if page_fullscreen {
        b.retain(|_, c| c.repeats());
    }
    b
}

/// The keys Margin holds now, of `bindings` (Margin hosting apps in its own window): a hosted app in front
/// (`margin_in_front` false) keeps its sidebar key, and its own ⌘L, ⌘D, ⌘1–9… unless it's a browser
/// ([`AppCommand::browser_only`]); a numbered key with nothing behind it (more than the window's `spaces`, or its
/// sidebar's rows, `items`: its page says them) isn't held at all, so the press reaches the app in front (a hot key
/// can't pass one on). Counts not said yet: every number held.
pub fn held(
    bindings: &Bindings,
    margin_in_front: bool,
    browser: bool,
    spaces: Option<u32>,
    items: Option<u32>,
) -> Bindings {
    bindings
        .iter()
        .filter(|(_, command)| {
            if !margin_in_front && (**command == AppCommand::ToggleSidebar || (command.browser_only() && !browser)) {
                return false;
            }
            if let (Some(n), Some(spaces)) = (command.space_number(), spaces) {
                if n > spaces {
                    return false;
                }
            }
            if let (Some(n), Some(items)) = (command.item_number(), items) {
                if n > items {
                    return false;
                }
            }
            true
        })
        .map(|(c, a)| (*c, *a))
        .collect()
}

/// What's in front, for the hosted gates ([`hosted_active`], [`guards_quit`], [`guards_app_keys`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Front {
    /// The front app's pid (`None`: unread).
    pub pid: Option<u32>,
    /// Margin's own pid.
    pub own: u32,
    /// The front app is one Margin hosts.
    pub hosted: bool,
    /// A Margin window is open.
    pub window_open: bool,
    /// A Margin window is on the current Space (desktop).
    pub on_current_space: bool,
}

/// Margin hosting apps in its own window: its keys are the app's while Margin itself is the active app (one of its
/// windows open), or while an app it hosts is with a Margin window on the current Space; let go otherwise, so other
/// apps keep their keys. A hot key reaches Margin only: the hosted app never gets the same press too.
pub fn hosted_active(f: Front) -> bool {
    let Some(pid) = f.pid else { return false };
    if !f.window_open {
        return false;
    }
    pid == f.own || (f.hosted && f.on_current_space)
}

/// Whether ⌘Q and ⌥⌘Q are Margin's first (the quit guard): it isn't quitting already, Margin or an app it hosts is in
/// front ([`hosted_active`]), and either Margin asks before it quits (`asks`: its stored setting, off after "Always
/// quit") or it's a hosted app in front. With asking off the key in a hosted app is still Margin's: it quits Margin
/// without asking, never the hosted app alone, which would leave its item dead in Margin; with Margin itself in front
/// it's then Margin's own Quit. Never held for an app Margin doesn't host: ⌘Q there is that app's.
pub fn guards_quit(f: Front, asks: bool, quitting: bool) -> bool {
    !quitting && (asks || f.pid != Some(f.own)) && hosted_active(f)
}

/// Whether a hosted app's own keys ([`AppKey`]) are Margin's: an app Margin hosts is in front (not Margin itself,
/// whose menu has them), with a Margin window on the current Space, and Margin isn't quitting.
pub fn guards_app_keys(f: Front, quitting: bool) -> bool {
    !quitting && f.pid != Some(f.own) && hosted_active(f)
}

/// A Chrome or Edge app, any channel (bundle ids `com.google.Chrome…`, `com.microsoft.edgemac…`).
pub fn is_chromium_bundle(bundle: &str) -> bool {
    bundle.starts_with("com.google.Chrome") || bundle.starts_with("com.microsoft.edgemac")
}

/// A hosted app that is a browser (the browser-only keys are Margin's there): one of the browsers Margin links with
/// (`linked`: their bundle ids), or Chrome or Edge in any channel. (A Safari window a copy made is one too: the shell
/// says so before asking.)
pub fn is_browser_app(bundle: &str, linked: &HashSet<String>) -> bool {
    linked.contains(bundle) || is_chromium_bundle(bundle)
}

/// A hosted app's own key Margin takes while that app is in front ([`guards_app_keys`]), and what it is: in the
/// window Margin hosts each would take the window out of Margin (or close every tab of a Safari window), so Margin
/// does what its own menu would (⌘W its Close Tab) or nothing; in another window of the app's (a meeting, a draft),
/// ⌘W closes it and ⌘M minimizes it, as there. The shell does each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppKey {
    CloseTab,
    /// Safari: Close Window, every tab in it.
    CloseWindow,
    /// Safari: Close Other Tabs; most apps: Close All.
    CloseOthers,
    Minimize,
    Hide,
    /// Margin itself among the others.
    HideOthers,
    /// Out of Margin's Space, into one of its own.
    FullScreen,
}

impl AppKey {
    pub const ALL: [AppKey; 7] = [
        AppKey::CloseTab,
        AppKey::CloseWindow,
        AppKey::CloseOthers,
        AppKey::Minimize,
        AppKey::Hide,
        AppKey::HideOthers,
        AppKey::FullScreen,
    ];
    /// Its combination as Settings write one.
    pub fn text(self) -> &'static str {
        match self {
            AppKey::CloseTab => "Meta+KeyW",
            AppKey::CloseWindow => "Shift+Meta+KeyW",
            AppKey::CloseOthers => "Alt+Meta+KeyW",
            AppKey::Minimize => "Meta+KeyM",
            AppKey::Hide => "Meta+KeyH",
            AppKey::HideOthers => "Alt+Meta+KeyH",
            AppKey::FullScreen => "Ctrl+Meta+KeyF",
        }
    }
    /// For the log: "⌘W".
    pub fn name(self) -> &'static str {
        match self {
            AppKey::CloseTab => "⌘W",
            AppKey::CloseWindow => "⇧⌘W",
            AppKey::CloseOthers => "⌥⌘W",
            AppKey::Minimize => "⌘M",
            AppKey::Hide => "⌘H",
            AppKey::HideOthers => "⌥⌘H",
            AppKey::FullScreen => "⌃⌘F",
        }
    }
    pub fn combo(self) -> Combo {
        Combo::parse(self.text()).unwrap_or(Combo { code: "KeyW", modifiers: Modifiers::META })
    }
}

/// The quit guard's two combinations, and whether each keeps the windows (⌥⌘Q, a browser's Quit and Keep Windows).
pub const QUIT_KEYS: [(&str, bool); 2] = [("Meta+KeyQ", false), ("Alt+Meta+KeyQ", true)];

/// Whether Margin's keys are the app's now (Swift `ShortcutSet.active`): a linked browser is the active app and
/// its front window has Margin's overlay showing.
pub fn active(front_pid: Option<u32>, linked_pids: &HashSet<u32>, front_window_has_overlay: bool) -> bool {
    front_pid.is_some_and(|p| linked_pids.contains(&p)) && front_window_has_overlay
}

/// Whether the keys are held (Shell.updateKeys): [`active`], or mid-switch with a linked browser or Margin itself
/// in front (no overlay may be shown over the front window then, and the keys go to the switch). `mid_switch` is
/// the Swift `keysMidSwitch`, which only the Mac's handoff sets: the close-based switch (`switch.rs`) leaves it
/// false, so on Windows this is [`active`].
pub fn keys_held(
    front_pid: Option<u32>,
    linked_pids: &HashSet<u32>,
    front_window_has_overlay: bool,
    mid_switch: bool,
    own_pid: u32,
) -> bool {
    active(front_pid, linked_pids, front_window_has_overlay)
        || (mid_switch && front_pid.is_some_and(|p| linked_pids.contains(&p) || p == own_pid))
}

/// The overlay that last had the keys, and when (Shell.keysOverlay): a moment with none matched over the front
/// window (a window being made or moved, a desktop settling) keeps them for [`KeysFront::GRACE`] while its browser
/// stays in front, so a press then is still Margin's, not the page's (seen 2026-11-08). `K`: the shell's key for
/// an overlay (its link and window id).
#[derive(Clone, Debug, Default)]
pub struct KeysFront<K> {
    last: Option<(K, u32, Secs)>,
}

impl<K: Clone> KeysFront<K> {
    pub const GRACE: Secs = 1.0;

    pub fn new() -> Self {
        Self { last: None }
    }

    /// The overlay with the keys: `matched` (the front window's overlay, and its browser's pid), else the last one
    /// within the grace if its browser is still the front app and it's still shown.
    pub fn front(
        &mut self,
        matched: Option<(K, u32)>,
        front_pid: Option<u32>,
        now: Secs,
        shown: impl Fn(&K) -> bool,
    ) -> Option<K> {
        if let Some((key, pid)) = matched {
            self.last = Some((key.clone(), pid, now));
            return Some(key);
        }
        let (key, pid, at) = self.last.as_ref()?;
        (front_pid == Some(*pid) && now - at < Self::GRACE && shown(key)).then(|| key.clone())
    }
}

/// Where a key goes (Shell.run), for the front overlay.
#[derive(Clone, Debug, PartialEq)]
pub enum KeyRoute {
    /// Pushed to the front overlay as `{"type":"command","name":…}` (with `repeat` for a tab key): the palette
    /// and the sidebar, with no round trip through the browser; the tab keys, which the overlay highlights at once
    /// and then asks the copy for (overlay.ts navTab; 2026-11-07). [`command_push`] writes it.
    Overlay { name: &'static str, repeat: Option<bool> },
    /// ⌘N: a new Margin window from the front overlay's window (`across.rs` `new_margin_window`).
    NewWindow,
    /// A space key: across profiles first (`across.rs` `space_key`); not handled there, the copy's `navigate`
    /// with `action`.
    Space { dir: i32, action: &'static str },
    /// The copy's `navigate { action, windowId }` for the front overlay's window.
    Navigate { action: &'static str },
}

/// Where `command` goes. `overlay_ready`: the front overlay's page is ready (else a tab key goes to the copy).
pub fn route(command: AppCommand, is_repeat: bool, overlay_ready: bool) -> KeyRoute {
    match command {
        AppCommand::Palette | AppCommand::ToggleSidebar => KeyRoute::Overlay { name: command.name(), repeat: None },
        AppCommand::NewWindow => KeyRoute::NewWindow,
        AppCommand::NextSpace => KeyRoute::Space { dir: 1, action: command.name() },
        AppCommand::PrevSpace => KeyRoute::Space { dir: -1, action: command.name() },
        AppCommand::NextTab | AppCommand::PrevTab if overlay_ready => {
            KeyRoute::Overlay { name: command.name(), repeat: Some(is_repeat) }
        }
        AppCommand::NextTab | AppCommand::PrevTab => KeyRoute::Navigate { action: command.name() },
        // (The Mac app's later commands: never bound on Windows yet, the overlay's if ever.)
        _ => KeyRoute::Overlay { name: command.name(), repeat: None },
    }
}

/// The overlay's `command` message.
pub fn command_push(name: &str, repeat: Option<bool>) -> serde_json::Value {
    match repeat {
        Some(r) => serde_json::json!({ "type": "command", "name": name, "repeat": r }),
        None => serde_json::json!({ "type": "command", "name": name }),
    }
}

/// Registering and letting go of a hot key: the OS's (Carbon on the Mac, `RegisterHotKey` on Windows), or a test's
/// stand-in. The shell hands each hit to [`AppShortcuts::hit`] with its id.
pub trait HotKeyRegistrar {
    /// False if it can't be had (another app has it).
    fn register(&mut self, combo: &Combo, id: u32) -> bool;
    fn unregister(&mut self, id: u32);
}

/// A held key's repeat: the OS's own delay and rate (Mac: `NSEvent.keyRepeatDelay`, `keyRepeatInterval`; Windows:
/// [`KeyRepeat::windows`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeyRepeat {
    pub delay: Secs,
    pub interval: Secs,
}

impl Default for KeyRepeat {
    fn default() -> Self {
        Self { delay: 0.5, interval: 1.0 / 30.0 }
    }
}

impl KeyRepeat {
    /// From Windows' keyboard settings (`SystemParametersInfoW`): `SPI_GETKEYBOARDDELAY` 0–3 is about 250 ms to
    /// 1 s, `SPI_GETKEYBOARDSPEED` 0–31 about 2.5 to 30 repeats a second (Microsoft's documented ends; linear
    /// between them, as near as the docs say). Out-of-range values are clamped.
    pub fn windows(delay_setting: u32, speed_setting: u32) -> Self {
        let delay = 0.25 * (f64::from(delay_setting.min(3)) + 1.0);
        let rate = 2.5 + f64::from(speed_setting.min(31)) * (27.5 / 31.0);
        Self { delay, interval: 1.0 / rate }
    }
}

/// A command to run: whether it's a held key's repeat (not a press).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Run {
    pub command: AppCommand,
    pub is_repeat: bool,
}

/// A hot key pressed ([`AppShortcuts::press`]): one of Margin's keys, the quit guard's (⌥⌘Q: `keep_windows`), or a
/// hosted app's own key Margin took.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hit {
    Command(Run),
    Quit { keep_windows: bool },
    AppKey(AppKey),
}

#[derive(Clone, Copy, Debug)]
struct Repeating {
    id: u32,
    combo: Combo,
    command: AppCommand,
    next_at: Secs,
}

/// Margin's keys, held while they should be ([`keys_held`]) and let go otherwise (Swift `AppShortcuts`), sans IO:
/// the registrar is passed in, time is passed in, and the commands to run are returned.
///
/// Two ways to repeat a held key: the timer here (the Mac's: a hot key fires once a press; the shell calls
/// [`AppShortcuts::tick`] at [`AppShortcuts::next_tick`] and [`AppShortcuts::release`] as the key goes up), or the
/// OS's own repeats (Windows: `RegisterHotKey` without `MOD_NOREPEAT` sends `WM_HOTKEY` again at the keyboard rate,
/// and no release: the shell passes those to [`AppShortcuts::os_repeat`] and never calls `tick`).
#[derive(Debug)]
pub struct AppShortcuts {
    bindings: Vec<(Combo, AppCommand)>,
    active: bool,
    /// The quit guard and the hosted app's keys, held apart from Margin's keys by their own rules.
    guards_quit: bool,
    guards_app_keys: bool,
    /// Ids registered, so a rebind lets go of all of them.
    held: usize,
    /// The ones another app holds (tried again each time they're taken).
    unavailable: Vec<Combo>,
    key_repeat: KeyRepeat,
    repeating: Option<Repeating>,
}

impl AppShortcuts {
    /// The shortest wait before the first repeat, and between repeats, whatever the OS says.
    pub const MIN_DELAY: Secs = 0.05;
    pub const MIN_INTERVAL: Secs = 0.02;
    /// The ids of the quit guard's two keys, and of the hosted app's keys ([`AppKey::ALL`]'s order).
    pub const QUIT_ID_BASE: u32 = 900;
    pub const APP_KEY_ID_BASE: u32 = 920;

    pub fn new(bindings: Bindings, key_repeat: KeyRepeat) -> Self {
        Self {
            bindings: Self::ordered(bindings),
            active: false,
            guards_quit: false,
            guards_app_keys: false,
            held: 0,
            unavailable: Vec::new(),
            key_repeat,
            repeating: None,
        }
    }

    pub fn bindings(&self) -> &[(Combo, AppCommand)] {
        &self.bindings
    }
    pub fn is_active(&self) -> bool {
        self.active
    }
    pub fn guards_quit(&self) -> bool {
        self.guards_quit
    }
    pub fn guards_app_keys(&self) -> bool {
        self.guards_app_keys
    }

    /// The quit guard held or let go (⌘Q, ⌥⌘Q: [`guards_quit`] says when). Returns the combinations another app
    /// holds ("⌘Q is another app's: Margin can't ask before it quits by it").
    pub fn set_quit_guard(&mut self, registrar: &mut dyn HotKeyRegistrar, active: bool) -> Vec<Combo> {
        if active == self.guards_quit {
            return Vec::new();
        }
        self.guards_quit = active;
        let combos: Vec<Combo> = QUIT_KEYS.iter().filter_map(|(t, _)| Combo::parse(t)).collect();
        Self::guard(registrar, active, Self::QUIT_ID_BASE, &combos)
    }

    /// The hosted app's own keys held or let go ([`guards_app_keys`] says when). Returns the combinations another
    /// app holds ("⌘W is another app's: a hosted app keeps it").
    pub fn set_app_key_guard(&mut self, registrar: &mut dyn HotKeyRegistrar, active: bool) -> Vec<Combo> {
        if active == self.guards_app_keys {
            return Vec::new();
        }
        self.guards_app_keys = active;
        let combos: Vec<Combo> = AppKey::ALL.iter().map(|k| k.combo()).collect();
        Self::guard(registrar, active, Self::APP_KEY_ID_BASE, &combos)
    }

    fn guard(registrar: &mut dyn HotKeyRegistrar, active: bool, base: u32, combos: &[Combo]) -> Vec<Combo> {
        let mut taken = Vec::new();
        for (i, combo) in combos.iter().enumerate() {
            let id = base + u32::try_from(i).unwrap_or(0);
            if !active {
                registrar.unregister(id);
            } else if !registrar.register(combo, id) {
                taken.push(*combo);
            }
        }
        taken
    }

    /// A hot key pressed, whatever its id: a hosted app's key while that guard holds, the quit guard's while it
    /// holds, else one of Margin's keys ([`AppShortcuts::hit`]).
    pub fn press(&mut self, id: u32, now: Secs) -> Option<Hit> {
        if id >= Self::APP_KEY_ID_BASE {
            let key = AppKey::ALL.get(usize::try_from(id - Self::APP_KEY_ID_BASE).ok()?)?;
            return self.guards_app_keys.then_some(Hit::AppKey(*key));
        }
        if id >= Self::QUIT_ID_BASE {
            let (_, keep_windows) = QUIT_KEYS.get(usize::try_from(id - Self::QUIT_ID_BASE).ok()?)?;
            return self.guards_quit.then_some(Hit::Quit { keep_windows: *keep_windows });
        }
        self.hit(id, now).map(Hit::Command)
    }
    pub fn unavailable(&self) -> &[Combo] {
        &self.unavailable
    }
    pub fn set_key_repeat(&mut self, key_repeat: KeyRepeat) {
        self.key_repeat = key_repeat;
    }

    /// Ordered by command, then combination, so an id is the same for the same bindings.
    fn ordered(bindings: Bindings) -> Vec<(Combo, AppCommand)> {
        let mut v: Vec<(Combo, AppCommand)> = bindings.into_iter().collect();
        v.sort_by(|a, b| (a.1.name(), a.0).cmp(&(b.1.name(), b.0)));
        v
    }

    /// New combinations (the copy's `keys`): held at once if the keys are held now. Returns the ones another app
    /// holds, as [`AppShortcuts::set_active`] (none when nothing changed).
    pub fn rebind(&mut self, registrar: &mut dyn HotKeyRegistrar, next: Bindings) -> Vec<(Combo, AppCommand)> {
        let ordered = Self::ordered(next);
        if ordered == self.bindings {
            return Vec::new();
        }
        let was = self.active;
        self.set_active(registrar, false);
        self.bindings = ordered;
        self.set_active(registrar, was)
    }

    /// Held or let go. Returns the combinations another app holds that were just found so (for the log:
    /// "⌃⌘T (palette) is another app's: not Margin's").
    pub fn set_active(&mut self, registrar: &mut dyn HotKeyRegistrar, active: bool) -> Vec<(Combo, AppCommand)> {
        if active == self.active {
            return Vec::new();
        }
        self.active = active;
        let mut taken = Vec::new();
        if active {
            self.unavailable.clear();
            self.held = self.bindings.len();
            for (i, (combo, command)) in self.bindings.iter().enumerate() {
                let id = u32::try_from(i).unwrap_or(u32::MAX);
                if !registrar.register(combo, id) {
                    self.unavailable.push(*combo);
                    taken.push((*combo, *command));
                }
            }
        } else {
            self.repeating = None;
            for i in 0..self.bindings.len().max(self.held) {
                registrar.unregister(u32::try_from(i).unwrap_or(u32::MAX));
            }
        }
        taken
    }

    fn binding(&self, id: u32) -> Option<(Combo, AppCommand)> {
        if !self.active {
            return None;
        }
        self.bindings.get(usize::try_from(id).ok()?).copied()
    }

    /// A hot key pressed: its command, if the keys are held and it's one of them; a repeating one starts its
    /// repeat (the first after the delay).
    pub fn hit(&mut self, id: u32, now: Secs) -> Option<Run> {
        let (combo, command) = self.binding(id)?;
        self.repeating = None;
        if command.repeats() {
            let next_at = now + self.key_repeat.delay.max(Self::MIN_DELAY);
            self.repeating = Some(Repeating { id, combo, command, next_at });
        }
        Some(Run { command, is_repeat: false })
    }

    /// The OS's own repeat of a held hot key (Windows' `WM_HOTKEY` while the key is down): a repeat of a command
    /// that repeats, else nothing (the palette doesn't).
    pub fn os_repeat(&mut self, id: u32) -> Option<Run> {
        let (_, command) = self.binding(id)?;
        command.repeats().then_some(Run { command, is_repeat: true })
    }

    /// The hot key let go: its repeat stops.
    pub fn release(&mut self, id: u32) {
        if self.repeating.is_some_and(|r| r.id == id) {
            self.repeating = None;
        }
    }

    /// When [`AppShortcuts::tick`] is next due, while a key repeats.
    pub fn next_tick(&self) -> Option<Secs> {
        self.repeating.map(|r| r.next_at)
    }

    /// The repeat's clock: a repeat if one is due, the keys are held and the combination's modifiers are still down
    /// (the release can be missed, e.g. when another app comes forward: the repeat then stops at the next tick).
    pub fn tick(&mut self, now: Secs, modifiers_down: impl Fn(Modifiers) -> bool) -> Option<Run> {
        let r = self.repeating?;
        if now < r.next_at {
            return None;
        }
        if !self.active || !modifiers_down(r.combo.modifiers) {
            self.repeating = None;
            return None;
        }
        let next_at = now + self.key_repeat.interval.max(Self::MIN_INTERVAL);
        self.repeating = Some(Repeating { next_at, ..r });
        Some(Run { command: r.command, is_repeat: true })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(text: &str) -> Combo {
        Combo::parse(text).unwrap_or_else(|| panic!("{text} is a combination"))
    }
    fn keys(pairs: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.iter().map(|s| s.to_string()).collect())).collect()
    }

    #[derive(Default)]
    struct FakeRegistrar {
        held: BTreeMap<u32, Combo>,
        taken: Vec<Combo>,
        registrations: usize,
    }
    impl HotKeyRegistrar for FakeRegistrar {
        fn register(&mut self, combo: &Combo, id: u32) -> bool {
            self.registrations += 1;
            if self.taken.contains(combo) {
                return false;
            }
            self.held.insert(id, *combo);
            true
        }
        fn unregister(&mut self, id: u32) {
            self.held.remove(&id);
        }
    }
    impl FakeRegistrar {
        fn id(&self, text: &str) -> u32 {
            let combo = c(text);
            self.held.iter().find(|(_, v)| **v == combo).map(|(k, _)| *k).unwrap_or(u32::MAX)
        }
    }

    // app/platforms/macos/shell/tests/tests.swift shortcuts()
    #[test]
    fn parsing() {
        let down = c("Ctrl+Meta+ArrowDown");
        assert_eq!((down.code(), down.modifiers()), ("ArrowDown", Modifiers::CTRL.union(Modifiers::META)));
        assert_eq!(c("Meta+KeyT").code(), "KeyT");
        assert!(Combo::parse("KeyT").is_none() && Combo::parse("Shift+KeyT").is_none(), "no modifier: not one");
        assert!(Combo::parse("Meta+Banana").is_none(), "a key not known");
        assert!(Combo::parse("Meta+Meta+KeyT").is_none(), "a modifier twice");
        assert!(Combo::parse("Hyper+KeyT").is_none() && Combo::parse("").is_none() && Combo::parse("+").is_none());
        assert!(Combo::parse("Meta+F13").is_none(), "only the Swift's F keys: F1–F12 and F19");
        assert_eq!(Combo::parse("Meta++KeyT"), Some(c("Meta+KeyT")), "empty parts skipped, as Swift's split");
        assert!(Combo::parse(" Meta+KeyT").is_none(), "not trimmed, as the Swift's");
        assert_eq!(c("Ctrl+Meta+ArrowRight").to_string(), "⌃⌘ArrowRight", "its name");
        assert_eq!(c("Meta+Shift+Alt+Ctrl+F19").text(), "Ctrl+Alt+Shift+Meta+F19");
        assert!(
            Combo::parse("Alt+Comma").is_some()
                && Combo::parse("Ctrl+F5").is_some()
                && Combo::parse("Meta+Backquote").is_some()
        );
        assert_eq!(c("Ctrl+KeyT").scan_code(), 0x14);
        assert_eq!(c("Ctrl+Alt+ArrowDown").scan_code(), 0xE050);
        assert_eq!(c("Ctrl+Alt+Shift+Meta+KeyA").modifiers().windows(), 0xF);
        assert_eq!(c("Ctrl+KeyT").modifiers().windows(), 2);
        assert!(KEYS.iter().all(|(code, _, _)| Combo::parse(&format!("Alt+{code}")).is_some()));
        assert_eq!(KEYS.len(), 66);
        // The Mac's: Carbon's key codes and modifier bits, both ways.
        assert_eq!(c("Ctrl+Meta+ArrowDown").mac_key_code(), 125);
        assert_eq!(c("Meta+KeyT").mac_key_code(), 17);
        assert_eq!(c("Ctrl+Meta+ArrowDown").modifiers().carbon(), 0x1000 | 0x100);
        assert_eq!(c("Ctrl+Alt+Shift+Meta+F19").modifiers().carbon(), 0x1B00);
        assert_eq!(Combo::from_mac(125, 0x1100), Some(c("Ctrl+Meta+ArrowDown")));
        assert_eq!(Combo::from_mac(17, 0x200), None, "only Shift: not one");
        assert_eq!(Combo::from_mac(0xFF, 0x100), None, "a key not known");
        let codes: HashSet<u16> = KEYS.iter().map(|k| k.2).collect();
        assert_eq!(codes.len(), KEYS.len(), "every key its own Mac code");
        assert!(KEYS.iter().all(|(code, _, _)| Combo::from_mac(c(&format!("Meta+{code}")).mac_key_code(), 0x100)
            == Some(c(&format!("Meta+{code}")))));
    }

    #[test]
    fn commands() {
        for command in AppCommand::ALL {
            assert_eq!(AppCommand::parse(command.name()), Some(command));
        }
        assert!(AppCommand::NextSpace.repeats() && !AppCommand::Palette.repeats() && !AppCommand::NewWindow.repeats());
        assert_eq!(AppCommand::ALL.len(), 31);
        assert_eq!(AppCommand::Space3.space_number(), Some(3));
        assert_eq!(AppCommand::Item9.item_number(), Some(9));
        assert_eq!(AppCommand::Space1.item_number(), None);
        assert_eq!(AppCommand::Palette.space_number(), None);
        let browser_only: Vec<&str> = AppCommand::ALL.iter().filter(|c| c.browser_only()).map(|c| c.name()).collect();
        assert_eq!(
            browser_only,
            [
                "copy-url",
                "focus-address",
                "toggle-pin",
                "reopen-archived",
                "item-1",
                "item-2",
                "item-3",
                "item-4",
                "item-5",
                "item-6",
                "item-7",
                "item-8",
                "item-9"
            ]
        );
        assert_eq!(route(AppCommand::Palette, false, true), KeyRoute::Overlay { name: "palette", repeat: None });
        assert_eq!(
            route(AppCommand::ToggleSidebar, false, false),
            KeyRoute::Overlay { name: "toggle-sidebar", repeat: None }
        );
        assert_eq!(route(AppCommand::NextTab, true, true), KeyRoute::Overlay { name: "next-tab", repeat: Some(true) });
        assert_eq!(route(AppCommand::PrevTab, false, false), KeyRoute::Navigate { action: "prev-tab" });
        assert_eq!(route(AppCommand::PrevSpace, false, true), KeyRoute::Space { dir: -1, action: "prev-space" });
        assert_eq!(route(AppCommand::NewWindow, false, true), KeyRoute::NewWindow);
        assert_eq!(
            command_push("next-tab", Some(false)).to_string(),
            r#"{"type":"command","name":"next-tab","repeat":false}"#
        );
        assert_eq!(command_push("palette", None).to_string(), r#"{"type":"command","name":"palette"}"#);
    }

    #[test]
    fn the_defaults() {
        let mac = default_bindings(Os::MacOs);
        assert_eq!(mac.len(), 31, "every command a key by default on the Mac");
        assert_eq!(mac.get(&c("Meta+KeyN")), Some(&AppCommand::NewWindow));
        assert_eq!(mac.values().collect::<HashSet<_>>().len(), 31);
        // The Mac app's own, exactly.
        for (command, text) in [
            (AppCommand::CopyUrl, "Shift+Meta+KeyC"),
            (AppCommand::FocusAddress, "Meta+KeyL"),
            (AppCommand::TogglePin, "Meta+KeyD"),
            (AppCommand::ReopenArchived, "Shift+Meta+KeyT"),
            (AppCommand::LittleArc, "Alt+Meta+KeyN"),
            (AppCommand::AddSplit, "Ctrl+Shift+Equal"),
            (AppCommand::Space1, "Ctrl+Digit1"),
            (AppCommand::Space9, "Ctrl+Digit9"),
            (AppCommand::Item1, "Meta+Digit1"),
            (AppCommand::Item9, "Meta+Digit9"),
        ] {
            assert_eq!(mac.get(&c(text)), Some(&command), "{text}");
        }
        let win = default_bindings(Os::Windows);
        assert_eq!(win.len(), 7, "Windows: the first seven only, until its hosted design decides the rest");
        assert_eq!(win.get(&c("Ctrl+KeyT")), Some(&AppCommand::Palette));
        assert_eq!(win.get(&c("Ctrl+Alt+ArrowDown")), Some(&AppCommand::NextTab));
        assert_eq!(win.get(&c("Ctrl+Alt+ArrowLeft")), Some(&AppCommand::PrevSpace));
        assert_eq!(win.get(&c("Alt+KeyS")), Some(&AppCommand::ToggleSidebar));
        assert_eq!(win.get(&c("Ctrl+KeyN")), Some(&AppCommand::NewWindow));
        assert!(win.keys().all(|k| !k.modifiers().contains(Modifiers::META)), "no Windows-key defaults");
    }

    #[test]
    fn the_copys_keys() {
        let from_copy = keys(&[
            ("next-tab", &["Alt+Meta+ArrowDown", "Ctrl+Meta+ArrowDown"]),
            ("toggle-sidebar", &["Alt+KeyK"]),
            ("palette", &[]),
            ("prev-space", &["Banana"]),
        ]);
        let b = bindings_from(&from_copy, Os::MacOs, false);
        assert_eq!(b.get(&c("Alt+Meta+ArrowDown")), Some(&AppCommand::NextTab), "both of a command's");
        assert_eq!(b.get(&c("Ctrl+Meta+ArrowDown")), Some(&AppCommand::NextTab));
        assert_eq!(b.get(&c("Alt+KeyK")), Some(&AppCommand::ToggleSidebar), "the sidebar's own");
        assert_eq!(b.get(&c("Alt+KeyS")), None);
        assert_eq!(b.get(&c("Meta+KeyT")), Some(&AppCommand::Palette), "the palette is always ⌘T");
        assert_eq!(b.get(&c("Alt+Meta+ArrowUp")), Some(&AppCommand::PrevTab), "a command not named keeps its default");
        assert!(!b.values().any(|v| *v == AppCommand::PrevSpace), "a combination that isn't one: none for it");
        let one = bindings_from(&keys(&[("next-tab", &["Meta+KeyT"])]), Os::MacOs, false);
        assert_eq!(one.get(&c("Meta+KeyT")), Some(&AppCommand::NextTab), "one combination, one command (the first)");
        // ⇧⌘L, Safari's own sidebar key.
        let l = c(SAFARI_SIDEBAR_KEY);
        let safari = bindings_from(&HashMap::new(), Os::MacOs, true);
        assert_eq!(safari.get(&l), Some(&AppCommand::ToggleSidebar));
        assert_eq!(safari.get(&c("Alt+KeyS")), Some(&AppCommand::ToggleSidebar), "its own key kept");
        assert_eq!(default_bindings(Os::MacOs).get(&l), None, "not Safari: left alone");
        let taken = bindings_from(&keys(&[("palette", &[SAFARI_SIDEBAR_KEY])]), Os::MacOs, true);
        assert_eq!(taken.get(&l), Some(&AppCommand::Palette), "given to another command, stays that command's");
    }

    #[test]
    fn the_later_commands_not_on_windows_yet() {
        // What the extension's app keys send (app-keys.ts), written for the Mac.
        let copy =
            keys(&[("item-1", &["Meta+Digit1"]), ("copy-url", &["Shift+Meta+KeyC"]), ("space-2", &["Ctrl+Digit2"])]);
        let win = bindings_from(&copy, Os::Windows, false);
        assert!(
            !win.values().any(|v| v.item_number().is_some() || v.space_number().is_some() || *v == AppCommand::CopyUrl),
            "never bound on Windows, whatever the copy sends"
        );
        let mac = bindings_from(&copy, Os::MacOs, false);
        assert_eq!(mac.get(&c("Meta+Digit1")), Some(&AppCommand::Item1));
        assert_eq!(mac.get(&c("Ctrl+Digit2")), Some(&AppCommand::Space2));
        assert_eq!(route(AppCommand::CopyUrl, false, true), KeyRoute::Overlay { name: "copy-url", repeat: None });
    }

    #[test]
    fn held_while_hosting() {
        let all = default_bindings(Os::MacOs);
        let own = keys(&[("toggle-pin", &[]), ("item-1", &["Alt+Meta+Digit1"]), ("space-2", &[])]);
        let moved = bindings_from(&own, Os::MacOs, false);
        assert!(
            !moved.values().any(|v| *v == AppCommand::TogglePin || *v == AppCommand::Space2),
            "one turned off ([]) has none"
        );
        assert_eq!(moved.get(&c("Alt+Meta+Digit1")), Some(&AppCommand::Item1), "a numbered one moved");
        assert_eq!(moved.get(&c("Meta+Digit1")), None);
        assert_eq!(moved.get(&c("Meta+Digit2")), Some(&AppCommand::Item2));
        let native = held(&all, false, false, Some(3), Some(5));
        for k in ["Meta+KeyL", "Meta+KeyD", "Meta+Digit1", "Alt+KeyS"] {
            assert_eq!(native.get(&c(k)), None, "a native app in front keeps its {k}");
        }
        assert_eq!(native.get(&c("Ctrl+Digit3")), Some(&AppCommand::Space3));
        assert_eq!(native.get(&c("Ctrl+Digit4")), None, "past the window's spaces");
        assert_eq!(native.get(&c("Ctrl+Shift+Equal")), Some(&AppCommand::AddSplit));
        assert_eq!(native.get(&c("Alt+Meta+KeyN")), Some(&AppCommand::LittleArc));
        let chrome = held(&all, false, true, Some(3), Some(5));
        assert_eq!(chrome.get(&c("Meta+KeyD")), Some(&AppCommand::TogglePin));
        assert_eq!(chrome.get(&c("Meta+KeyL")), Some(&AppCommand::FocusAddress));
        assert_eq!(chrome.get(&c("Meta+Digit5")), Some(&AppCommand::Item5));
        assert_eq!(chrome.get(&c("Meta+Digit6")), None, "past the sidebar's rows");
        assert_eq!(chrome.get(&c("Alt+KeyS")), None, "the sidebar key stays the app's");
        assert_eq!(held(&all, true, false, None, None).len(), all.len(), "Margin in front, counts not said: all");
        assert!(
            held(&all, true, false, Some(1), Some(0))
                .values()
                .all(|v| v.item_number().is_none() && v.space_number().unwrap_or(1) <= 1)
        );
    }

    #[test]
    fn the_hosted_gates() {
        let f = |pid: Option<u32>, hosted: bool, open: bool, here: bool| Front {
            pid,
            own: 1,
            hosted,
            window_open: open,
            on_current_space: here,
        };
        assert!(hosted_active(f(Some(1), false, true, false)), "Margin in front with a window");
        assert!(hosted_active(f(Some(20), true, true, true)), "a hosted app, Margin's window on the current Space");
        assert!(!hosted_active(f(Some(20), true, true, false)), "on another Space: let go");
        assert!(!hosted_active(f(Some(30), false, true, true)), "an app Margin doesn't host");
        assert!(!hosted_active(f(Some(1), false, false, true)) && !hosted_active(f(None, true, true, true)));
        let q = |asks: bool, quitting: bool, pid: Option<u32>, hosted: bool, open: bool, here: bool| {
            guards_quit(f(pid, hosted, open, here), asks, quitting)
        };
        assert!(
            q(true, false, Some(20), true, true, true)
                && q(true, false, Some(1), false, true, true)
                && q(true, false, Some(1), false, true, false)
        );
        assert!(!q(true, false, Some(30), false, true, true) && !q(true, false, None, true, true, true));
        assert!(!q(true, false, Some(20), true, true, false), "a hosted app's own window on another Space");
        assert!(!q(true, false, Some(20), true, false, true) && !q(true, false, Some(1), false, false, true));
        assert!(
            q(false, false, Some(20), true, true, true) && !q(false, false, Some(1), false, true, true),
            "asking off: a hosted app still, Margin itself not"
        );
        assert!(!q(true, true, Some(20), true, true, true), "quitting already");
        let a = |quitting: bool, pid: Option<u32>, hosted: bool, open: bool, here: bool| {
            guards_app_keys(f(pid, hosted, open, here), quitting)
        };
        assert!(a(false, Some(20), true, true, true));
        assert!(
            !a(false, Some(1), false, true, true)
                && !a(false, Some(30), false, true, true)
                && !a(false, None, true, true, true)
        );
        assert!(
            !a(false, Some(20), true, false, true)
                && !a(false, Some(20), true, true, false)
                && !a(true, Some(20), true, true, true)
        );
        let linked: HashSet<String> = ["com.apple.Safari".to_string()].into();
        assert!(is_browser_app("com.apple.Safari", &linked) && is_browser_app("com.google.Chrome", &linked));
        assert!(
            is_browser_app("com.google.Chrome.beta", &linked) && is_browser_app("com.microsoft.edgemac.Dev", &linked)
        );
        assert!(!is_browser_app("com.apple.Notes", &linked) && !is_browser_app("com.apple.Terminal", &linked));
        assert_eq!(
            AppKey::ALL.map(|k| k.text()),
            [
                "Meta+KeyW",
                "Shift+Meta+KeyW",
                "Alt+Meta+KeyW",
                "Meta+KeyM",
                "Meta+KeyH",
                "Alt+Meta+KeyH",
                "Ctrl+Meta+KeyF"
            ]
        );
        assert!(
            AppKey::ALL.iter().all(|k| k.combo().modifiers().contains(Modifiers::META) && k.combo().text() == k.text())
        );
    }

    #[test]
    fn the_guards_held_apart() {
        let mut fake = FakeRegistrar::default();
        let mut keys_ = AppShortcuts::new(default_bindings(Os::MacOs), KeyRepeat::default());
        assert!(keys_.set_quit_guard(&mut fake, true).is_empty());
        assert_eq!(fake.held.len(), 2, "⌘Q and ⌥⌘Q, apart from Margin's keys (none held)");
        let q = *fake.held.iter().find(|(_, c_)| **c_ == c("Meta+KeyQ")).map(|(id, _)| id).expect("⌘Q held");
        let oq = *fake.held.iter().find(|(_, c_)| **c_ == c("Alt+Meta+KeyQ")).map(|(id, _)| id).expect("⌥⌘Q held");
        assert_eq!(keys_.press(q, 0.0), Some(Hit::Quit { keep_windows: false }));
        assert_eq!(keys_.press(oq, 0.0), Some(Hit::Quit { keep_windows: true }));
        keys_.set_active(&mut fake, true);
        keys_.set_active(&mut fake, false);
        assert!(fake.held.len() == 2 && keys_.guards_quit(), "Margin's keys coming and going leave it held");
        assert!(keys_.set_app_key_guard(&mut fake, true).is_empty());
        assert_eq!(fake.held.len(), 2 + 7);
        let w = *fake.held.iter().find(|(_, c_)| **c_ == c("Meta+KeyW")).map(|(id, _)| id).expect("⌘W held");
        let m = *fake.held.iter().find(|(_, c_)| **c_ == c("Meta+KeyM")).map(|(id, _)| id).expect("⌘M held");
        assert_eq!(keys_.press(w, 0.0), Some(Hit::AppKey(AppKey::CloseTab)));
        assert_eq!(keys_.press(m, 0.0), Some(Hit::AppKey(AppKey::Minimize)));
        keys_.set_quit_guard(&mut fake, false);
        assert_eq!(keys_.press(q, 0.0), None, "let go: the front app's again");
        assert_eq!(fake.held.len(), 7);
        keys_.set_app_key_guard(&mut fake, false);
        assert!(fake.held.is_empty() && keys_.press(w, 0.0).is_none());
        fake.taken = vec![c("Meta+KeyQ")];
        assert_eq!(keys_.set_quit_guard(&mut fake, true), vec![c("Meta+KeyQ")], "another app's: said");
        // Margin's own keys through press, as through hit.
        keys_.set_active(&mut fake, true);
        let t = keys_.bindings().iter().position(|(c_, _)| *c_ == c("Meta+KeyT")).expect("⌘T bound");
        assert_eq!(
            keys_.press(u32::try_from(t).expect("an id"), 0.0),
            Some(Hit::Command(Run { command: AppCommand::Palette, is_repeat: false }))
        );
    }

    #[test]
    fn the_copys_keys_on_windows() {
        // What a Chrome copy sends today (link.ts keyBindings with capabilities.ts's chrome defaults).
        let chrome = keys(&[
            ("next-tab", &["Ctrl+Meta+ArrowDown"]),
            ("prev-tab", &["Ctrl+Meta+ArrowUp"]),
            ("next-space", &["Ctrl+Meta+ArrowRight"]),
            ("prev-space", &["Ctrl+Meta+ArrowLeft"]),
            ("palette", &["Meta+KeyT"]),
            ("toggle-sidebar", &["Alt+KeyS"]),
        ]);
        let b = bindings_from(&chrome, Os::Windows, false);
        assert_eq!(b, default_bindings(Os::Windows), "the Mac-written ones are the Windows defaults");
        assert_eq!(b.get(&c("Meta+KeyT")), None, "never Win+T (the taskbar's)");
        assert_eq!(b.get(&c("Ctrl+ArrowDown")), None, "never Ctrl+arrows (every app's text keys)");
        // Recorded in Settings on Windows: as written, Meta the Windows key.
        let recorded =
            keys(&[("next-tab", &["Ctrl+Shift+KeyJ"]), ("prev-tab", &["Meta+KeyK"]), ("palette", &["Ctrl+KeyP"])]);
        let r = bindings_from(&recorded, Os::Windows, false);
        assert_eq!(r.get(&c("Ctrl+Shift+KeyJ")), Some(&AppCommand::NextTab));
        assert_eq!(r.get(&c("Meta+KeyK")), Some(&AppCommand::PrevTab), "a Windows-key recording kept");
        assert_eq!(r.get(&c("Ctrl+KeyP")), Some(&AppCommand::Palette));
        assert_eq!(r.get(&c("Ctrl+KeyT")), Some(&AppCommand::Palette), "the palette always Ctrl+T too");
        assert_eq!(r.get(&c("Ctrl+Alt+ArrowDown")), None, "a command named keeps only what it names");
        // A Mac-written combination named for another command isn't translated.
        let odd = bindings_from(&keys(&[("next-tab", &["Meta+KeyT"])]), Os::Windows, false);
        assert_eq!(odd.get(&c("Meta+KeyT")), Some(&AppCommand::NextTab));
        // The front window's page in full screen: only the tab and space keys.
        let video = bindings_for_front(&HashMap::new(), Os::Windows, false, true);
        assert_eq!(video.len(), 4);
        assert!(video.values().all(|c| c.repeats()));
    }

    #[test]
    fn the_gate() {
        let linked: HashSet<u32> = [10].into();
        assert!(active(Some(10), &linked, true), "the linked browser in front with its overlay");
        assert!(!active(Some(11), &linked, true), "another app in front");
        assert!(!active(Some(10), &linked, false), "its front window without an overlay");
        assert!(!active(None, &linked, true), "nothing in front");
        assert!(keys_held(Some(10), &linked, false, true, 99), "mid-switch: the browser in front");
        assert!(keys_held(Some(99), &linked, false, true, 99), "mid-switch: Margin itself in front");
        assert!(!keys_held(Some(11), &linked, false, true, 99), "mid-switch: another app");
        assert!(!keys_held(Some(10), &linked, false, false, 99));
    }

    #[test]
    fn the_front_overlay_kept_a_moment() {
        let mut f: KeysFront<&str> = KeysFront::new();
        assert_eq!(f.front(None, Some(10), 0.0, |_| true), None, "none yet");
        assert_eq!(f.front(Some(("w1", 10)), Some(10), 1.0, |_| true), Some("w1"));
        assert_eq!(f.front(None, Some(10), 1.9, |_| true), Some("w1"), "within the grace");
        assert_eq!(f.front(None, Some(10), 2.0, |_| true), None, "past it");
        assert_eq!(f.front(None, Some(11), 1.5, |_| true), None, "another app in front");
        assert_eq!(f.front(None, Some(10), 1.5, |_| false), None, "its overlay not shown");
    }

    #[test]
    fn held_and_let_go() {
        let mut fake = FakeRegistrar::default();
        let mut keys_ = AppShortcuts::new(default_bindings(Os::MacOs), KeyRepeat::default());
        assert!(fake.held.is_empty() && !keys_.is_active(), "not held at first");
        keys_.set_active(&mut fake, true);
        let all = AppCommand::ALL.len();
        assert!(fake.held.len() == all && keys_.is_active(), "held while active");
        keys_.set_active(&mut fake, true);
        assert_eq!(fake.registrations, all, "not registered twice");
        let next_tab = fake.id("Alt+Meta+ArrowDown");
        assert_eq!(keys_.hit(next_tab, 0.0).map(|r| r.command), Some(AppCommand::NextTab), "a key: its command");
        keys_.set_active(&mut fake, false);
        assert!(fake.held.is_empty() && !keys_.is_active(), "let go");
        assert_eq!(keys_.hit(next_tab, 0.0), None, "a stray hit after letting go: nothing");
        assert_eq!(keys_.hit(999, 0.0), None);
        fake.taken = vec![c("Meta+KeyT")];
        let taken = keys_.set_active(&mut fake, true);
        assert!(
            fake.held.len() == all - 1 && keys_.unavailable() == [c("Meta+KeyT")],
            "one another app holds: the rest still Margin's"
        );
        assert_eq!(taken, vec![(c("Meta+KeyT"), AppCommand::Palette)]);
        fake.taken = vec![];
        let from_copy = bindings_from(
            &keys(&[
                ("next-tab", &["Alt+Meta+ArrowDown", "Ctrl+Meta+ArrowDown"]),
                ("toggle-sidebar", &["Alt+KeyK"]),
                ("palette", &[]),
            ]),
            Os::MacOs,
            false,
        );
        keys_.rebind(&mut fake, from_copy.clone());
        assert!(keys_.is_active());
        let held: HashSet<Combo> = fake.held.values().copied().collect();
        assert_eq!(held, from_copy.keys().copied().collect(), "new keys while held: held at once");
        assert_eq!(fake.held.len(), from_copy.len());
        let toggle = fake.id("Alt+KeyK");
        assert_eq!(
            keys_.hit(toggle, 0.0).map(|r| r.command),
            Some(AppCommand::ToggleSidebar),
            "a new key: its command"
        );
        let before = fake.registrations;
        keys_.rebind(&mut fake, from_copy);
        assert_eq!(fake.registrations, before, "the same keys again: nothing registered again");
        keys_.set_active(&mut fake, false);
        assert!(fake.held.is_empty(), "let go after a rebind: none held");
        keys_.rebind(&mut fake, default_bindings(Os::MacOs));
        assert!(fake.held.is_empty() && !keys_.is_active(), "new keys while let go: none held");
    }

    #[test]
    fn a_held_key_repeats() {
        let rep = KeyRepeat { delay: 0.4, interval: 0.05 };
        let mut fake = FakeRegistrar::default();
        let mut held = AppShortcuts::new(default_bindings(Os::MacOs), rep);
        held.set_active(&mut fake, true);
        let down = fake.id("Alt+Meta+ArrowDown");
        let mods = |_: Modifiers| true;
        assert_eq!(
            held.hit(down, 10.0),
            Some(Run { command: AppCommand::NextTab, is_repeat: false }),
            "once at the press"
        );
        assert_eq!(held.next_tick(), Some(10.4), "again after the delay");
        assert_eq!(held.tick(10.3, mods), None, "not before it");
        let mut runs = vec![];
        for _ in 0..3 {
            let at = held.next_tick().unwrap_or(f64::INFINITY);
            runs.extend(held.tick(at, mods));
        }
        assert_eq!(runs.len(), 3);
        assert!(runs.iter().all(|r| r.is_repeat && r.command == AppCommand::NextTab), "the rest repeats");
        assert!((held.next_tick().unwrap_or(0.0) - 10.55).abs() < 1e-9, "then at the rate");
        held.release(down);
        assert_eq!(held.next_tick(), None, "let go: no more");
        held.hit(down, 20.0);
        assert_eq!(held.tick(20.4, |_| false), None, "the release missed, the modifiers up: it stops");
        assert_eq!(held.next_tick(), None);
        let palette = fake.id("Meta+KeyT");
        assert_eq!(held.hit(palette, 30.0).map(|r| r.command), Some(AppCommand::Palette));
        assert_eq!(held.next_tick(), None, "the palette key doesn't repeat");
        assert_eq!(held.os_repeat(palette), None, "nor by the OS's repeat");
        assert_eq!(
            held.os_repeat(down),
            Some(Run { command: AppCommand::NextTab, is_repeat: true }),
            "the OS's repeat"
        );
        held.hit(down, 40.0);
        held.set_active(&mut fake, false);
        assert_eq!(held.tick(41.0, mods), None, "keys let go (another app in front): the repeat stops");
        assert_eq!(held.os_repeat(down), None);
        // The OS's delay and rate, at their least.
        let mut quick = AppShortcuts::new(default_bindings(Os::MacOs), KeyRepeat { delay: 0.0, interval: 0.0 });
        quick.set_active(&mut fake, true);
        let d = fake.id("Alt+Meta+ArrowDown");
        quick.hit(d, 0.0);
        assert_eq!(quick.next_tick(), Some(0.05));
        quick.tick(0.05, mods);
        assert!((quick.next_tick().unwrap_or(0.0) - 0.07).abs() < 1e-9);
        // Another press while one repeats: the new one's.
        let up = fake.id("Alt+Meta+ArrowUp");
        quick.hit(up, 1.0);
        quick.release(d);
        assert_eq!(quick.tick(1.05, mods).map(|r| r.command), Some(AppCommand::PrevTab));
    }

    #[test]
    fn windows_key_repeat() {
        let slow = KeyRepeat::windows(3, 0);
        assert!((slow.delay - 1.0).abs() < 1e-9 && (slow.interval - 0.4).abs() < 1e-9);
        let fast = KeyRepeat::windows(0, 31);
        assert!((fast.delay - 0.25).abs() < 1e-9 && (fast.interval - 1.0 / 30.0).abs() < 1e-9);
        assert_eq!(KeyRepeat::windows(9, 99), KeyRepeat::windows(3, 31), "clamped");
    }
}

//! Margin's keys as the app's own hot keys (app/shell/Shortcuts.swift; PLAN.md §6, app/PROTOCOL.md "Keys"): a key
//! registered so never reaches the browser, so they're held only while a linked browser is the active app and its
//! front window has Margin's overlay, and let go the moment it isn't (another app in front must get its own keys).
//!
//! The keys: next and previous tab and space (the window's copy's `navigate`, or across profiles the app's switch:
//! `across.rs`), the palette (opened in the front window's overlay, which then takes the typing), the sidebar's
//! show/hide key, and a new Margin window (app/WINDOWS.md §5). A held tab or space key repeats at the OS's key
//! repeat, each repeat marked as one (Tirth, 2026-11-05): the copy takes repeats like presses, and a repeat never
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
//! Mac's (`shared/platform.ts`: `Ctrl+Meta+Arrow…`, Safari's `Alt+Meta+Arrow…`). Mapping every `Meta` to `Ctrl`
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
    /// A Margin window of its own (app/WINDOWS.md §5).
    NewWindow,
}

impl AppCommand {
    pub const ALL: [AppCommand; 7] = [
        AppCommand::NextTab,
        AppCommand::PrevTab,
        AppCommand::NextSpace,
        AppCommand::PrevSpace,
        AppCommand::Palette,
        AppCommand::ToggleSidebar,
        AppCommand::NewWindow,
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
        }
    }

    pub fn parse(name: &str) -> Option<AppCommand> {
        Self::ALL.into_iter().find(|c| c.name() == name)
    }

    /// Held down, these run again at the key repeat (a hot key itself fires once).
    pub fn repeats(self) -> bool {
        matches!(self, AppCommand::NextTab | AppCommand::PrevTab | AppCommand::NextSpace | AppCommand::PrevSpace)
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

/// The keys Margin's hot keys can be (the Swift `Combo.keyCodes`), each with its PS/2 set-1 scan code (0xE0
/// prefixed in the high byte for the extended ones). A `code` is a key's place, so the Windows shell gets the key
/// for the person's layout with `MapVirtualKeyW(scan, MAPVK_VSC_TO_VK_EX)`, as Carbon's `kVK_ANSI_*` are places too.
const KEYS: &[(&str, u16)] = &[
    ("ArrowDown", 0xE050),
    ("ArrowUp", 0xE048),
    ("ArrowLeft", 0xE04B),
    ("ArrowRight", 0xE04D),
    ("KeyA", 0x1E),
    ("KeyB", 0x30),
    ("KeyC", 0x2E),
    ("KeyD", 0x20),
    ("KeyE", 0x12),
    ("KeyF", 0x21),
    ("KeyG", 0x22),
    ("KeyH", 0x23),
    ("KeyI", 0x17),
    ("KeyJ", 0x24),
    ("KeyK", 0x25),
    ("KeyL", 0x26),
    ("KeyM", 0x32),
    ("KeyN", 0x31),
    ("KeyO", 0x18),
    ("KeyP", 0x19),
    ("KeyQ", 0x10),
    ("KeyR", 0x13),
    ("KeyS", 0x1F),
    ("KeyT", 0x14),
    ("KeyU", 0x16),
    ("KeyV", 0x2F),
    ("KeyW", 0x11),
    ("KeyX", 0x2D),
    ("KeyY", 0x15),
    ("KeyZ", 0x2C),
    ("Space", 0x39),
    ("F19", 0x6A),
    ("Digit0", 0x0B),
    ("Digit1", 0x02),
    ("Digit2", 0x03),
    ("Digit3", 0x04),
    ("Digit4", 0x05),
    ("Digit5", 0x06),
    ("Digit6", 0x07),
    ("Digit7", 0x08),
    ("Digit8", 0x09),
    ("Digit9", 0x0A),
    ("Enter", 0x1C),
    ("Backquote", 0x29),
    ("Minus", 0x0C),
    ("Equal", 0x0D),
    ("BracketLeft", 0x1A),
    ("BracketRight", 0x1B),
    ("Backslash", 0x2B),
    ("Semicolon", 0x27),
    ("Quote", 0x28),
    ("Comma", 0x33),
    ("Period", 0x34),
    ("Slash", 0x35),
    ("F1", 0x3B),
    ("F2", 0x3C),
    ("F3", 0x3D),
    ("F4", 0x3E),
    ("F5", 0x3F),
    ("F6", 0x40),
    ("F7", 0x41),
    ("F8", 0x42),
    ("F9", 0x43),
    ("F10", 0x44),
    ("F11", 0x57),
    ("F12", 0x58),
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
        let code = KEYS.iter().find(|(c, _)| *c == last)?.0;
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
        KEYS.iter().find(|(c, _)| *c == self.code).map(|k| k.1).unwrap_or(0)
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

/// The app's default combination for a command on an OS. macOS: exactly the Swift's. **Windows: provisional, to
/// pick with Tirth** (⌘ → Ctrl, ⌥ → Alt: tabs Ctrl+Alt+↓/↑, spaces Ctrl+Alt+→/←, palette Ctrl+T, sidebar Alt+S, new
/// window Ctrl+N). Open questions there: Ctrl+Alt is AltGr on many European layouts, and some graphics drivers
/// take Ctrl+Alt+arrows to rotate the screen; Ctrl+T and Ctrl+N are the browser's own new tab and window, which
/// Margin then takes only while it draws over the front window, as ⌘T on the Mac.
pub fn default_for(command: AppCommand, os: Os) -> &'static str {
    match (os, command) {
        (Os::MacOs, AppCommand::NextTab) => "Alt+Meta+ArrowDown",
        (Os::MacOs, AppCommand::PrevTab) => "Alt+Meta+ArrowUp",
        (Os::MacOs, AppCommand::NextSpace) => "Alt+Meta+ArrowRight",
        (Os::MacOs, AppCommand::PrevSpace) => "Alt+Meta+ArrowLeft",
        (Os::MacOs, AppCommand::Palette) => "Meta+KeyT",
        (Os::MacOs, AppCommand::ToggleSidebar) => "Alt+KeyS",
        (Os::MacOs, AppCommand::NewWindow) => "Meta+KeyN",
        (Os::Windows, AppCommand::NextTab) => "Ctrl+Alt+ArrowDown",
        (Os::Windows, AppCommand::PrevTab) => "Ctrl+Alt+ArrowUp",
        (Os::Windows, AppCommand::NextSpace) => "Ctrl+Alt+ArrowRight",
        (Os::Windows, AppCommand::PrevSpace) => "Ctrl+Alt+ArrowLeft",
        (Os::Windows, AppCommand::Palette) => "Ctrl+KeyT",
        (Os::Windows, AppCommand::ToggleSidebar) => "Alt+KeyS",
        (Os::Windows, AppCommand::NewWindow) => "Ctrl+KeyN",
    }
}

/// Every command's default on an OS.
pub fn defaults(os: Os) -> Vec<(AppCommand, &'static str)> {
    AppCommand::ALL.into_iter().map(|c| (c, default_for(c, os))).collect()
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
        AppCommand::ToggleSidebar => &[],
        AppCommand::NewWindow => &["Meta+KeyN"],
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
        let default = default_for(command, os);
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
        let palette = default_for(AppCommand::Palette, os);
        if command == AppCommand::Palette && !texts.contains(&palette) {
            texts.push(palette);
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
/// stays in front, so a press then is still Margin's, not the page's (Tirth, 2026-11-08). `K`: the shell's key for
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
    /// and then asks the copy for (overlay.ts navTab; Tirth, 2026-11-07). [`command_push`] writes it.
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

    pub fn new(bindings: Bindings, key_repeat: KeyRepeat) -> Self {
        Self {
            bindings: Self::ordered(bindings),
            active: false,
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

    /// New combinations (the copy's `keys`): held at once if the keys are held now.
    pub fn rebind(&mut self, registrar: &mut dyn HotKeyRegistrar, next: Bindings) {
        let ordered = Self::ordered(next);
        if ordered == self.bindings {
            return;
        }
        let was = self.active;
        self.set_active(registrar, false);
        self.bindings = ordered;
        self.set_active(registrar, was);
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

    // tools/app-tests/tests.swift shortcuts()
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
        assert!(KEYS.iter().all(|(code, _)| Combo::parse(&format!("Alt+{code}")).is_some()));
        assert_eq!(KEYS.len(), 66);
    }

    #[test]
    fn commands() {
        for command in AppCommand::ALL {
            assert_eq!(AppCommand::parse(command.name()), Some(command));
        }
        assert!(AppCommand::NextSpace.repeats() && !AppCommand::Palette.repeats() && !AppCommand::NewWindow.repeats());
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
        assert_eq!(mac.len(), 7, "seven keys by default");
        assert_eq!(mac.get(&c("Meta+KeyN")), Some(&AppCommand::NewWindow));
        assert_eq!(mac.values().collect::<HashSet<_>>().len(), 7);
        let win = default_bindings(Os::Windows);
        assert_eq!(win.len(), 7);
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
    fn the_copys_keys_on_windows() {
        // What a Chrome copy sends today (link.ts keyBindings with platform.ts's chrome defaults).
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
        assert!(fake.held.len() == 7 && keys_.is_active(), "held while active");
        keys_.set_active(&mut fake, true);
        assert_eq!(fake.registrations, 7, "not registered twice");
        let next_tab = fake.id("Alt+Meta+ArrowDown");
        assert_eq!(keys_.hit(next_tab, 0.0).map(|r| r.command), Some(AppCommand::NextTab), "a key: its command");
        keys_.set_active(&mut fake, false);
        assert!(fake.held.is_empty() && !keys_.is_active(), "let go");
        assert_eq!(keys_.hit(next_tab, 0.0), None, "a stray hit after letting go: nothing");
        assert_eq!(keys_.hit(999, 0.0), None);
        fake.taken = vec![c("Meta+KeyT")];
        let taken = keys_.set_active(&mut fake, true);
        assert!(
            fake.held.len() == 6 && keys_.unavailable() == [c("Meta+KeyT")],
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

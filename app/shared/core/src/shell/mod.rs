//! Margin's shell as a whole, OS-neutral and sans IO (app/platforms/macos/shell/Shell.swift, with ShellProfiles.swift's and
//! ShellThemes.swift's wiring and the OS-neutral half of Overlay.swift and OverlayWebView.swift's page handling): it
//! joins the links to Margin's extension copies (one per browser profile, [`crate::link::Link`]) and each copy's
//! state ([`crate::mirror::StateMirror`]) to what the OS says of the browsers' windows, and keeps one overlay over
//! each of the browser's windows Margin draws around. The OS layer (margin-windows `host.rs`) feeds it [`Input`]s
//! and carries out the [`Command`]s it returns; it calls [`Shell::handle`] again at [`Shell::next_wake`] with
//! [`Input::Tick`]. Every time is the caller's `now` (seconds since 1970: the extension's `focusedAt` and
//! `createdAt` are on that clock).
//!
//! What it does, as Shell.swift (its constants, order and log lines):
//! - Nothing happens until a linked browser has come to the front. From then on, the windows are read 4 times a
//!   second while a linked browser is in front, once a second otherwise, and 30 times a second for a second after
//!   anything that moves windows ([`Command::ReadWindows`]; the OS layer reads and answers [`Input::Windows`]).
//! - Each copy's windows are bound to the OS's from evidence ([`crate::binder::WindowBinder`]); a window not bound
//!   gets nothing drawn over it. An overlay shows once its page has drawn, while its window is on screen, in full
//!   screen and filling its display ([`crate::planner::decide`]), and is put back above its window when something
//!   comes between them.
//! - Each overlay's page reports the slot (`layout`), sent to the copy as `setLayout` when it changes
//!   ([`outbox::LayoutOutbox`]), and what it draws over the slot (`hits`): the pointer passes through to the page
//!   over the slot ([`crate::passthrough::PassThrough`]).
//! - Each copy is told per window whether the app draws over it (`drawn`, [`outbox::DrawnOutbox`]).
//! - Margin's keys are the app's only while a linked browser is in front with an overlay shown over its front
//!   window, with the combinations that window's copy sent (`keys`); [`Command::HotKeys`].
//! - A link that drops (not replaced, not a goodbye) leaves its overlays where they are for 6 s, dimmed (the page's
//!   `link: reconnecting`); the copy linking again takes them back, else they close.
//! - The lasting data ([`crate::data::sync::DataSync`]), spaces across profiles ([`crate::across`],
//!   [`crate::data::profiles::BrowserProfiles`]), the close-based switch to another profile's space
//!   ([`crate::switch::ProfileSwitch`]) and imported themes ([`crate::data::themes::ThemeStore`]).
//!
//! **One link, every OS.** Each copy links over its own WebSocket to 127.0.0.1 ([`crate::socket::SocketLink`]),
//! as on the Mac: the transport says each TCP connection's bytes ([`Input::SocketBytes`]) and the shell answers
//! with bytes to write ([`Command::Write`]). Chrome's and Edge's copies find the app through Margin's connector
//! ([`crate::relay::RelayHub`], over a Unix socket or a named pipe: [`Input::RelayBytes`]), which only answers
//! their native messages and hands them the `link` (the port, the token, the key); nothing of the link goes
//! through it. A link's browser and pid are its hello's, which the copy says as its relay told it (the pid, the
//! browser's own main process) and as its user agent says (`edge`): the Mac trusts them the same way (Shell.swift
//! `linkedPids`, RelayLink.swift); the token is what proves the copy is Margin's. Only windows of that pid's
//! process tree ([`BrowserProcess::root`]) are that link's candidates; a hello with no pid has every window of its
//! browser's processes.
//!
//! Left out of Shell.swift (the Mac's), one line each:
//! - Spaces: the own-Space checks, `spaceDidChange`, `placeAhead`, the Space bridge, the window map's Space reads.
//! - Accessibility (SafariAX): window profiles from titles, its window events, opening a profile's window.
//! - Safari's own sidebar (ShellSafariSidebar.swift) and the covers over Safari's windows (ShellCovers.swift).
//! - iCloud Tabs (ShellCloudTabs.swift): every hello says `cloudTabs: null`; `cloud.access` is logged.
//! - The private calls, the profile handoff, parking and the freeze (PrivateCalls.swift, ShellHandoff.swift):
//!   `parkedActivity` pushes are ignored, `framed` and `switch.coverShown` do nothing.
//! - EdgeStop (the pointer kept off Safari's left edge), BundleWatch (an update replacing the app), DevHooks.
//! - The quit guard and prompt (`quitBrowser`: ⌘Q with windows parked), the key relay (a key reaching Margin.app
//!   with none of its windows key: on Windows the overlay never takes the keyboard on a click).
//! - The window trace and the placer's check (OverlayPlacer.swift: Spaces and window-server order quirks of the Mac).
//! - Safari's profile names and the carry-over of a profile's set to new ids (SafariProfiles.swift).

mod outbox;
mod overlay;
mod pages;
mod profiles;
#[cfg(test)]
mod tests;
mod track;

pub use outbox::{DrawnGrace, DrawnOffer, DrawnOutbox, HeldPushes, LayoutOutbox};
pub use overlay::{OverlayId, OverlayModel};

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::across::Across;
use crate::chunks::{self, ChunkAssembler};
use crate::data::profiles::BrowserProfiles;
use crate::data::store::DataStore;
use crate::data::sync::{self as datasync, DataSync, Effects};
use crate::data::themes::{ThemeFile, ThemeStore};
use crate::geometry::{Point, Rect};
use crate::json::{self, Object};
use crate::link::{self, Action, ConnId, LinkError};
use crate::mirror::{Outcome, Resync, StateMirror};
use crate::planner::Display;
use crate::protocol::{AppMessage, Hello, LinkMessage};
use crate::relay::{RelayHub, RelayOut};
use crate::shortcuts::{AppCommand, AppShortcuts, Combo, HotKeyRegistrar, KeyRepeat, KeysFront, Os};
use crate::socket::{self, SocketLink};
use crate::switch::{ProfileSwitch, SwitchOptions};
use crate::system::ServerWindow;
use crate::time::Secs;

/// A window of a copy: its link (`browser:profile`) and the extension's window id (the binder's).
pub use crate::binder::WindowKey;

/// The driver's name for one page op's answer (its `rid`, kept by the driver).
pub type ReplyToken = u64;

/// One process with a browser window: its browser (`chrome`, `edge`) and the browser's main process it belongs to
/// (itself for the main process, which owns every top-level window of a Chromium browser).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserProcess {
    pub pid: u32,
    pub browser: String,
    pub root: u32,
}

/// One read of the OS's windows (the Mac's `WindowSource.read` and the front app).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WindowRead {
    /// The browsers' windows, Margin's own and every on-screen window of other processes, front to back (DIPs).
    pub list: Vec<ServerWindow>,
    /// The process of the window in front (it has the keyboard).
    pub front_pid: Option<u32>,
    /// The window in front.
    pub front_window: Option<i64>,
    /// Every process with a browser window.
    pub browsers: Vec<BrowserProcess>,
    /// The displays (DIPs), for whether a window fills one (full screen).
    pub displays: Vec<Display>,
}

/// What the OS layer tells the shell.
#[derive(Clone, Debug)]
pub enum Input {
    /// The link's listener (127.0.0.1) has this port now, or none (failed, being made again).
    Listening {
        port: Option<u16>,
    },
    /// A TCP connection to the listener, accepted ([`socket::SocketLink::on_accept`]).
    SocketOpened {
        conn: ConnId,
    },
    /// Bytes on it, as they came.
    SocketBytes {
        conn: ConnId,
        bytes: Vec<u8>,
    },
    /// It ended (exactly once, also after [`Command::End`]); `error`: how it failed, if it did.
    SocketEnded {
        conn: ConnId,
        error: Option<String>,
    },
    /// A relay (Margin's connector, started by the browser) connected; the transport checked it's this user's
    /// connector. Relays are named apart from sockets.
    RelayOpened {
        conn: ConnId,
    },
    /// Bytes from it (JSON lines), as they came.
    RelayBytes {
        conn: ConnId,
        bytes: Vec<u8>,
    },
    RelayEnded {
        conn: ConnId,
    },
    /// The windows, read (after [`Command::ReadWindows`], or whenever the layer reads them).
    Windows(WindowRead),
    /// Something moved windows (a window event, a display change): read often for a moment.
    Burst(String),
    /// The pointer (DIPs) and whether a button is down; `pressed`: one went down since the last.
    Pointer {
        at: Point,
        buttons: bool,
        pressed: bool,
    },
    /// A hot key of [`Command::HotKeys`] (its id); `repeat`: the OS's repeat of a held key.
    HotKey {
        id: u32,
        repeat: bool,
    },
    /// The overlay's page said `op` (`reply`: it waits for an answer, which the shell always gives).
    PageOp {
        id: OverlayId,
        op: String,
        body: Object,
        reply: Option<ReplyToken>,
    },
    /// The page loaded (or didn't).
    PageLoaded {
        id: OverlayId,
        ok: bool,
    },
    /// The page's process died.
    PageCrashed {
        id: OverlayId,
    },
    /// The overlay's own window was made: its number (an HWND's value).
    OverlayWindow {
        id: OverlayId,
        number: i64,
    },
    /// The overlay's window became the foreground window (it has the keyboard), or stopped being it.
    OverlayFocus {
        id: OverlayId,
        has: bool,
    },
    /// What the person chose in the theme picker ([`Command::PickThemeFile`]), read
    /// ([`crate::data::themes::read_chosen`], off the UI thread); `None`: cancelled.
    ThemeFileRead {
        id: OverlayId,
        file: Option<ThemeFile>,
    },
    /// The time ([`Shell::next_wake`]).
    Tick,
    /// The app is quitting.
    Stop {
        why: String,
    },
}

/// One hot key to hold: the shell's id for it, its combination and command, and whether it repeats.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HotKey {
    pub id: u32,
    pub combo: Combo,
    pub command: AppCommand,
    pub repeats: bool,
}

/// What the OS layer does, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    /// These bytes on that TCP connection (the link's WebSocket), in order.
    Write {
        conn: ConnId,
        bytes: Vec<u8>,
    },
    /// Close that TCP connection once what was written before has gone; [`Input::SocketEnded`] follows.
    End {
        conn: ConnId,
    },
    /// These bytes (JSON lines) to that relay.
    RelayWrite {
        conn: ConnId,
        bytes: Vec<u8>,
    },
    /// Close that relay's connection now.
    RelayEnd {
        conn: ConnId,
    },
    /// Make an overlay (hidden, its web view loading the page) and say its window's number
    /// ([`Input::OverlayWindow`]).
    CreateOverlay {
        id: OverlayId,
    },
    /// Show it over `frame` (DIPs), just above window `above`.
    ShowOverlay {
        id: OverlayId,
        frame: Rect,
        above: i64,
    },
    /// Move it to `frame`, just above `above`, shown or not as it is (its web view sized with it).
    PlaceOverlay {
        id: OverlayId,
        frame: Rect,
        above: i64,
    },
    /// Back just above `above` in the z-order, if something came between.
    RestackOverlay {
        id: OverlayId,
        above: i64,
    },
    HideOverlay {
        id: OverlayId,
    },
    /// Unseen where it is (`on`), or seen again; the pointer passes through while unseen.
    ConcealOverlay {
        id: OverlayId,
        on: bool,
    },
    /// Load its page again (its process died).
    ReloadOverlay {
        id: OverlayId,
    },
    DestroyOverlay {
        id: OverlayId,
    },
    /// `marginApp.receive(json)` in its page.
    Receive {
        id: OverlayId,
        json: String,
    },
    /// The answer to a page op.
    Reply {
        token: ReplyToken,
        result: Result<Value, String>,
    },
    /// The pointer passes through it to the page (`on`), or it takes it.
    SetPassThrough {
        id: OverlayId,
        on: bool,
    },
    /// It takes the keyboard (the foreground, and the page's focus).
    TakeKeyboard {
        id: OverlayId,
    },
    /// The keyboard back to the browser's window `to`.
    HandBack {
        id: OverlayId,
        to: Option<i64>,
    },
    /// The hot keys to hold from now on (none: let them all go).
    HotKeys {
        keys: Vec<HotKey>,
    },
    /// Watch the pointer ([`Input::Pointer`]) or stop.
    PointerWatch {
        on: bool,
    },
    /// Read the windows now and answer [`Input::Windows`].
    ReadWindows,
    /// The file picker (a folder or a `.margintheme` file) over that overlay's window; [`Input::ThemeFileRead`].
    PickThemeFile {
        id: OverlayId,
    },
    /// Put text on the clipboard (an iCloud tab's Copy Link: at most 8192 characters).
    CopyText {
        text: String,
    },
    Log {
        warn: bool,
        text: String,
    },
}

/// The commands of one call, and its log lines among them.
#[derive(Debug, Default)]
pub struct Out(pub Vec<Command>);

impl Out {
    pub fn push(&mut self, c: Command) {
        self.0.push(c);
    }
    pub fn note(&mut self, text: impl Into<String>) {
        self.0.push(Command::Log { warn: false, text: text.into() });
    }
    pub fn warn(&mut self, text: impl Into<String>) {
        self.0.push(Command::Log { warn: true, text: text.into() });
    }
}

/// `Shell.Options`, the parts that aren't the Mac's.
#[derive(Clone, Debug)]
pub struct Options {
    /// A linked browser in front.
    pub rest_poll: Secs,
    /// Not in front.
    pub idle_poll: Secs,
    pub burst_poll: Secs,
    pub burst_for: Secs,
    pub resync_retry: Secs,
    /// The pointer handed to a page wanting it, at most this often.
    pub pointer_every: Secs,
    /// Overlays over windows that aren't in full screen too (the Mac's Phase 4 `windowedToo`: off there).
    pub windowed_too: bool,
    /// A dropped link's overlays, kept dimmed (background/link.ts GONE_MS).
    pub reconnect_grace: Secs,
    pub drawn_grace: DrawnGrace,
    /// A `palette` push for a window with no overlay shown, held this long.
    pub palette_hold: Secs,
    /// A window its copy heard made this recently has its new-tab launcher focused as its overlay first shows.
    pub launcher_focus_within: Secs,
    /// The lasting data's folder (DataStore) and the imported themes' (ThemeStore).
    pub data_root: PathBuf,
    pub themes_root: PathBuf,
    /// Whose keys (the hot keys' defaults).
    pub os: Os,
    /// `platform.os` in each overlay's hello.
    pub platform_os: String,
    /// The OS's key repeat (the copy takes repeats like presses).
    pub key_repeat: KeyRepeat,
    /// Margin's own process (its windows in a read are its overlays).
    pub own_pid: u32,
    /// The app's version: the `link`'s `app.version` and `relayWelcome`'s (a relay of another version exits).
    pub app_version: String,
    pub link: link::Timing,
    pub switch: SwitchOptions,
}

impl Options {
    /// The defaults, with the data and themes under these folders.
    pub fn new(data_root: impl Into<PathBuf>, themes_root: impl Into<PathBuf>) -> Self {
        let switch = SwitchOptions {
            not_shown_words: "Windows didn’t show its window: click it in the taskbar".into(),
            ..SwitchOptions::default()
        };
        Self {
            rest_poll: 0.25,
            idle_poll: 1.0,
            burst_poll: 1.0 / 30.0,
            burst_for: 1.0,
            resync_retry: Resync::RETRY,
            pointer_every: 1.0 / 30.0,
            windowed_too: false,
            reconnect_grace: 6.0,
            drawn_grace: DrawnGrace::default(),
            palette_hold: 1.5,
            launcher_focus_within: 10.0,
            data_root: data_root.into(),
            themes_root: themes_root.into(),
            os: Os::Windows,
            platform_os: "win".into(),
            key_repeat: KeyRepeat::default(),
            own_pid: 0,
            app_version: String::new(),
            link: link::Timing::default(),
            switch,
        }
    }
}

/// One copy's link (`Shell.Link`).
pub(crate) struct LinkEntry {
    pub conn: ConnId,
    /// Its hello (its browser and pid, as the copy says them).
    pub hello: Hello,
    pub mirror: StateMirror,
    pub resync: Resync,
    pub assembler: ChunkAssembler,
    /// The theme package's JSON (background/theme-package.ts ThemeMessage).
    pub theme: Option<String>,
    pub theme_id: Option<String>,
    pub outbox: LayoutOutbox,
    pub drawn: DrawnOutbox,
    /// The copy's shortcuts, once it said.
    pub keys: Option<HashMap<String, Vec<String>>>,
    pub held: HeldPushes,
}

impl LinkEntry {
    pub fn epoch(&self) -> &str {
        &self.hello.epoch
    }
    pub fn data_link(&self) -> datasync::Link {
        datasync::Link::new(self.hello.browser.as_str(), self.hello.profile.as_str(), self.hello.epoch.as_str())
    }
}

/// A dropped link's theme and keys meanwhile, and which browser's, with its process: its windows are still read.
#[derive(Clone, Debug)]
pub(crate) struct Kept {
    pub theme: Option<String>,
    pub theme_id: Option<String>,
    pub keys: Option<HashMap<String, Vec<String>>>,
    pub browser: String,
    pub pid: Option<u32>,
    /// When the grace ends.
    pub until: Secs,
}

/// What a `req` the shell made waits for.
#[derive(Clone, Debug)]
pub(crate) enum Pending {
    /// Nothing: its answer is left.
    Ignore,
    /// A page's `send`: the reply goes back to it.
    Page { token: ReplyToken, overlay: WindowKey, kind: String, asked: Secs },
    /// The switch's request.
    Switch { rid: crate::switch::RequestId, kind: String, link: String, asked: Secs },
    /// ⌘N's `newWindow`.
    NewWindow { link: String, asked: Secs },
}

/// The hot keys the shortcuts hold, as the OS layer is to hold them.
#[derive(Debug, Default)]
pub(crate) struct Registrar {
    held: BTreeMap<u32, Combo>,
}

impl HotKeyRegistrar for Registrar {
    fn register(&mut self, combo: &Combo, id: u32) -> bool {
        self.held.insert(id, *combo);
        true
    }
    fn unregister(&mut self, id: u32) {
        self.held.remove(&id);
    }
}

/// Margin windows (docs/BROWSER-WINDOWS.md §2.3) as the close-based switch needs them: each line's home window per profile.
#[derive(Debug, Default)]
pub(crate) struct Lines {
    next: i64,
    homes: BTreeMap<i64, BTreeMap<String, i64>>,
}

impl Lines {
    pub fn line_of(&self, link: &str, window_id: i64) -> Option<i64> {
        self.homes.iter().find(|(_, h)| h.get(link) == Some(&window_id)).map(|(l, _)| *l)
    }
    pub fn line_for(&mut self, link: &str, window_id: i64) -> i64 {
        if let Some(l) = self.line_of(link, window_id) {
            return l;
        }
        self.next += 1;
        self.homes.entry(self.next).or_default().insert(link.into(), window_id);
        self.next
    }
    pub fn home(&self, line: i64, link: &str) -> Option<i64> {
        self.homes.get(&line)?.get(link).copied()
    }
    pub fn note_shown(&mut self, link: &str, window_id: i64, line: Option<i64>) {
        let Some(line) = line else {
            self.line_for(link, window_id);
            return;
        };
        for h in self.homes.values_mut() {
            if h.get(link) == Some(&window_id) {
                h.remove(link);
            }
        }
        self.homes.entry(line).or_default().insert(link.into(), window_id);
        self.homes.retain(|_, h| !h.is_empty());
    }
    /// Only windows still there.
    pub fn retain(&mut self, alive: impl Fn(&str, i64) -> bool) {
        for h in self.homes.values_mut() {
            h.retain(|link, w| alive(link, *w));
        }
        self.homes.retain(|_, h| !h.is_empty());
    }
}

/// The shell.
pub struct Shell {
    pub(crate) opts: Options,
    pub(crate) link: SocketLink,
    pub(crate) links: BTreeMap<String, LinkEntry>,
    pub(crate) relays: RelayHub,
    pub(crate) data: DataSync,
    pub(crate) profiles: HashMap<String, BrowserProfiles>,
    pub(crate) themes: ThemeStore,
    pub(crate) themes_sent: HashMap<WindowKey, String>,
    pub(crate) picking: bool,
    pub(crate) shortcuts: AppShortcuts,
    pub(crate) registrar: Registrar,
    pub(crate) hotkeys_sent: Vec<HotKey>,
    pub(crate) keys_front: KeysFront<WindowKey>,
    pub(crate) keys_off_why: Option<String>,
    pub(crate) across: Across,
    pub(crate) across_queued: bool,
    /// The switch's words or notice for the overlays (`across.switching`), and when it goes.
    pub(crate) switch_notice: Option<Object>,
    pub(crate) switch_notice_until: Option<Secs>,
    /// A failure's words shown: `across` pushed again then.
    pub(crate) words_until: Option<Secs>,
    pub(crate) switcher: ProfileSwitch,
    pub(crate) lines: Lines,
    pub(crate) overlays: BTreeMap<WindowKey, OverlayModel>,
    pub(crate) by_id: HashMap<OverlayId, WindowKey>,
    pub(crate) next_overlay: OverlayId,
    pub(crate) matches: BTreeMap<WindowKey, i64>,
    pub(crate) binders: HashMap<String, crate::binder::WindowBinder>,
    pub(crate) binder_log: Arc<Mutex<Vec<String>>>,
    pub(crate) started: bool,
    pub(crate) tracks: u64,
    pub(crate) poll_due: Option<Secs>,
    pub(crate) burst_until: Secs,
    pub(crate) read_soon: bool,
    pub(crate) last_read: WindowRead,
    pub(crate) last_browser_on_screen: BTreeSet<i64>,
    pub(crate) last_front_window: Option<i64>,
    pub(crate) pointer: Option<(Point, bool)>,
    pub(crate) pointer_watch: bool,
    pub(crate) last_pointer_push: HashMap<WindowKey, Secs>,
    pub(crate) last_pointer: HashMap<WindowKey, Point>,
    pub(crate) pointer_inside: HashSet<WindowKey>,
    pub(crate) pointer_wanted: HashSet<WindowKey>,
    pub(crate) trailing: HashMap<WindowKey, Secs>,
    pub(crate) reconnecting: HashMap<String, Kept>,
    pub(crate) drawn_due: HashMap<WindowKey, Secs>,
    pub(crate) held_palette: HashMap<WindowKey, (String, Secs, bool)>,
    pub(crate) palette_on_show: HashMap<WindowKey, Secs>,
    pub(crate) pending: HashMap<(ConnId, i64), Pending>,
    pub(crate) next_rid: crate::switch::RequestId,
    pub(crate) settings_sent: HashMap<String, String>,
    pub(crate) linked_at: HashMap<String, Secs>,
    pub(crate) stopped: bool,
    pub(crate) now: Secs,
    pub(crate) out: Out,
}

/// A line of a copy's (or the browser's) words for the log: at most `max` characters, nothing that looks like an
/// address (Diagnostics.scrub).
pub(crate) fn scrub(text: &str, max: usize) -> String {
    let words: Vec<String> =
        text.split(' ').map(|w| if w.contains("://") || w.contains("www.") { "…".into() } else { w.into() }).collect();
    words.join(" ").chars().take(max).collect()
}

/// JSON text of a value (never fails for values made here).
pub(crate) fn json_text(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

impl Shell {
    pub fn new(opts: Options) -> Self {
        let data = DataSync::new(DataStore::new(&opts.data_root));
        let themes = ThemeStore::new(&opts.themes_root);
        let shortcuts = AppShortcuts::new(crate::shortcuts::default_bindings(opts.os), opts.key_repeat);
        let link = SocketLink::new(opts.link.clone(), opts.app_version.clone());
        let relays = RelayHub::new(opts.app_version.clone());
        let switcher = ProfileSwitch::new(opts.switch.clone());
        Self {
            link,
            links: BTreeMap::new(),
            relays,
            data,
            profiles: HashMap::new(),
            themes,
            themes_sent: HashMap::new(),
            picking: false,
            shortcuts,
            registrar: Registrar::default(),
            hotkeys_sent: Vec::new(),
            keys_front: KeysFront::new(),
            keys_off_why: None,
            across: Across::new(),
            across_queued: false,
            switch_notice: None,
            switch_notice_until: None,
            words_until: None,
            switcher,
            lines: Lines::default(),
            overlays: BTreeMap::new(),
            by_id: HashMap::new(),
            next_overlay: 1,
            matches: BTreeMap::new(),
            binders: HashMap::new(),
            binder_log: Arc::new(Mutex::new(Vec::new())),
            started: false,
            tracks: 0,
            poll_due: None,
            burst_until: f64::NEG_INFINITY,
            read_soon: false,
            last_read: WindowRead::default(),
            last_browser_on_screen: BTreeSet::new(),
            last_front_window: None,
            pointer: None,
            pointer_watch: false,
            last_pointer_push: HashMap::new(),
            last_pointer: HashMap::new(),
            pointer_inside: HashSet::new(),
            pointer_wanted: HashSet::new(),
            trailing: HashMap::new(),
            reconnecting: HashMap::new(),
            drawn_due: HashMap::new(),
            held_palette: HashMap::new(),
            palette_on_show: HashMap::new(),
            pending: HashMap::new(),
            next_rid: 1,
            settings_sent: HashMap::new(),
            linked_at: HashMap::new(),
            stopped: false,
            now: 0.0,
            out: Out::default(),
            opts,
        }
    }

    /// The data (the tests read it; the driver can hand its clock in: `data_mut().now`).
    pub fn data_mut(&mut self) -> &mut DataSync {
        &mut self.data
    }

    /// The overlays now: each one's window key and model.
    pub fn overlays(&self) -> impl Iterator<Item = &OverlayModel> {
        self.overlays.values()
    }

    /// Each copy's window bound to the OS's window number.
    pub fn bindings(&self) -> &BTreeMap<WindowKey, i64> {
        &self.matches
    }

    /// The link keys up now.
    pub fn link_keys(&self) -> Vec<String> {
        self.links.keys().cloned().collect()
    }

    pub fn is_reconnecting(&self, key: &str) -> bool {
        self.reconnecting.contains_key(key)
    }

    pub fn holds_palette(&self, key: &WindowKey) -> bool {
        self.held_palette.contains_key(key)
    }

    pub fn hot_keys_active(&self) -> bool {
        self.shortcuts.is_active()
    }

    /// One input, at `now`: what the OS layer does, in order.
    pub fn handle(&mut self, now: Secs, input: Input) -> Vec<Command> {
        self.now = now;
        if !self.stopped {
            match input {
                Input::Listening { port } => {
                    let outs = self.link.listening(port, now);
                    self.actions(outs);
                }
                Input::SocketOpened { conn } => {
                    let outs = self.link.on_accept(conn, now);
                    self.actions(outs);
                }
                Input::SocketBytes { conn, bytes } => {
                    let outs = self.link.on_bytes(conn, &bytes, now);
                    self.actions(outs);
                }
                Input::SocketEnded { conn, error } => {
                    let outs = self.link.on_ended(conn, error.as_deref(), now);
                    self.actions(outs);
                }
                Input::RelayOpened { conn } => self.relays.on_open(conn),
                Input::RelayBytes { conn, bytes } => {
                    let outs = self.relays.on_bytes(conn, &bytes, now);
                    self.relay_outs(outs);
                }
                Input::RelayEnded { conn } => self.relays.on_ended(conn),
                Input::Windows(read) => self.track(read),
                Input::Burst(why) => self.burst(&why),
                Input::Pointer { at, buttons, pressed } => {
                    self.pointer = Some((at, buttons));
                    if pressed {
                        self.pressed(at);
                    }
                    self.pointer_moved(at, buttons, false);
                }
                Input::HotKey { id, repeat } => {
                    let run = if repeat { self.shortcuts.os_repeat(id) } else { self.shortcuts.hit(id, now) };
                    if let Some(run) = run {
                        self.run(run.command, run.is_repeat);
                    }
                }
                Input::PageOp { id, op, body, reply } => self.page_op(id, &op, body, reply),
                Input::PageLoaded { id, ok } => {
                    if !ok && let Some(key) = self.by_id.get(&id) {
                        self.out.warn(format!("{key}: its overlay's page didn't load"));
                    }
                }
                Input::PageCrashed { id } => self.page_crashed(id),
                Input::OverlayWindow { id, number } => {
                    if let Some(o) = self.by_id.get(&id).and_then(|k| self.overlays.get_mut(k)) {
                        o.number = Some(number);
                    }
                }
                Input::OverlayFocus { id, has } => self.overlay_focus(id, has),
                Input::ThemeFileRead { id, file } => self.theme_file_read(id, file),
                Input::Tick => self.tick(),
                Input::Stop { why } => self.stop(&why),
            }
        }
        self.settle();
        std::mem::take(&mut self.out.0)
    }

    /// When to call [`Shell::handle`] with [`Input::Tick`] next.
    pub fn next_wake(&self) -> Option<Secs> {
        if self.stopped {
            return None;
        }
        let mut times: Vec<Secs> = Vec::new();
        times.extend(self.link.next_deadline());
        times.extend(self.links.values().filter_map(|l| l.resync.due_at()));
        times.extend(self.reconnecting.values().map(|k| k.until));
        times.extend(self.drawn_due.values().map(|d| d + 0.01));
        times.extend(self.held_palette.values().map(|h| h.1 + 0.05));
        times.extend(self.trailing.values().copied());
        times.extend(self.switcher.next_wake());
        times.extend(self.data.next_hold_deadline().map(|ms| ms / 1000.0));
        times.extend(self.switch_notice_until);
        times.extend(self.words_until);
        times.extend(self.poll_due);
        times.into_iter().reduce(f64::min)
    }

    // ---- what's done after every input ----

    fn settle(&mut self) {
        for _ in 0..4 {
            if !self.across_queued {
                break;
            }
            self.across_queued = false;
            self.push_across();
        }
        let lines: Vec<String> = self.binder_log.lock().map(|mut l| std::mem::take(&mut *l)).unwrap_or_default();
        for line in lines {
            self.out.note(line);
        }
        for line in self.switcher.take_notes() {
            self.out.note(format!("profile switch: {}", scrub(&line, 300)));
        }
        let notes = self.data.store_mut().take_log();
        self.data_notes(notes);
        let browsers: Vec<String> = self.profiles.keys().cloned().collect();
        for b in browsers {
            let notes = self.profiles.get_mut(&b).map(BrowserProfiles::take_log).unwrap_or_default();
            self.data_notes(notes);
        }
        if self.read_soon && !self.stopped {
            self.read_soon = false;
            self.poll_due = None;
            self.out.push(Command::ReadWindows);
        }
    }

    fn data_notes(&mut self, notes: Vec<crate::data::Note>) {
        for n in notes {
            if n.warn { self.out.warn(n.text) } else { self.out.note(n.text) }
        }
    }

    fn tick(&mut self) {
        let now = self.now;
        let actions = self.link.tick(now);
        self.actions(actions);
        // Resyncs due again.
        let keys: Vec<String> = self.links.keys().cloned().collect();
        for key in &keys {
            let Some(entry) = self.links.get_mut(key) else { continue };
            if entry.resync.tick(now, &entry.mirror) {
                let (conn, epoch) = (entry.conn, entry.epoch().to_owned());
                self.send(conn, &AppMessage::Resync { epoch });
            }
        }
        // Dropped links that didn't come back.
        let gone: Vec<String> =
            self.reconnecting.iter().filter(|(_, k)| now >= k.until).map(|(k, _)| k.clone()).collect();
        for key in gone {
            self.reconnect_gave_up(&key);
        }
        // A `drawn` off pending: looked at again.
        let due = self.drawn_due.values().any(|&d| now >= d);
        if due {
            self.drawn_due.retain(|_, d| now < *d);
            self.soon();
        }
        // Palettes held too long.
        let dropped: Vec<(WindowKey, bool)> =
            self.held_palette.iter().filter(|(_, h)| now >= h.1 + 0.05).map(|(k, h)| (k.clone(), h.2)).collect();
        for (key, new_tab) in dropped {
            self.held_palette.remove(&key);
            self.palette_dropped(&key, new_tab);
        }
        // Pointers resting after a run of moves.
        let trail: Vec<WindowKey> = self.trailing.iter().filter(|(_, t)| now >= **t).map(|(k, _)| k.clone()).collect();
        for key in trail {
            self.trailing.remove(&key);
            self.trail_pointer(&key);
        }
        if self.switcher.next_wake().is_some_and(|t| now >= t) {
            self.switch_tick();
        }
        if self.data.next_hold_deadline().is_some_and(|ms| now * 1000.0 >= ms) {
            let fx = self.data.tick();
            self.effects(fx);
        }
        if self.switch_notice_until.is_some_and(|t| now >= t) {
            self.switch_notice_until = None;
            self.switch_notice = None;
            self.across_soon();
        }
        if self.words_until.is_some_and(|t| now >= t) {
            self.words_until = None;
            if !self.switcher.busy() {
                self.across_soon();
            }
        }
        if self.poll_due.is_some_and(|t| now >= t) {
            self.poll_due = None;
            self.read_soon = true;
        }
    }

    fn stop(&mut self, why: &str) {
        let outs = self.relays.stop();
        self.relay_outs(outs);
        let actions = self.link.stop(why, self.now);
        self.actions(actions);
        let ids: Vec<OverlayId> = self.overlays.values().map(|o| o.id).collect();
        for key in self.overlays.keys().cloned().collect::<Vec<_>>() {
            if let Some(mut o) = self.overlays.remove(&key) {
                o.hide(&mut self.out, "closed");
            }
        }
        for id in ids {
            self.out.push(Command::DestroyOverlay { id });
        }
        self.by_id.clear();
        self.shortcuts.set_active(&mut self.registrar, false);
        self.sync_hot_keys();
        if self.pointer_watch {
            self.pointer_watch = false;
            self.out.push(Command::PointerWatch { on: false });
        }
        self.stopped = true;
        self.poll_due = None;
        self.read_soon = false;
    }

    // ---- reading the windows ----

    /// Read the windows often for a while (something is moving).
    pub(crate) fn burst(&mut self, _why: &str) {
        self.burst_until = self.now + self.opts.burst_for;
        self.soon();
    }

    /// A read now (several reasons at once: one read).
    pub(crate) fn soon(&mut self) {
        if !self.stopped {
            self.read_soon = true;
        }
    }

    // ---- the link ----

    /// The link's news, carried out: its writes and ends, its `link` dispatched into the relays, what its session
    /// heard.
    pub(crate) fn actions(&mut self, outs: Vec<socket::Out>) {
        for o in outs {
            match o {
                socket::Out::Write { conn, bytes } => self.out.push(Command::Write { conn, bytes }),
                socket::Out::End { conn } => self.out.push(Command::End { conn }),
                socket::Out::Dispatch { to, name, info, n } => {
                    let (outs, sent) = self.relays.dispatch(&name, &info, to.pid);
                    self.relay_outs(outs);
                    let why = (!sent).then(|| format!("no relay of {} (pid {})", to.browser, to.pid));
                    let outs = self.link.dispatched(&name, n, why.as_deref());
                    self.actions(outs);
                }
                socket::Out::Link(a) => self.session(a),
                socket::Out::Log { level, text } => match level {
                    link::Level::Note => self.out.note(text),
                    link::Level::Warn => self.out.warn(text),
                },
            }
        }
    }

    /// The relays' news: their lines and closes, a copy's `wantLink` to the link.
    pub(crate) fn relay_outs(&mut self, outs: Vec<RelayOut>) {
        for o in outs {
            match o {
                RelayOut::Write { conn, bytes } => self.out.push(Command::RelayWrite { conn, bytes }),
                RelayOut::End { conn } => self.out.push(Command::RelayEnd { conn }),
                RelayOut::WantLink { nonce, via } => {
                    let outs = self.link.want_link(&nonce, via, self.now);
                    self.actions(outs);
                }
                RelayOut::Log { level, text } => match level {
                    link::Level::Note => self.out.note(text),
                    link::Level::Warn => self.out.warn(text),
                },
            }
        }
    }

    /// What the link session heard.
    fn session(&mut self, a: Action) {
        match a {
            Action::Up { conn, hello } => self.link_up(conn, hello),
            Action::Received { conn, key, message } => self.link_received(conn, &key, message),
            Action::Down { conn, key, why } => self.link_down(conn, &key, &why),
            Action::Answer { conn, id, answer, .. } => self.answered(conn, id, answer),
            Action::Log { level, text } => match level {
                link::Level::Note => self.out.note(text),
                link::Level::Warn => self.out.warn(text),
            },
            // (The socket link writes these itself.)
            Action::Send { .. } | Action::Close { .. } => {}
        }
    }

    /// A message to a link (logged if refused for its size).
    pub(crate) fn send(&mut self, conn: ConnId, message: &AppMessage) {
        match self.link.send(conn, message, self.now) {
            Ok(bytes) => self.out.push(Command::Write { conn, bytes }),
            Err(LinkError::NotJson) => {
                let key = self.link.link().connection_on(conn).map(|c| c.key()).unwrap_or_default();
                self.out.warn(format!("not sent to {key}: not JSON, or over 1000000 bytes"));
            }
            Err(_) => {}
        }
    }

    /// A `req` to a link's copy; its answer goes to `then`. False if it couldn't be sent.
    pub(crate) fn request(
        &mut self,
        link_key: &str,
        kind: &str,
        payload: Value,
        window_id: Option<i64>,
        then: Pending,
    ) -> bool {
        let Some(conn) = self.links.get(link_key).map(|l| l.conn) else { return false };
        let payload = match payload {
            Value::Object(o) => o,
            _ => Object::new(),
        };
        match self.link.request(conn, kind, payload, window_id, self.now) {
            Ok((id, bytes)) => {
                self.out.push(Command::Write { conn, bytes });
                self.pending.insert((conn, id), then);
                true
            }
            Err(e) => {
                if e == LinkError::NotJson {
                    self.out.warn(format!("not sent to {link_key}: not JSON, or over 1000000 bytes"));
                }
                false
            }
        }
    }

    /// A `req` whose answer is left.
    pub(crate) fn ask(&mut self, link_key: &str, kind: &str, payload: Value, window_id: Option<i64>) {
        self.request(link_key, kind, payload, window_id, Pending::Ignore);
    }

    fn answered(&mut self, conn: ConnId, id: i64, answer: Result<Object, LinkError>) {
        let Some(pending) = self.pending.remove(&(conn, id)) else { return };
        match pending {
            Pending::Ignore => {}
            Pending::Page { token, overlay, kind, asked } => match answer {
                Ok(body) => {
                    if kind == "newWindow"
                        && json::boolean(body.get("ok")) == Some(true)
                        && let Some(made) =
                            json::object(body.get("result")).and_then(crate::protocol::SpaceWindowAnswer::from_result)
                    {
                        self.made_from_window(&overlay.link, &made, asked);
                    }
                    let text = json_text(&Value::Object(body));
                    self.out.push(Command::Reply { token, result: Ok(Value::String(text)) });
                }
                Err(e) => self
                    .out
                    .push(Command::Reply { token, result: Err(format!("no answer from Margin: {}", error_words(e))) }),
            },
            Pending::Switch { rid, kind, link, asked } => {
                let result = match answer {
                    Ok(body) if json::boolean(body.get("ok")) == Some(true) => {
                        let result = json::object(body.get("result")).cloned().unwrap_or_default();
                        if let Some(made) = crate::protocol::SpaceWindowAnswer::from_result(&result) {
                            if kind == "newWindow" {
                                self.made_from_window(&link, &made, asked);
                            } else if kind == "openSpaceWindow" {
                                self.window_made(&link, made.window_id, asked, made.bounds);
                            }
                        }
                        Ok(Value::Object(result))
                    }
                    Ok(body) => Err(scrub(json::string(body.get("error")).unwrap_or("refused"), 160)),
                    Err(e) => Err(error_words(e).into()),
                };
                self.switch_answered(rid, result);
                self.burst("switch request");
            }
            Pending::NewWindow { link, asked } => match answer {
                Ok(body) if json::boolean(body.get("ok")) == Some(true) => {
                    let result = json::object(body.get("result")).cloned().unwrap_or_default();
                    if let Some(made) = crate::protocol::SpaceWindowAnswer::from_result(&result) {
                        self.made_from_window(&link, &made, asked);
                        self.out.note(format!("⌘N: window {} ({})", made.window_id, made.state));
                    }
                    self.burst("switch request");
                }
                Ok(body) => {
                    let why = scrub(json::string(body.get("error")).unwrap_or("refused"), 160);
                    self.out.warn(format!("⌘N: no window: {why}"));
                }
                Err(e) => self.out.warn(format!("⌘N: no window: {}", error_words(e))),
            },
        }
    }

    /// A Chrome or Edge copy's hello names its browser process as its connector told it. Trusted as on the Mac
    /// (decided 2026-11-09: never refused), but one that no connector has named since the app started is logged:
    /// a copy linking with a link kept from before, a connector that knew no process, or a hello not as its relay said.
    fn warn_unheard_pid(&mut self, key: &str, hello: &Hello) {
        if hello.browser == "safari" {
            return; // Safari's copies find the app through its extension handler, not a connector
        }
        let Some(pid) = hello.pid.and_then(|p| u32::try_from(p).ok()).filter(|p| *p > 0) else { return };
        if !self.relays.heard_pid(pid) {
            self.out.warn(format!(
                "{key}: its hello says browser process {pid}, which no connector has named: trusted, as on the Mac"
            ));
        }
    }

    fn link_up(&mut self, conn: ConnId, hello: Hello) {
        let key = hello.key();
        let mut entry = LinkEntry {
            conn,
            hello: hello.clone(),
            mirror: StateMirror::new(),
            resync: Resync::new(self.opts.resync_retry),
            assembler: ChunkAssembler::default(),
            theme: None,
            theme_id: None,
            outbox: LayoutOutbox::default(),
            drawn: DrawnOutbox::new(self.opts.drawn_grace),
            keys: None,
            held: HeldPushes::default(),
        };
        entry.mirror.begin(&hello);
        self.warn_unheard_pid(&key, &hello);
        self.data.link_up(&entry.data_link());
        self.links.insert(key.clone(), entry);
        self.linked_at.insert(key.clone(), self.now);
        // A switch on its way to this profile: given the leaving window's settings as soon as its copy is here.
        if self.switcher.busy() && self.switcher.target().is_some_and(|t| t.profile == key) {
            self.carry_settings(&key);
        }
        if let Some(kept) = self.reconnecting.remove(&key) {
            if let Some(e) = self.links.get_mut(&key) {
                (e.theme, e.theme_id, e.keys) = (kept.theme, kept.theme_id, kept.keys);
            }
            self.out.note(format!("{key} is back: its overlays kept"));
            for o in self.overlays.values().filter(|o| o.key.link == key) {
                o.push(&mut self.out, r#"{"type":"link","state":"linked"}"#);
            }
        }
        self.burst(&format!("linked: {key}"));
        self.across_soon();
        self.switch_tick();
    }

    fn link_received(&mut self, conn: ConnId, key: &str, message: LinkMessage) {
        if self.links.get(key).is_none_or(|e| e.conn != conn) {
            return;
        }
        match message {
            LinkMessage::Snapshot { .. } | LinkMessage::Delta { .. } | LinkMessage::Windows { .. } => {
                let Some(entry) = self.links.get_mut(key) else { return };
                let windows_before = entry.mirror.windows().to_vec();
                let outcome = entry.mirror.apply(&message);
                let resync_now = entry.resync.after(outcome, self.now);
                match outcome {
                    Outcome::Applied => {
                        self.forward(key, &message, &windows_before);
                        match &message {
                            LinkMessage::Windows { .. } => self.switch_tick(),
                            LinkMessage::Snapshot { .. } => {
                                self.across_soon();
                                self.themes_tell_copy(key);
                                self.themes_check(key);
                            }
                            LinkMessage::Delta { changes, .. } => {
                                if changes.contains_key("spaces") {
                                    self.across_soon();
                                }
                                if changes.contains_key("settings") {
                                    self.themes_check(key);
                                    self.share_settings(key);
                                }
                            }
                            _ => {}
                        }
                    }
                    Outcome::Gap { expected, got } => {
                        self.out
                            .warn(format!("{key}: number {got} came, {expected} was next: the state asked for again"));
                        if resync_now && let Some(e) = self.links.get(key) {
                            let (conn, epoch) = (e.conn, e.epoch().to_owned());
                            self.send(conn, &AppMessage::Resync { epoch });
                        }
                    }
                    Outcome::Ignored => {}
                }
            }
            LinkMessage::Theme { epoch, chunk } => {
                let Some(entry) = self.links.get_mut(key) else { return };
                if epoch != entry.hello.epoch {
                    return;
                }
                match entry.assembler.add(&chunk) {
                    chunks::Outcome::Complete { id, data } => {
                        let parsed: Option<Value> = serde_json::from_slice(&data).ok();
                        let ok = parsed.as_ref().and_then(Value::as_object).is_some_and(|o| {
                            json::string(o.get("id")) == Some(id.as_str())
                                && o.get("manifest").is_some_and(Value::is_string)
                                && o.get("html").is_some_and(Value::is_string)
                                && o.get("css").is_some_and(Value::is_string)
                        });
                        let text = String::from_utf8(data).ok().filter(|_| ok);
                        let Some(text) = text else {
                            self.out.warn(format!("{key}: the theme {id} isn't a theme package: left"));
                            return;
                        };
                        let bytes = text.len();
                        entry.theme = Some(text);
                        entry.theme_id = Some(id.clone());
                        self.out.note(format!("{key}: theme {id} here ({bytes} bytes)"));
                        self.themes_check(key);
                        self.burst("theme");
                    }
                    chunks::Outcome::Refused(why) => self.out.warn(format!("{key}: a theme refused: {why}")),
                    chunks::Outcome::Waiting { .. } => {}
                }
            }
            LinkMessage::Data { kind, body } => {
                let Some(link) = self.links.get(key).map(LinkEntry::data_link) else { return };
                let mut message = body;
                message.insert("k".into(), kind.into());
                let fx = self.data.received(&link, &Value::Object(message));
                self.effects(fx);
            }
            LinkMessage::Push { window_id, msg, .. } => self.pushed(key, window_id, msg),
            LinkMessage::Keys { epoch, bindings } => {
                let Some(entry) = self.links.get_mut(key) else { return };
                if epoch != entry.hello.epoch {
                    return;
                }
                entry.keys = Some(bindings.into_iter().collect());
                self.burst("keys");
            }
            // The Mac's handoff: never passed to an overlay, nothing to do on Windows.
            LinkMessage::ParkedActivity { .. } => {}
            _ => {}
        }
    }

    fn link_down(&mut self, conn: ConnId, key: &str, why: &str) {
        if self.links.get(key).is_none_or(|e| e.conn != conn) {
            return;
        }
        let Some(entry) = self.links.remove(key) else { return };
        self.data.link_down(&entry.data_link());
        self.pending.retain(|(c, _), _| *c != conn);
        let shown: Vec<WindowKey> = self.overlays.keys().filter(|k| k.link == key).cloned().collect();
        let grace = self.opts.reconnect_grace;
        if why != "replaced"
            && !why.starts_with("stopped")
            && !why.starts_with("bye")
            && grace > 0.0
            && !shown.is_empty()
        {
            for k in &shown {
                if let Some(o) = self.overlays.get(k) {
                    o.push(&mut self.out, r#"{"type":"link","state":"reconnecting"}"#);
                }
            }
            let pid = entry.hello.pid.and_then(|p| u32::try_from(p).ok());
            self.reconnecting.insert(
                key.to_owned(),
                Kept {
                    theme: entry.theme,
                    theme_id: entry.theme_id,
                    keys: entry.keys,
                    browser: entry.hello.browser.clone(),
                    pid,
                    until: self.now + grace,
                },
            );
            // The browser not in front: nothing of it on screen is worth keeping (the relink shows them again).
            let pids = self.pids_of(&entry.hello.browser, pid, &self.last_read.browsers);
            let in_front = self.effective_front_pid().is_some_and(|p| pids.contains(&p));
            if !in_front {
                for k in &shown {
                    if let Some(o) = self.overlays.get_mut(k) {
                        o.hide(&mut self.out, "its link dropped while the browser isn't in front");
                    }
                }
            }
            self.out.note(format!(
                "{key} dropped ({why}): its overlays kept, dimmed, for {} s{}",
                grace as i64,
                if in_front {
                    " while their windows stay as they are"
                } else {
                    ", put away (the browser isn't in front)"
                }
            ));
        } else {
            for k in shown {
                self.close_overlay(&k);
            }
        }
        if self.links.is_empty() && self.reconnecting.is_empty() {
            self.started = false;
        }
        self.burst(&format!("link down: {key}"));
        self.across_soon();
        self.switch_tick();
    }

    /// The copy didn't come back in time: its overlays go.
    fn reconnect_gave_up(&mut self, key: &str) {
        self.reconnecting.remove(key);
        if self.links.contains_key(key) {
            return;
        }
        let gone: Vec<WindowKey> = self.overlays.keys().filter(|k| k.link == key).cloned().collect();
        for k in gone {
            self.close_overlay(&k);
        }
        self.out.note(format!("{key} didn't come back: its overlays closed"));
        if self.links.is_empty() && self.reconnecting.is_empty() {
            self.started = false;
        }
        self.burst(&format!("gave up on {key}"));
    }

    /// An overlay put away and destroyed.
    pub(crate) fn close_overlay(&mut self, key: &WindowKey) {
        let Some(mut o) = self.overlays.remove(key) else { return };
        o.hide(&mut self.out, "closed");
        self.by_id.remove(&o.id);
        self.out.push(Command::DestroyOverlay { id: o.id });
        self.themes_sent.remove(key);
        self.pointer_inside.remove(key);
        self.pointer_wanted.remove(key);
        self.trailing.remove(key);
        self.last_pointer.remove(key);
        self.last_pointer_push.remove(key);
    }

    /// The data's effects: its messages sent on their links, its log, the overlays told of spaces and tabs.
    pub(crate) fn effects(&mut self, fx: Effects) {
        for o in fx.send {
            let key = o.to.key();
            let Some(conn) = self.links.get(&key).filter(|l| l.hello.epoch == o.epoch).map(|l| l.conn) else {
                continue;
            };
            let Value::Object(body) = o.message else { continue };
            let kind = json::string(body.get("k")).unwrap_or("").to_owned();
            self.send(conn, &AppMessage::Data { kind, body });
        }
        if fx.changed.iter().any(|(_, c)| c.contains("spaces") || c.contains("tabs")) {
            self.across_soon();
        }
        self.data_notes(fx.log);
    }

    /// What came, to each of the copy's overlays (each page keeps its own copy of the state).
    fn forward(&mut self, key: &str, message: &LinkMessage, windows_before: &[Object]) {
        let Some(entry) = self.links.get(key) else { return };
        let shown: Vec<WindowKey> = self.overlays.keys().filter(|k| k.link == key).cloned().collect();
        match message {
            LinkMessage::Snapshot { .. } => {
                let Some(state) = entry.mirror.state_json() else { return };
                let windows =
                    json_text(&Value::Array(entry.mirror.windows().iter().cloned().map(Value::Object).collect()));
                let json = format!(r#"{{"type":"state","state":{state},"windows":{windows}}}"#);
                for k in &shown {
                    if let Some(o) = self.overlays.get(k) {
                        o.push(&mut self.out, json.clone());
                    }
                }
                self.burst("snapshot");
            }
            LinkMessage::Delta { changes, favicons, .. } => {
                let mut out = Object::new();
                for (k, change) in changes {
                    let v = match change {
                        crate::protocol::Change::Set(v) => serde_json::json!({ "newValue": v }),
                        crate::protocol::Change::Removed => Value::Object(Object::new()),
                    };
                    out.insert(k.clone(), v);
                }
                let mut m = Object::new();
                m.insert("type".into(), "changes".into());
                m.insert("changes".into(), Value::Object(out));
                if let Some(f) = favicons {
                    m.insert("favicons".into(), serde_json::json!({ "set": f.set, "del": f.del }));
                }
                let json = json_text(&Value::Object(m));
                for k in &shown {
                    if let Some(o) = self.overlays.get(k) {
                        o.push(&mut self.out, json.clone());
                    }
                }
            }
            LinkMessage::Windows { list, .. } => {
                // Only the pages' words of being shown changed: nothing an overlay draws from, and nothing to follow
                // at once unless one of the copy's windows isn't bound yet.
                if only_visibility_changed(windows_before, list) {
                    let unbound = list.iter().any(|w| {
                        json::int(w.get("windowId").or_else(|| w.get("id")))
                            .is_some_and(|id| !self.matches.contains_key(&WindowKey::new(key, id)))
                    });
                    if unbound {
                        self.soon();
                    }
                    return;
                }
                let json = json_text(&serde_json::json!({ "type": "windows", "list": list }));
                for k in &shown {
                    if let Some(o) = self.overlays.get(k) {
                        o.push(&mut self.out, json.clone());
                    }
                }
                self.burst("windows");
            }
            _ => {}
        }
    }
}

fn error_words(e: LinkError) -> &'static str {
    match e {
        LinkError::Down => "down",
        LinkError::TimedOut => "timedOut",
        LinkError::NotJson => "notJSON",
    }
}

/// Whether two window lists of a copy differ only in their pages' words of being shown (`visible`, `visibleAt`).
pub fn only_visibility_changed(before: &[Object], after: &[Object]) -> bool {
    if before.len() != after.len() || after.is_empty() {
        return false;
    }
    let strip = |w: &Object| -> Object {
        w.iter()
            .filter(|(k, _)| k.as_str() != "visible" && k.as_str() != "visibleAt")
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    };
    before.iter().zip(after).all(|(a, b)| strip(a) == strip(b))
}

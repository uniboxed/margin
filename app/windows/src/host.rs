//! The Windows driver of margin-core's shell (`margin_core::shell::Shell`): every event of the Windows layer becomes
//! one of the shell's `Input`s, and every `Command` it gives back is carried out here. The counterpart of the Mac's
//! glue in app/macos/shell/Shell.swift that touches the OS (its timers, the window server, the overlays' panels and web
//! views, NSOpenPanel, the pasteboard).
//!
//! - The link's listener (tcp.rs): the copies' WebSockets on 127.0.0.1, each connection's bytes and end, the
//!   shell's writes and ends; the listener's port as it changes.
//! - The pipe (pipe.rs): Margin's connectors (`margin-connector.exe`, started by Chrome and Edge), their bytes and
//!   end: how a copy finds the app and gets its link (margin-core `relay`), never the link itself.
//! - The windows (browsers.rs): read on the shell's `ReadWindows`, at most once per 1/60 s (a burst of window events
//!   is one read), with each browser process's main process (its root: a hello's pid is the main process), the
//!   foreground window and the monitors in DIPs (screens.rs); every window event is a `Burst`.
//! - The overlays (overlay.rs) and their web views (webview.rs), by the shell's `OverlayId`: each overlay's window is
//!   made at once, its web view once the one WebView2 environment is there; DIPs to pixels with screens.rs.
//! - The pointer (pointer.rs), only while the shell wants it; the hot keys (hotkeys.rs, with keys.rs's combinations).
//! - The theme picker: the common item dialog (`IFileOpenDialog`) on a thread of its own, so the UI thread never
//!   waits on it; what's chosen is read there too (margin-core `read_chosen`). Windows' dialog picks files or folders,
//!   not both: a `.margintheme` file, or a theme folder's `theme.json` (its folder is imported).
//! - `copyText`: the clipboard (`CF_UNICODETEXT`).
//!
//! Everything runs on the UI thread. An input that comes while the shell is handling another (a window message sent
//! back synchronously by a command, such as WM_ACTIVATE from `SetForegroundWindow`) waits in a queue and is handled
//! right after: the shell is never entered twice.
//!
//! The OS-neutral helpers are here too, tested on the Mac; the rest is Windows'.

use std::path::{Path, PathBuf};

use margin_core::geometry::Rect;
use margin_core::planner::Display;
use margin_core::shell::HotKey;
use margin_core::time::Secs;

use crate::screens::ScreenMap;

/// The most often the windows are read (a burst of window events is one read).
pub const READ_GAP: Secs = 1.0 / 60.0;

/// What the person chose in the picker, as the theme reader takes it: a theme folder's `theme.json` stands for its
/// folder (Windows' dialog picks files or folders, not both).
pub fn chosen_theme_path(path: &Path) -> PathBuf {
    let is_manifest = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case("theme.json"));
    match path.parent() {
        Some(parent) if is_manifest => parent.to_path_buf(),
        _ => path.to_path_buf(),
    }
}

/// The shell's hot keys as RegisterHotKey's combinations (keys.rs); one that can't be held there is named.
pub fn hot_key_combos(keys: &[HotKey]) -> (Vec<(HotKey, crate::keys::Combo)>, Vec<String>) {
    let mut ok = Vec::new();
    let mut not = Vec::new();
    for k in keys {
        match crate::keys::parse(&k.combo.text()) {
            Some(c) => ok.push((*k, c)),
            None => not.push(format!("{} ({})", k.combo, k.command.name())),
        }
    }
    (ok, not)
}

/// The monitors as the planner's displays (a full-screen window covers its whole monitor: no top inset).
pub fn displays(map: &ScreenMap) -> Vec<Display> {
    map.screens.iter().map(|s| Display { frame: s.dip, top_inset: 0.0 }).collect()
}

/// The timer's wait for a wake `at` from `now`: whole milliseconds, at least 1, at most 10 minutes.
pub fn wait_ms(at: Secs, now: Secs) -> u32 {
    let ms = ((at - now) * 1000.0).ceil();
    if !ms.is_finite() { 1 } else { ms.clamp(1.0, 600_000.0) as u32 }
}

/// Whether a DIP rectangle is worth placing an overlay at (a size of at least a pixel each way).
pub fn placeable(r: &Rect) -> bool {
    r.width >= 1.0 && r.height >= 1.0 && r.x.is_finite() && r.y.is_finite()
}

#[cfg(windows)]
pub use win::run;

#[cfg(windows)]
mod win {
    use std::cell::{Cell, RefCell};
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::rc::{Rc, Weak};

    use margin_core::data::themes::{ThemeFile, read_chosen};
    use margin_core::shell::{Command, Input, Options, OverlayId, ReplyToken, Shell, WindowRead};
    use margin_core::time::{self, Secs};
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HWND};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance, CoInitializeEx,
        CoTaskMemFree, CoUninitialize,
    };
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{
        FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FileOpenDialog, IFileOpenDialog, SIGDN_FILESYSPATH,
    };
    use windows::core::{HSTRING, w};

    use super::{READ_GAP, chosen_theme_path, displays, hot_key_combos, placeable, wait_ms};
    use crate::app::App;
    use crate::browsers::{WinWindowSource, WindowEvents};
    use crate::hotkeys::{HotKeySpec, HotKeys};
    use crate::log;
    use crate::msgwin::message_id;
    use crate::overlay::{Overlay, OverlayEvent};
    use crate::pipe::{PipeEvent, PipeServer};
    use crate::pointer::PointerWatch;
    use crate::queue::{UiSender, ui_channel};
    use crate::screens::ScreenMap;
    use crate::serve::OverlayFiles;
    use crate::tcp::{TcpEvent, TcpServer};
    use crate::webview::{Reply, WebView, WebViewEnv, WebViewEvent, connect};
    use margin_core::system::WindowSource;

    const PIPE_WAKE: u32 = message_id(0);
    const PICKED_WAKE: u32 = message_id(1);
    const TCP_WAKE: u32 = message_id(2);
    const SHELL_TIMER: usize = 0x5348; // "SH"
    const READ_TIMER: usize = 0x5244; // "RD"
    /// CF_UNICODETEXT (winuser.h).
    const CF_UNICODETEXT: u32 = 13;

    /// One overlay's window and, once made, its web view.
    struct Slot {
        overlay: Rc<Overlay>,
        webview: Option<WebView>,
        /// Being made (the environment, or the web view's controller, not there yet).
        making: bool,
    }

    struct Host {
        app: App,
        shell: RefCell<Shell>,
        pipe: RefCell<Option<PipeServer>>,
        tcp: RefCell<Option<TcpServer>>,
        source: WinWindowSource,
        events: RefCell<Option<WindowEvents>>,
        pointer: RefCell<Option<PointerWatch>>,
        hotkeys: RefCell<Option<HotKeys>>,
        env: RefCell<Option<Rc<WebViewEnv>>>,
        slots: RefCell<HashMap<OverlayId, Slot>>,
        replies: RefCell<HashMap<ReplyToken, Reply>>,
        next_token: Cell<ReplyToken>,
        screens: RefCell<ScreenMap>,
        /// Each browser process's main process, as found (a pid's root never changes while it lives).
        roots: RefCell<HashMap<u32, u32>>,
        last_read: Cell<Secs>,
        read_pending: Cell<bool>,
        queue: RefCell<VecDeque<Input>>,
        busy: Cell<bool>,
        picked: UiSender<(OverlayId, Option<ThemeFile>)>,
        stopped: Cell<bool>,
    }

    /// The app mode after its boot: the shell, the pipe, the window events, the loop.
    pub fn run(app: App) -> i32 {
        let mut opts = Options::new(&app.paths.data, &app.paths.themes);
        opts.own_pid = std::process::id();
        // Margin over windows that aren't in full screen too, over their page area (Tirth, 2026-11-09: most people
        // on Windows never use F11).
        opts.windowed_too = true;
        opts.app_version = crate::VERSION.into();
        let shell = Shell::new(opts);
        let (pipe_tx, pipe_rx) = ui_channel::<PipeEvent>(app.window.waker(PIPE_WAKE));
        let (tcp_tx, tcp_rx) = ui_channel::<TcpEvent>(app.window.waker(TCP_WAKE));
        let (picked_tx, picked_rx) = ui_channel::<(OverlayId, Option<ThemeFile>)>(app.window.waker(PICKED_WAKE));
        let host = Rc::new(Host {
            shell: RefCell::new(shell),
            pipe: RefCell::new(None),
            tcp: RefCell::new(None),
            source: WinWindowSource::new(),
            events: RefCell::new(None),
            pointer: RefCell::new(None),
            hotkeys: RefCell::new(None),
            env: RefCell::new(None),
            slots: RefCell::new(HashMap::new()),
            replies: RefCell::new(HashMap::new()),
            next_token: Cell::new(1),
            screens: RefCell::new(ScreenMap::read()),
            roots: RefCell::new(HashMap::new()),
            last_read: Cell::new(f64::NEG_INFINITY),
            read_pending: Cell::new(false),
            queue: RefCell::new(VecDeque::new()),
            busy: Cell::new(false),
            picked: picked_tx,
            stopped: Cell::new(false),
            app,
        });

        // The pipe's events.
        let weak = Rc::downgrade(&host);
        host.app.window.on(PIPE_WAKE, move |_, _| {
            let Some(h) = weak.upgrade() else { return };
            for event in pipe_rx.drain() {
                h.pipe_event(event);
            }
        });
        match PipeServer::start(&host.app.sid, pipe_tx) {
            Ok(s) => {
                *host.pipe.borrow_mut() = Some(s);
                log::note("relay: listening for Chrome's and Edge's relays");
            }
            Err(e) => log::warn(format!("relay: Chrome and Edge can't find the app: {e}")),
        }

        // The link's listener: the copies' WebSockets.
        let weak = Rc::downgrade(&host);
        host.app.window.on(TCP_WAKE, move |_, _| {
            let Some(h) = weak.upgrade() else { return };
            for event in tcp_rx.drain() {
                h.tcp_event(event);
            }
        });
        match TcpServer::start(tcp_tx) {
            Ok(s) => *host.tcp.borrow_mut() = Some(s),
            Err(e) => log::warn(format!("no listener: {e}")),
        }

        // The theme picker's answers.
        let weak = Rc::downgrade(&host);
        host.app.window.on(PICKED_WAKE, move |_, _| {
            let Some(h) = weak.upgrade() else { return };
            for (id, file) in picked_rx.drain() {
                h.feed(Input::ThemeFileRead { id, file });
            }
        });

        // The window events: each makes the shell read again soon.
        let weak = Rc::downgrade(&host);
        match WindowEvents::start(move |e| {
            if let Some(h) = weak.upgrade() {
                h.feed(Input::Burst(format!("{:?}", e.kind)));
            }
        }) {
            Ok(events) => *host.events.borrow_mut() = Some(events),
            Err(e) => log::warn(format!("window events: {e} (the windows are still read on the shell's clock)")),
        }

        // The pointer, polled while the shell wants it.
        let weak = Rc::downgrade(&host);
        *host.pointer.borrow_mut() = Some(PointerWatch::new(&host.app.window, move |sample| {
            let Some(h) = weak.upgrade() else { return };
            let at = h.screens.borrow().point_to_dip(sample.x, sample.y);
            h.feed(Input::Pointer { at, buttons: sample.buttons, pressed: sample.pressed });
        }));

        // The hot keys.
        let weak = Rc::downgrade(&host);
        *host.hotkeys.borrow_mut() = Some(HotKeys::new(&host.app.window, move |hit| {
            if let Some(h) = weak.upgrade() {
                h.feed(Input::HotKey { id: hit.id, repeat: hit.repeat });
            }
        }));

        // The overlay page's files, and the one web view environment.
        let dir = crate::paths::overlay_dir(&host.app.exe);
        let files = OverlayFiles::load(&dir).unwrap_or_else(|e| {
            log::warn(format!("the overlay's files couldn't be read ({e}): overlays will be empty"));
            OverlayFiles::default()
        });
        let weak = Rc::downgrade(&host);
        WebViewEnv::create(&host.app.paths.webview2, files, move |made| {
            let Some(h) = weak.upgrade() else { return };
            match made {
                Ok(env) => {
                    *h.env.borrow_mut() = Some(env);
                    h.make_web_views();
                }
                Err(e) => log::warn(format!("no overlays: {e}")),
            }
        });

        log::note("the shell is running");
        host.feed(Input::Tick);
        let code = crate::app::message_loop();
        host.feed(Input::Stop { why: "Margin quit".into() });
        host.stopped.set(true);
        host.slots.borrow_mut().clear();
        // (Dropping the listener gives the `bye`s written above their 0.3 s.)
        host.tcp.borrow_mut().take();
        host.pipe.borrow_mut().take();
        log::note("Margin quits");
        code
    }

    impl Host {
        /// One input for the shell, now or (while it's handling one) right after.
        fn feed(self: &Rc<Self>, input: Input) {
            self.queue.borrow_mut().push_back(input);
            if self.busy.replace(true) {
                return;
            }
            loop {
                let Some(input) = self.queue.borrow_mut().pop_front() else { break };
                let commands = match self.shell.try_borrow_mut() {
                    Ok(mut shell) => shell.handle(time::now(), input),
                    Err(_) => break,
                };
                for c in commands {
                    self.carry_out(c);
                }
            }
            self.busy.set(false);
            self.schedule();
        }

        /// The shell's next wake, as the message window's timer.
        fn schedule(self: &Rc<Self>) {
            if self.stopped.get() {
                return;
            }
            let Some(at) = self.shell.try_borrow().ok().and_then(|s| s.next_wake()) else {
                self.app.window.kill_timer(SHELL_TIMER);
                return;
            };
            let weak = Rc::downgrade(self);
            self.app.window.set_timer(SHELL_TIMER, wait_ms(at, time::now()), move || {
                let Some(h) = weak.upgrade() else { return };
                h.app.window.kill_timer(SHELL_TIMER);
                h.feed(Input::Tick);
            });
        }

        fn pipe_event(self: &Rc<Self>, event: PipeEvent) {
            match event {
                PipeEvent::Connected { id, client_pid } => {
                    log::note(format!("relay {id}: Margin's connector (pid {client_pid}) connected"));
                    self.feed(Input::RelayOpened { conn: id });
                }
                PipeEvent::Bytes { id, bytes } => self.feed(Input::RelayBytes { conn: id, bytes }),
                PipeEvent::Closed { id, .. } => self.feed(Input::RelayEnded { conn: id }),
                PipeEvent::Refused { why } => log::warn(why),
                PipeEvent::Trouble { why } => log::warn(format!("relay: the pipe: {why}")),
            }
        }

        fn tcp_event(self: &Rc<Self>, event: TcpEvent) {
            match event {
                TcpEvent::Listening { port } => self.feed(Input::Listening { port }),
                TcpEvent::Opened { id } => self.feed(Input::SocketOpened { conn: id }),
                TcpEvent::Bytes { id, bytes } => self.feed(Input::SocketBytes { conn: id, bytes }),
                TcpEvent::Ended { id, error } => self.feed(Input::SocketEnded { conn: id, error }),
                TcpEvent::Log { warn, text } => {
                    if warn {
                        log::warn(text)
                    } else {
                        log::note(text)
                    }
                }
            }
        }

        fn carry_out(self: &Rc<Self>, c: Command) {
            match c {
                Command::RelayWrite { conn, bytes } => {
                    let sent = self.pipe.borrow().as_ref().is_some_and(|p| p.send(conn, bytes));
                    if !sent {
                        log::note(format!("relay {conn}: gone, a message not sent"));
                    }
                }
                Command::RelayEnd { conn } => {
                    if let Some(p) = self.pipe.borrow().as_ref() {
                        p.close(conn);
                    }
                }
                Command::Write { conn, bytes } => {
                    if let Some(t) = self.tcp.borrow().as_ref() {
                        t.write(conn, bytes);
                    }
                }
                Command::End { conn } => {
                    if let Some(t) = self.tcp.borrow().as_ref() {
                        t.end(conn);
                    }
                }
                Command::CreateOverlay { id } => self.create_overlay(id),
                Command::ShowOverlay { id, frame, above } => self.place(id, frame, above, true),
                Command::PlaceOverlay { id, frame, above } => self.place(id, frame, above, false),
                Command::RestackOverlay { id, above } => {
                    if let Some(s) = self.slots.borrow().get(&id) {
                        s.overlay.restack(above as isize);
                    }
                }
                Command::HideOverlay { id } => {
                    if let Some(s) = self.slots.borrow().get(&id) {
                        s.overlay.hide();
                    }
                }
                Command::ConcealOverlay { id, on } => {
                    if let Some(s) = self.slots.borrow().get(&id) {
                        s.overlay.set_alpha(if on { 0 } else { 255 });
                    }
                }
                Command::ReloadOverlay { id } => {
                    if let Some(w) = self.slots.borrow().get(&id).and_then(|s| s.webview.as_ref()) {
                        w.navigate();
                    }
                }
                Command::DestroyOverlay { id } => {
                    // (Dropped after the borrow: closing a web view may call back.)
                    let slot = self.slots.borrow_mut().remove(&id);
                    drop(slot);
                }
                Command::Receive { id, json } => {
                    if let Some(w) = self.slots.borrow().get(&id).and_then(|s| s.webview.as_ref()) {
                        w.receive(&json);
                    }
                }
                Command::Reply { token, result } => {
                    let reply = self.replies.borrow_mut().remove(&token);
                    if let Some(r) = reply {
                        match result {
                            Ok(v) => r.ok(v),
                            Err(e) => r.err(e),
                        }
                    }
                }
                Command::SetPassThrough { id, on } => {
                    if let Some(s) = self.slots.borrow().get(&id) {
                        s.overlay.set_pass_through(on);
                    }
                }
                Command::TakeKeyboard { id } => {
                    let slots = self.slots.borrow();
                    let Some(s) = slots.get(&id) else { return };
                    if s.overlay.take_keyboard() {
                        if let Some(w) = &s.webview {
                            w.focus();
                        }
                    } else {
                        log::note("an overlay couldn't take the keyboard (Windows refused the foreground)");
                    }
                }
                Command::HandBack { id, to } => {
                    if let (Some(s), Some(to)) = (self.slots.borrow().get(&id), to) {
                        s.overlay.hand_back(to as isize);
                    }
                }
                Command::HotKeys { keys } => self.hot_keys(&keys),
                Command::PointerWatch { on } => {
                    if let Some(p) = self.pointer.borrow_mut().as_mut() {
                        if on { p.start() } else { p.stop() }
                    }
                }
                Command::ReadWindows => self.read_windows(),
                Command::PickThemeFile { id } => self.pick_theme_file(id),
                Command::CopyText { text } => copy_text(&text),
                Command::Log { warn, text } => {
                    if warn {
                        log::warn(text)
                    } else {
                        log::note(text)
                    }
                }
            }
        }

        // ---- the overlays ----

        fn create_overlay(self: &Rc<Self>, id: OverlayId) {
            let overlay = match Overlay::create() {
                Ok(o) => Rc::new(o),
                Err(e) => return log::warn(format!("an overlay's window wasn't made: {e}")),
            };
            let weak = Rc::downgrade(self);
            overlay.set_listener(move |e| {
                if let Some(h) = weak.upgrade() {
                    h.feed(Input::OverlayFocus { id, has: e == OverlayEvent::Activated });
                }
            });
            let number = overlay.hwnd().0 as isize as i64;
            self.slots.borrow_mut().insert(id, Slot { overlay, webview: None, making: false });
            self.feed(Input::OverlayWindow { id, number });
            self.make_web_views();
        }

        /// A web view for every overlay that has none (the environment there).
        fn make_web_views(self: &Rc<Self>) {
            let Some(env) = self.env.borrow().clone() else { return };
            let wanted: Vec<(OverlayId, HWND, (i32, i32))> = self
                .slots
                .borrow_mut()
                .iter_mut()
                .filter(|(_, s)| s.webview.is_none() && !s.making)
                .map(|(id, s)| {
                    s.making = true;
                    (*id, s.overlay.hwnd(), s.overlay.client_size())
                })
                .collect();
            for (id, hwnd, size) in wanted {
                let weak = Rc::downgrade(self);
                WebView::create(&env, hwnd, size, move |made| {
                    let Some(h) = weak.upgrade() else { return };
                    h.web_view_made(id, made);
                });
            }
        }

        fn web_view_made(self: &Rc<Self>, id: OverlayId, made: Result<WebView, String>) {
            let webview = match made {
                Ok(w) => w,
                Err(e) => {
                    log::warn(format!("an overlay's web view: {e}"));
                    if let Some(s) = self.slots.borrow_mut().get_mut(&id) {
                        s.making = false;
                    }
                    return;
                }
            };
            let mut slots = self.slots.borrow_mut();
            let Some(slot) = slots.get_mut(&id) else { return }; // closed meanwhile: dropped here
            connect(&slot.overlay, &webview);
            let weak: Weak<Host> = Rc::downgrade(self);
            webview.on_op(move |op| {
                let Some(h) = weak.upgrade() else { return };
                let reply = op.reply.wanted().then(|| {
                    let token = h.next_token.get();
                    h.next_token.set(token + 1);
                    token
                });
                if let Some(token) = reply {
                    h.replies.borrow_mut().insert(token, op.reply);
                }
                h.feed(Input::PageOp { id, op: op.op, body: op.body, reply });
            });
            let weak: Weak<Host> = Rc::downgrade(self);
            webview.on_event(move |e| {
                let Some(h) = weak.upgrade() else { return };
                match e {
                    WebViewEvent::Loaded { ok } => h.feed(Input::PageLoaded { id, ok }),
                    WebViewEvent::Crashed { kind } => {
                        log::warn(format!("an overlay's web view process failed (kind {kind})"));
                        h.feed(Input::PageCrashed { id });
                    }
                }
            });
            let (w, hgt) = slot.overlay.client_size();
            webview.resize(w, hgt);
            webview.navigate();
            slot.webview = Some(webview);
            slot.making = false;
        }

        fn place(&self, id: OverlayId, frame: margin_core::geometry::Rect, above: i64, show: bool) {
            if !placeable(&frame) {
                return;
            }
            let px = self.screens.borrow().to_px(&frame);
            let slots = self.slots.borrow();
            let Some(s) = slots.get(&id) else { return };
            let placed = if show { s.overlay.show(px, above as isize) } else { s.overlay.place(px, above as isize) };
            if placed && let Some(w) = &s.webview {
                w.resize(px.width(), px.height());
            }
        }

        // ---- the windows ----

        /// The windows read and handed to the shell: at most every READ_GAP (the rest wait for the read timer).
        fn read_windows(self: &Rc<Self>) {
            let now = time::now();
            let since = now - self.last_read.get();
            if since < READ_GAP {
                if !self.read_pending.replace(true) {
                    let weak = Rc::downgrade(self);
                    let ms = super::wait_ms(self.last_read.get() + READ_GAP, now);
                    self.app.window.set_timer(READ_TIMER, ms, move || {
                        let Some(h) = weak.upgrade() else { return };
                        h.app.window.kill_timer(READ_TIMER);
                        h.read_pending.set(false);
                        h.read_windows();
                    });
                }
                return;
            }
            self.last_read.set(now);
            *self.screens.borrow_mut() = ScreenMap::read();
            let frames = self.source.browser_windows();
            let browser_pids: HashSet<u32> = frames.iter().map(|w| w.pid).collect();
            let mut pids = browser_pids.clone();
            pids.insert(std::process::id());
            let list = self.source.read(&pids).unwrap_or_default();
            let browsers = frames
                .iter()
                .map(|w| (w.pid, w.browser))
                .collect::<HashMap<u32, &str>>()
                .into_iter()
                .map(|(pid, browser)| margin_core::shell::BrowserProcess {
                    pid,
                    browser: browser.to_owned(),
                    root: self.root_of(pid),
                })
                .collect();
            let front = WinWindowSource::foreground();
            if let Some(events) = self.events.borrow_mut().as_mut() {
                events.watch(&browser_pids);
            }
            self.roots.borrow_mut().retain(|pid, _| browser_pids.contains(pid));
            let read = WindowRead {
                list,
                front_pid: front.map(|f| f.1),
                front_window: front.map(|f| f.0 as i64),
                browsers,
                displays: displays(&self.screens.borrow()),
            };
            self.feed(Input::Windows(read));
        }

        /// The browser's main process a process belongs to: up its parents while they're the same executable.
        fn root_of(&self, pid: u32) -> u32 {
            if let Some(r) = self.roots.borrow().get(&pid) {
                return *r;
            }
            let name = crate::process::image_path(pid).map(|p| crate::paths::file_name_lower(&p)).unwrap_or_default();
            let mut root = pid;
            for _ in 0..4 {
                match crate::process::parent(root) {
                    Some((parent, exe)) if !name.is_empty() && exe == name && parent != root => root = parent,
                    _ => break,
                }
            }
            self.roots.borrow_mut().insert(pid, root);
            root
        }

        // ---- the keys ----

        fn hot_keys(&self, keys: &[margin_core::shell::HotKey]) {
            let (ok, not) = hot_key_combos(keys);
            for n in not {
                log::note(format!("hot key {n}: not one RegisterHotKey can hold"));
            }
            let specs: Vec<HotKeySpec> =
                ok.into_iter().map(|(k, combo)| HotKeySpec { id: k.id, combo, repeats: k.repeats }).collect();
            let on = !specs.is_empty();
            let hotkeys = self.hotkeys.borrow();
            let Some(h) = hotkeys.as_ref() else { return };
            let mut failures = h.set(specs);
            failures.extend(h.set_active(on));
            for f in failures {
                log::note(format!("hot key: {} (another app's, or Windows'): not Margin's", f.why));
            }
        }

        // ---- the theme picker ----

        fn pick_theme_file(&self, id: OverlayId) {
            let owner = self.slots.borrow().get(&id).map(|s| s.overlay.hwnd().0 as isize).unwrap_or(0);
            let tx = self.picked.clone();
            let spawned = std::thread::Builder::new().name("margin-picker".into()).spawn(move || {
                let chosen = pick(owner);
                let file = chosen.map(|p| read_chosen(&chosen_theme_path(&p)));
                tx.send((id, file));
            });
            if let Err(e) = spawned {
                log::warn(format!("themes: the picker couldn't start: {e}"));
                self.picked.send((id, None));
            }
        }
    }

    /// The common item dialog, on this (its own) thread: a `.margintheme` file, or a theme folder's `theme.json`.
    /// `None`: cancelled, or no dialog.
    fn pick(owner: isize) -> Option<std::path::PathBuf> {
        // SAFETY: this thread's own apartment, for the dialog's COM objects; undone below.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        let inited = hr.is_ok();
        // SAFETY (the block): COM calls on a dialog made on this thread; the filter strings are 'static; the owner is
        // one of Margin's windows or none (a window gone makes Show fail, which is taken as no choice).
        let path = unsafe {
            let dialog: Option<IFileOpenDialog> = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok();
            dialog.and_then(|d| {
                let filters = [
                    COMDLG_FILTERSPEC { pszName: w!("Margin themes"), pszSpec: w!("*.margintheme;theme.json") },
                    COMDLG_FILTERSPEC { pszName: w!("All files"), pszSpec: w!("*.*") },
                ];
                let _ = d.SetFileTypes(&filters);
                let _ = d.SetTitle(&HSTRING::from("Import Theme"));
                let _ = d.SetOkButtonLabel(&HSTRING::from("Import"));
                let opts = d.GetOptions().unwrap_or_default();
                let _ = d.SetOptions(opts | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST);
                let owner = (owner != 0).then_some(HWND(owner as *mut _));
                d.Show(owner).ok()?;
                let item = d.GetResult().ok()?;
                let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
                let text = name.to_string().ok();
                CoTaskMemFree(Some(name.0 as *const _));
                text.map(std::path::PathBuf::from)
            })
        };
        if inited {
            // SAFETY: pairs the CoInitializeEx above, on the same thread, after every COM object here is gone.
            unsafe { CoUninitialize() };
        }
        path
    }

    /// Text on the clipboard as CF_UNICODETEXT. A failure is logged (never its text).
    fn copy_text(text: &str) {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY (the block): the clipboard opened with no owner and closed on every path; the global block is sized
        // for `wide`, written while locked, and either owned by the clipboard (SetClipboardData succeeded) or freed.
        let ok = unsafe {
            if OpenClipboard(None).is_err() {
                false
            } else {
                let mut done = false;
                if EmptyClipboard().is_ok()
                    && let Ok(mem) = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2)
                {
                    let p = GlobalLock(mem) as *mut u16;
                    if !p.is_null() {
                        std::ptr::copy_nonoverlapping(wide.as_ptr(), p, wide.len());
                        let _ = GlobalUnlock(mem);
                        done = SetClipboardData(CF_UNICODETEXT, Some(HANDLE(mem.0))).is_ok();
                    }
                    if !done {
                        let _ = GlobalFree(Some(mem));
                    }
                }
                let _ = CloseClipboard();
                done
            }
        };
        if !ok {
            log::warn("copyText: the clipboard couldn't be written");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use margin_core::shortcuts::{AppCommand, Combo};

    #[test]
    fn a_theme_json_stands_for_its_folder() {
        assert_eq!(chosen_theme_path(Path::new("/t/mine/theme.json")), PathBuf::from("/t/mine"));
        assert_eq!(chosen_theme_path(Path::new("/t/mine/Theme.JSON")), PathBuf::from("/t/mine"));
        assert_eq!(chosen_theme_path(Path::new("/t/a.margintheme")), PathBuf::from("/t/a.margintheme"));
    }

    #[test]
    fn hot_keys_as_register_hot_key_combinations() {
        let k = |text: &str, command| HotKey {
            id: 0,
            combo: Combo::parse(text).unwrap_or_else(|| panic!("{text}")),
            command,
            repeats: false,
        };
        let (ok, not) =
            hot_key_combos(&[k("Ctrl+KeyT", AppCommand::Palette), k("Ctrl+Alt+ArrowDown", AppCommand::NextTab)]);
        assert!(not.is_empty());
        assert_eq!(ok[0].1, crate::keys::parse("Ctrl+KeyT").unwrap_or_else(|| panic!()));
        assert_eq!(ok[1].1.modifiers, crate::keys::MOD_CONTROL | crate::keys::MOD_ALT);
    }

    #[test]
    fn the_timers_wait() {
        assert_eq!(wait_ms(10.0, 10.0), 1);
        assert_eq!(wait_ms(10.25, 10.0), 250);
        assert_eq!(wait_ms(f64::INFINITY, 0.0), 1);
        assert_eq!(wait_ms(1e9, 0.0), 600_000);
        assert!(!placeable(&Rect::new(0.0, 0.0, 0.0, 10.0)));
    }
}

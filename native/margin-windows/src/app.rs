//! The app mode's start, and its message loop. Windows only.
//!
//! `boot` does what every app start needs before the shell: per-monitor-v2 DPI awareness (before any window:
//! every coordinate is then physical pixels, screens.rs), `%LOCALAPPDATA%\Margin`'s folders and the log, the
//! single instance (instance.rs: a second launch exits here), COM for WebView2 (single-threaded apartment on
//! this, the UI thread), the native-messaging host's registration (install.rs, rewritten at every launch) and
//! Margin's message window. `run` then starts the pipe and runs the message loop.
//!
//! TODO(shell): the shell (Shell.swift's counterpart) is written apart. It takes `App`, the pipe's events, the
//! windows (browsers.rs), the overlays (overlay.rs, webview.rs), the pointer (pointer.rs) and the keys
//! (hotkeys.rs) from here; until then the app links relays and logs what they do.

use std::path::PathBuf;
use std::rc::Rc;

use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx};
use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext};
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, MSG, TranslateMessage};

use crate::handshake::BUILD;
use crate::instance::{Claim, Instance};
use crate::log;
use crate::msgwin::{MessageWindow, message_id};
use crate::paths::Paths;
use crate::pipe::{PipeEvent, PipeServer};
use crate::queue::ui_channel;
use crate::win::error_text;

/// What a started app has.
pub struct App {
    pub paths: Paths,
    pub sid: String,
    pub exe: PathBuf,
    /// Started from the Run key at sign-in.
    pub login: bool,
    pub window: Rc<MessageWindow>,
    /// Held until the app quits: the single instance.
    _instance: Option<Instance>,
}

/// The pipe's wake message on the message window.
pub const PIPE_WAKE: u32 = message_id(0);

/// Starts the app. `Ok(None)`: another Margin of this user's session is running (this one should exit).
pub fn boot(login: bool) -> Result<Option<App>, String> {
    // SAFETY: a process-wide setting, made before any window exists; it fails only if already set (by a
    // manifest), which is fine.
    if let Err(e) = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } {
        log::note(format!("DPI awareness already set ({})", error_text(e)));
    }
    let paths = Paths::for_user().ok_or("no %LOCALAPPDATA%")?;
    if let Err(e) = paths.create_all() {
        log::warn(format!("Margin's folders couldn't be made: {e}"));
    }
    log::init(&paths.logs, "margin");
    log::note(format!("Margin {BUILD} starting{}", if login { " at sign-in" } else { "" }));
    let sid = crate::security::current_user_sid()?;
    let instance = match crate::instance::claim(&sid) {
        Ok(Claim::First(i)) => Some(i),
        Ok(Claim::Running) => {
            log::note("another Margin is running: this one exits");
            return Ok(None);
        }
        Err(e) => {
            log::warn(format!("the single-instance check failed ({e}): starting anyway"));
            None
        }
    };
    // SAFETY: once, on the UI thread, before any COM object; WebView2 needs a single-threaded apartment.
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    if hr.is_err() {
        log::warn(format!("COM didn't start: {:#010x}", hr.0 as u32));
    }
    let exe = crate::win::exe_path().ok_or("no path for margin.exe")?;
    let installed = crate::install::install(&paths, &exe);
    if installed.origins == 0 {
        log::warn("the native-messaging host allows no extension yet (install.rs EXTENSION_IDS, MARGIN_EXTENSION_IDS)");
    }
    for f in &installed.failures {
        log::warn(format!("the host registration: {f}"));
    }
    let window = Rc::new(MessageWindow::new()?);
    Ok(Some(App { paths, sid, exe, login, window, _instance: instance }))
}

/// Runs the UI thread's message loop until WM_QUIT; its exit code.
pub fn message_loop() -> i32 {
    let mut msg = MSG::default();
    loop {
        // SAFETY: `msg` is a live MSG; every window of this thread is dispatched to its own procedure.
        let got = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        match got.0 {
            0 => return msg.wParam.0 as i32,
            -1 => {
                log::warn("GetMessageW failed: the app stops");
                return 1;
            }
            _ => {
                // SAFETY: as above.
                unsafe {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
    }
}

/// The app mode: boot, the pipe, the loop.
pub fn run(login: bool) -> i32 {
    let app = match boot(login) {
        Ok(Some(app)) => app,
        Ok(None) => return 0,
        Err(e) => {
            log::warn(format!("Margin couldn't start: {e}"));
            return 1;
        }
    };
    let (tx, rx) = ui_channel::<PipeEvent>(app.window.waker(PIPE_WAKE));
    let server = match PipeServer::start(&app.sid, tx) {
        Ok(s) => Some(s),
        Err(e) => {
            log::warn(format!("no link with the browsers: {e}"));
            None
        }
    };
    app.window.on(PIPE_WAKE, move |_, _| {
        for event in rx.drain() {
            match event {
                PipeEvent::Connected { id, hello, relay_pid } => log::note(format!(
                    "relay {id} linked: {} (pid {}), relay pid {relay_pid}",
                    hello.browser,
                    hello.pid.map(|p| p.to_string()).unwrap_or("?".into())
                )),
                PipeEvent::Frame { .. } => {}
                PipeEvent::Closed { id, why } => log::note(format!("relay {id} gone: {why}")),
                PipeEvent::Refused { why } => log::warn(format!("the pipe refused {why}")),
                PipeEvent::Trouble { why } => log::warn(format!("the pipe: {why}")),
            }
        }
    });
    let code = message_loop();
    drop(server);
    log::note("Margin quits");
    code
}

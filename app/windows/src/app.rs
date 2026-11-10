//! The app mode's start, and its message loop. Windows only.
//!
//! `boot` does what every app start needs before the shell: per-monitor-v2 DPI awareness (before any window:
//! every coordinate is then physical pixels, screens.rs), `%LOCALAPPDATA%\Margin`'s folders and the log, the
//! single instance (instance.rs: a second launch exits here), COM for WebView2 (single-threaded apartment on
//! this, the UI thread), the browsers' host files written by Margin's connector beside `margin.exe`
//! (`margin-connector.exe --install`, in the background, as Margin.app runs its own at each launch) and Margin's
//! message window. `run` then hands the app to the shell's driver (host.rs: the pipe, the link's listener, the
//! windows, the overlays, the keys, margin-core's `Shell`), which runs the message loop.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx};
use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext};
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, MSG, TranslateMessage};

use crate::VERSION;
use crate::instance::{Claim, Instance};
use crate::log;
use crate::msgwin::MessageWindow;
use crate::paths::Paths;
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
    log::note(format!("Margin {VERSION} starting{}", if login { " at sign-in" } else { "" }));
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
    install_host_files(&exe);
    let window = Rc::new(MessageWindow::new()?);
    Ok(Some(App { paths, sid, exe, login, window, _instance: instance }))
}

/// `Connector.installHostFiles`: Chrome's, Edge's and the other Chromium browsers' host files and registry keys,
/// written by the connector beside `margin.exe` (`margin-connector.exe --install`: its own knowledge of where each
/// browser looks, engines/chromium/app/), on a thread of its own; the log says how many it wrote. No console
/// window: `CREATE_NO_WINDOW`.
fn install_host_files(exe: &Path) {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    /// CREATE_NO_WINDOW (winbase.h): a console program started with no console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let connector = crate::paths::connector_path(exe);
    if !connector.is_file() {
        return log::warn(format!(
            "no connector beside margin.exe ({}): Chrome and Edge can't link",
            crate::paths::CONNECTOR_EXE
        ));
    }
    let spawned = std::thread::Builder::new().name("margin-install".into()).spawn(move || {
        let run = Command::new(&connector)
            .arg("--install")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match run {
            Err(e) => log::warn(format!("the connector didn't start: {e}")),
            Ok(done) if !done.status.success() => {
                let why: String = String::from_utf8_lossy(&done.stderr).chars().take(200).collect();
                log::warn(format!("the browsers' host files weren't written: {}", why.trim_end()));
            }
            Ok(done) => {
                let written = String::from_utf8_lossy(&done.stdout).lines().filter(|l| !l.is_empty()).count();
                if written > 0 {
                    log::note(format!("the browsers' host files written: {written}"));
                }
            }
        }
    });
    if let Err(e) = spawned {
        log::warn(format!("the connector didn't start: no thread ({e})"));
    }
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

/// The app mode: boot, then the shell (host.rs) until the loop ends.
pub fn run(login: bool) -> i32 {
    match boot(login) {
        Ok(Some(app)) => crate::host::run(app),
        Ok(None) => 0,
        Err(e) => {
            log::warn(format!("Margin couldn't start: {e}"));
            1
        }
    }
}

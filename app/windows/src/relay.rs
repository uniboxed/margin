//! The native-messaging host (relay mode): Chrome or Edge starts `margin.exe chrome-extension://<id>/
//! --parent-window=<n>` for the extension's `connectNative`, with stdin and stdout as the port. The relay
//! passes the port's frames to the running app over the named pipe and the app's back, both ways untouched
//! (frames.rs framing on both sides), until Chrome closes stdin. Windows only.
//!
//! - It says who started it first: `relayHello` (handshake.rs) with the browser and its pid, read from its
//!   parent process. Chrome starts hosts through `cmd.exe /d /c`, so that's the grandparent (process.rs).
//! - The app not running: the relay starts it (its own executable, no arguments, detached, inheriting none
//!   of the relay's handles, so Chrome's port never hangs on the app) and waits up to 10 s for the pipe.
//! - The pipe lost (the app quit or is restarting): the relay holds Chrome's port, tells the copy
//!   `relayDown`, drops what the copy sends meanwhile, and links again for up to 30 s without starting the app
//!   (a person may have quit it): `relayUp` once linked. After 30 s it exits; the copy's link logic calls
//!   `connectNative` again later, which starts the app.
//! - A frame from the app over 1 MiB would make Chrome close the port: it's dropped (and logged) instead.
//! - A welcome from an app of another build: the relay exits, so Chrome starts the new one next time.

use std::io;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use windows::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CreateProcessW, DETACHED_PROCESS, INFINITE,
    PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, STARTUPINFOW,
};
use windows::core::{HSTRING, PWSTR};

use crate::args::RelayArgs;
use crate::frames::{FROM_CHROME_MAX, PIPE_MAX, TO_CHROME_MAX, read_frame, write_frame};
use crate::handshake::{BUILD, RELAY_DOWN, RELAY_UP, RelayHello, RelayWelcome, browser_name};
use crate::log;
use crate::pipe::{ConnectError, Pipe, connect};
use crate::win::{Handle, error_text};

const FIRST_LINK: Duration = Duration::from_secs(10);
const RELINK: Duration = Duration::from_secs(30);
const RETRY: Duration = Duration::from_millis(50);

enum Msg {
    Chrome(Vec<u8>),
    ChromeClosed,
    PipeDown(String),
}

enum Linked {
    Yes(Pipe),
    ChromeClosed,
    Gone(String),
}

pub fn run(args: RelayArgs) -> i32 {
    if let Some(paths) = crate::paths::Paths::for_user() {
        let _ = std::fs::create_dir_all(&paths.logs);
        log::init(&paths.logs, "relay");
    }
    let Some(exe) = crate::win::exe_path().map(|p| p.to_string_lossy().into_owned()) else {
        log::warn("relay: no path for margin.exe");
        return 1;
    };
    let sid = match crate::security::current_user_sid() {
        Ok(s) => s,
        Err(e) => {
            log::warn(format!("relay: no user SID: {e}"));
            return 1;
        }
    };
    let name = crate::paths::pipe_name(&sid);
    let (browser, browser_pid) =
        match crate::process::ancestor_not_named(std::process::id(), &["cmd.exe", "conhost.exe"], 4) {
            Some((pid, exe_name)) => (browser_name(&exe_name), Some(pid)),
            None => ("other".to_string(), None),
        };
    let hello = RelayHello::new(&args.origin, &browser, browser_pid, args.parent_window);
    log::note(format!(
        "relay {} started for {browser} (pid {}), parent window {}",
        std::process::id(),
        browser_pid.map(|p| p.to_string()).unwrap_or("?".into()),
        if args.parent_window.is_some() { "given" } else { "none" }
    ));

    let (tx, rx) = mpsc::channel::<Msg>();
    let from_chrome = tx.clone();
    let stdin_thread = std::thread::Builder::new().name("relay-stdin".into()).spawn(move || {
        let mut stdin = io::stdin().lock();
        loop {
            match read_frame(&mut stdin, FROM_CHROME_MAX) {
                Ok(Some(body)) => {
                    if from_chrome.send(Msg::Chrome(body)).is_err() {
                        break;
                    }
                }
                Ok(None) | Err(_) => {
                    let _ = from_chrome.send(Msg::ChromeClosed);
                    break;
                }
            }
        }
    });
    if stdin_thread.is_err() {
        log::warn("relay: no thread for stdin");
        return 1;
    }

    let mut linked_before = false;
    loop {
        let pipe = match link(&name, &exe, &hello, !linked_before, &rx) {
            Linked::Yes(p) => Arc::new(p),
            Linked::ChromeClosed => return 0,
            Linked::Gone(why) => {
                log::note(format!("relay {}: {why}: exiting", std::process::id()));
                return 0;
            }
        };
        if linked_before && to_chrome(RELAY_UP).is_err() {
            return 0;
        }
        linked_before = true;
        let reader_pipe = pipe.clone();
        let pipe_down = tx.clone();
        let reader = std::thread::Builder::new().name("relay-pipe".into()).spawn(move || {
            loop {
                match read_frame(&mut reader_pipe.reader(INFINITE), PIPE_MAX) {
                    Ok(Some(body)) if body.len() > TO_CHROME_MAX => {
                        log::warn(format!(
                            "relay: a frame of {} bytes from the app dropped (Chrome takes 1 MiB)",
                            body.len()
                        ));
                    }
                    Ok(Some(body)) => {
                        if to_chrome(&body).is_err() {
                            let _ = pipe_down.send(Msg::ChromeClosed);
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = pipe_down.send(Msg::PipeDown("the app closed the pipe".into()));
                        break;
                    }
                    Err(e) => {
                        let _ = pipe_down.send(Msg::PipeDown(format!("the pipe broke: {e}")));
                        break;
                    }
                }
            }
        });
        let Ok(reader) = reader else {
            log::warn("relay: no thread for the pipe");
            return 1;
        };
        let why = loop {
            match rx.recv() {
                Ok(Msg::Chrome(body)) => {
                    if let Err(e) = write_frame(&mut pipe.writer(), &body, PIPE_MAX) {
                        break format!("writing to the app: {e}");
                    }
                }
                Ok(Msg::ChromeClosed) | Err(_) => {
                    pipe.stop();
                    let _ = reader.join();
                    return 0;
                }
                Ok(Msg::PipeDown(why)) => break why,
            }
        };
        pipe.stop();
        let _ = reader.join();
        log::note(format!("relay {}: {why}: holding the port and linking again", std::process::id()));
        if to_chrome(RELAY_DOWN).is_err() {
            return 0;
        }
    }
}

/// One frame to Chrome on stdout.
fn to_chrome(body: &[u8]) -> io::Result<()> {
    write_frame(&mut io::stdout().lock(), body, TO_CHROME_MAX)
}

/// Links to the app: connects (starting the app once, if `may_start`), checks its welcome, says the hello.
/// What Chrome sends meanwhile is dropped: the copy's link is down until `relayUp` or the first link.
fn link(name: &str, exe: &str, hello: &RelayHello, may_start: bool, rx: &Receiver<Msg>) -> Linked {
    let deadline = Instant::now() + if may_start { FIRST_LINK } else { RELINK };
    let mut started = false;
    let mut dropped = 0usize;
    let mut last_error: String;
    loop {
        match connect(name, exe) {
            Ok(pipe) => match handshake(&pipe, hello) {
                Ok(true) => {
                    if dropped > 0 {
                        log::note(format!("relay: {dropped} frames from the copy dropped while unlinked"));
                    }
                    return Linked::Yes(pipe);
                }
                Ok(false) => return Linked::Gone("the app is another build".into()),
                Err(e) => last_error = format!("the handshake failed: {e}"),
            },
            Err(ConnectError::NotThere) => {
                last_error = "the app isn't running".into();
                if may_start && !started {
                    started = true;
                    match start_app(exe) {
                        Ok(()) => log::note("relay: the app wasn't running: started it"),
                        Err(e) => log::warn(format!("relay: the app couldn't be started: {e}")),
                    }
                }
            }
            Err(ConnectError::Busy) => last_error = "the pipe is busy".into(),
            Err(ConnectError::Other(e)) => last_error = e,
        }
        if Instant::now() >= deadline {
            return Linked::Gone(format!("no link ({last_error})"));
        }
        // Waits between tries, taking what Chrome sends meanwhile.
        let until = Instant::now() + RETRY;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(Msg::Chrome(_)) => dropped += 1,
                Ok(Msg::ChromeClosed) | Err(RecvTimeoutError::Disconnected) => return Linked::ChromeClosed,
                Ok(Msg::PipeDown(_)) => {}
                Err(RecvTimeoutError::Timeout) => break,
            }
        }
    }
}

/// The app's welcome, then the hello. `Ok(false)`: the app is another build.
fn handshake(pipe: &Pipe, hello: &RelayHello) -> io::Result<bool> {
    let body = read_frame(&mut pipe.reader(5000), 64 * 1024)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "closed before its welcome"))?;
    let welcome =
        RelayWelcome::parse(&body).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not a welcome"))?;
    if welcome.version != BUILD {
        return Ok(false);
    }
    write_frame(&mut pipe.writer(), &hello.to_json(), PIPE_MAX)?;
    Ok(true)
}

/// Starts the app: this executable, no arguments, detached from the relay (no console, no inherited handles,
/// its own process group), out of Chrome's job if the job allows that.
fn start_app(exe: &str) -> Result<(), String> {
    let dir = std::path::Path::new(exe).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    match create_process(exe, &dir, base | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(()) => Ok(()),
        // A job that doesn't allow breaking away refuses the flag (ERROR_ACCESS_DENIED): start it inside.
        Err(_) => create_process(exe, &dir, base),
    }
}

fn create_process(exe: &str, dir: &str, flags: PROCESS_CREATION_FLAGS) -> Result<(), String> {
    let app = HSTRING::from(exe);
    // CreateProcessW may write into the command line: a buffer of our own, null-terminated.
    let mut command: Vec<u16> = format!("\"{exe}\"").encode_utf16().chain(std::iter::once(0)).collect();
    let cwd = HSTRING::from(dir);
    let si = STARTUPINFOW { cb: size_of::<STARTUPINFOW>() as u32, ..Default::default() };
    let mut pi = PROCESS_INFORMATION::default();
    // SAFETY: every string is null-terminated and alive for the call; `command` is a mutable buffer as the
    // call requires; bInheritHandles is false, so Chrome's pipes stay the relay's alone.
    unsafe {
        CreateProcessW(
            &app,
            Some(PWSTR(command.as_mut_ptr())),
            None,
            None,
            false,
            flags,
            None,
            if dir.is_empty() { windows::core::PCWSTR::null() } else { windows::core::PCWSTR(cwd.as_ptr()) },
            &si,
            &mut pi,
        )
    }
    .map_err(error_text)?;
    // SAFETY: CreateProcessW gave both handles to us: closed at once (the app runs on).
    unsafe {
        drop(Handle::new(pi.hProcess));
        drop(Handle::new(pi.hThread));
    }
    Ok(())
}

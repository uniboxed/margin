//! Margin for Windows (docs/windows/BRIEF.md). One executable, two modes, chosen by the command line (args.rs):
//! - the app (no arguments, or `--login` from the Run key): follows Chrome's and Edge's windows, draws the
//!   overlay page over them, holds Margin's keys, keeps the lasting data (app.rs);
//! - the native-messaging host (started by Chrome or Edge with the caller's origin as its first argument and
//!   `--parent-window=<n>`): relays the extension's port to the running app over a named pipe for this user
//!   only (relay.rs).
//!
//! `windows_subsystem = "windows"`: neither mode shows a console. A relay still has its standard handles:
//! Chrome starts it with stdin and stdout redirected to pipes, and a GUI-subsystem process keeps those.

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    use margin_windows::{app, args, log, relay};
    let code = match args::mode(std::env::args().skip(1)) {
        args::Mode::Relay(r) => relay::run(r),
        args::Mode::App { login } => app::run(login),
    };
    log::flush();
    std::process::exit(code);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("margin-windows runs on Windows only: check it with `cargo check --target x86_64-pc-windows-msvc`");
    std::process::exit(1);
}

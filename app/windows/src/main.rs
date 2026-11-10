//! Margin for Windows (docs/windows/BRIEF.md): the app (no arguments, or `--login` from the Run key). It follows
//! Chrome's and Edge's windows, draws the overlay page over them, holds Margin's keys, keeps the lasting data, and
//! links to each copy of Margin's extension over its WebSocket (app.rs, host.rs). The browsers' native-messaging
//! host is the other program, `margin-connector.exe` beside it (app/shared/connector/): it finds this app over
//! its named pipe and hands the copy the link. A browser starting `margin.exe` itself (an older registration)
//! makes it exit at once (args.rs).
//!
//! `windows_subsystem = "windows"`: it never shows a console.

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    use margin_windows::{app, args, log};
    let code = match args::mode(std::env::args().skip(1)) {
        args::Mode::App { login } => app::run(login),
        args::Mode::NotTheHost => 0,
    };
    log::flush();
    std::process::exit(code);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("margin-windows runs on Windows only: check it with `cargo check --target x86_64-pc-windows-msvc`");
    std::process::exit(1);
}

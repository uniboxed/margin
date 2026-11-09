//! Margin for Windows (native/BRIEF.md). One executable, two modes:
//! - the app (no arguments, or started at login): follows Chrome's and Edge's windows, draws the overlay page over
//!   them, holds Margin's keys, keeps the lasting data;
//! - the native-messaging host (started by Chrome or Edge with the caller's origin as its first argument):
//!   relays the extension's port to the running app over a named pipe for this user only.

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    std::process::exit(0);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("margin-windows runs on Windows only: check it with `cargo check --target x86_64-pc-windows-msvc`");
    std::process::exit(1);
}

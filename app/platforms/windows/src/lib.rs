//! Margin for Windows' OS layer (docs/windows/BRIEF.md, "The plan" step 1): each module a small API the shell
//! drives; the shell itself is margin-core's (`margin_core::shell`), driven by host.rs. `main.rs` is the executable.
//!
//! The modules without `cfg(windows)` are OS-neutral and tested on the Mac (`cargo test -p margin-windows`);
//! the rest is Win32 and only compile-checked there (`--target x86_64-pc-windows-msvc`). Rules for the Win32
//! half: the message loop and every window on the main (UI) thread; anything that blocks (the pipe, the sockets) on
//! threads of its own, handing results over with queue.rs; every `unsafe` block says why it's sound; an OS
//! failure is logged and lived with, never a panic; handles are owned (win.rs `Handle`, `RegKey`).

// OS-neutral.
pub mod args;
pub mod bridge;
// Chrome and Edge for the hosted design: a copy's window found by its mark, the browser started, its profiles.
pub mod chromium;
// Margin's own window: the holes cut from it for the windows it hosts, and its frame's hit test.
pub mod hole;
pub mod host;
// Hosting on Windows: margin-core's reconcile driver with Windows's own calls (compile- and unit-checked only).
pub mod hosting;
pub mod instance;
pub mod keys;
pub mod log;
// What Margin did to other apps' windows, on disk, given back after a crash.
pub mod marker;
pub mod paths;
pub mod pointer;
pub mod queue;
pub mod screens;
pub mod serve;
pub mod tcp;

// Windows.
#[cfg(windows)]
pub mod app;
#[cfg(windows)]
pub mod browsers;
#[cfg(windows)]
pub mod hotkeys;
#[cfg(windows)]
pub mod msgwin;
#[cfg(windows)]
pub mod overlay;
#[cfg(windows)]
pub mod pipe;
#[cfg(windows)]
pub mod process;
#[cfg(windows)]
pub mod security;
#[cfg(windows)]
pub mod webview;
#[cfg(windows)]
pub mod win;

/// This build's version: the `link`'s `app.version` and `relayWelcome`'s. A connector built with another
/// `MARGIN_APP_VERSION` exits on the welcome (the browser starts the new one next time); built without it, the
/// connector says none and isn't checked.
pub const VERSION: &str = match option_env!("MARGIN_APP_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

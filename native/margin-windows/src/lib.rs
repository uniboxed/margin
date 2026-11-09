//! Margin for Windows' OS layer (native/BRIEF.md, "The plan" step 1): each module a small API the shell
//! drives; the shell itself is margin-core's (`margin_core::shell`), driven by host.rs. `main.rs` is the executable.
//!
//! The modules without `cfg(windows)` are OS-neutral and tested on the Mac (`cargo test -p margin-windows`);
//! the rest is Win32 and only compile-checked there (`--target x86_64-pc-windows-msvc`). Rules for the Win32
//! half: the message loop and every window on the main (UI) thread; anything that blocks (pipes, stdio) on
//! threads of its own, handing results over with queue.rs; every `unsafe` block says why it's sound; an OS
//! failure is logged and lived with, never a panic; handles are owned (win.rs `Handle`, `RegKey`).

// OS-neutral.
pub mod args;
pub mod bridge;
pub mod frames;
pub mod handshake;
pub mod host;
pub mod install;
pub mod instance;
pub mod keys;
pub mod log;
pub mod paths;
pub mod pointer;
pub mod queue;
pub mod screens;
pub mod serve;

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
pub mod relay;
#[cfg(windows)]
pub mod security;
#[cfg(windows)]
pub mod webview;
#[cfg(windows)]
pub mod win;

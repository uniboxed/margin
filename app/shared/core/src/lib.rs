//! Margin's OS-neutral shell logic (docs/windows/BRIEF.md, "The plan"): everything of Margin.app that doesn't touch
//! the OS, ported from app/platforms/macos/shell/ and tested on any OS. Each module names the Swift file it follows.

pub mod geometry;
pub mod json;
pub mod system;
pub mod time;

// The link (ExtensionLink.swift, LinkSocket.swift, LinkMessage.swift, Chunks.swift, StateMirror.swift): the copies'
// WebSockets on every OS.
pub mod chunks;
pub mod link;
pub mod mirror;
pub mod protocol;
pub mod relay;
pub mod socket;
pub mod websocket;

// The lasting data (DataSet.swift, DataStore.swift, DataSync.swift, BrowserProfiles.swift, ThemeStore.swift).
pub mod data;

// Windows (WindowMap.swift, WindowMatcher.swift) and the overlays (PassThrough.swift, OverlayPlanner.swift).
pub mod binder;
pub mod passthrough;
pub mod planner;
pub mod window_map;

// Keys (Shortcuts.swift), spaces across profiles (ShellProfiles.swift) and the switch (ProfileSwitch.swift).
pub mod across;
pub mod shortcuts;
pub mod switch;

// The shell that joins them (Shell.swift), sans IO.
pub mod shell;

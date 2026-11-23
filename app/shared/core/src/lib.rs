//! Margin's OS-neutral shell logic (docs/windows/BRIEF.md, "The plan"): everything of Margin.app that doesn't touch
//! the OS, ported from app/platforms/macos/shell/ and tested on any OS. Each module names the Swift file it follows.

pub mod geometry;
pub mod json;
pub mod system;
pub mod time;

// The link: the copies' WebSockets on every OS, the one copy of its rules (the Mac's through margin-ffi's link object:
// `link_hub`, which keeps each link's `mirror`).
pub mod chunks;
pub mod link;
pub mod link_hub;
pub mod mirror;
pub mod protocol;
pub mod relay;
pub mod socket;
pub mod websocket;

// The lasting data and the imported themes (the Mac's through margin-ffi: DataSync.swift, BrowserProfiles.swift,
// ThemeStore.swift are its wrappers).
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

// The hosting core (HostEngine.swift's decisions: layout, window kinds, the reconciler, the loop guard, the causes,
// the routes), sans IO: docs/ARCHITECTURE-PLAN.md.
pub mod host;

// The windows a browser's copy makes and drives for the app (hosted.ts's requests), any browser, any OS.
pub mod hosted_browser;

// The session (HostedSession.swift's flows as async steps, docs/CORE-REFACTOR.md step 3): the library's items shown in
// Margin's windows, its executor, ports and commands.
pub mod session;

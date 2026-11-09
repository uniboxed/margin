//! Margin's OS-neutral shell logic (native/BRIEF.md, "The plan"): everything of Margin.app that doesn't touch
//! the OS, ported from app/shell/ and tested on any OS. Each module names the Swift file it follows.

pub mod geometry;
pub mod system;
pub mod time;

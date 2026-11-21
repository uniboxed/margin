//! The hosting core (docs/ARCHITECTURE-PLAN.md): the brain that decides where every hosted app's windows go, the same
//! on every OS. Each OS's shell keeps only the calls that read and move windows (its adapter); everything that
//! decides is here, sans IO, tested on any OS.
//!
//! - `layout`: where a hosted window goes (the page area, a Space's edge reservation, a tile's rect, a minimum size).
//! - `kinds`: every window's kind, by what it does (main, auxiliary, dialog, strip, leftover, helper, transient).
//! - `choice`: which of an app's windows is hosted.
//! - `reconciler`: what each host should be against what's seen, and the corrections between.
//! - `guard`: the loop guard: the same reaction three times within 5 s stops that host.
//! - `causes`: why something changed, before Margin reacts to it.
//! - `routes`: tiles, members, window mode, and the way down for an app that keeps fighting its route.
//! - `schedule`: when the engine looks again (events first, the poll as fast as the moment needs).
//! - `front`: which window of the hosted app the person opened is let in front of Margin's window.
//! - `driver`: the reconcile loop against an OS's adapter (`HostAdapter`): what every OS shares of the steady state.
//! - `api`: the whole of it behind one JSON call, for shells that aren't Rust.

pub mod api;
pub mod causes;
pub mod choice;
pub mod driver;
pub mod front;
pub mod guard;
pub mod kinds;
pub mod layout;
pub mod reconciler;
pub mod routes;
pub mod schedule;

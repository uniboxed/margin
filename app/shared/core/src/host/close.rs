//! A host's close (docs/CORE-REFACTOR.md step 2 part 7): what's given back and in what order, whether its app is quit
//! and how its window goes first, and what Margin's quit couldn't finish for the next launch's recovery (the marker
//! keeps it). Only the decisions: every step (the freeze, the frame given back, out of full screen, the close button,
//! the quit, the moves) is the OS side's, and each decision is asked at the point the Mac's `closeNow` makes it,
//! between the same waits, with the host's facts as they are then (a step before may have changed them).
//!
//! Pure: no state, nothing allocated. The FFI hands the facts as bits (`Facts::from_bits`).

/// How the close waits for its app's exit: a failed open (waited), a row closed (watched in the background), or
/// Margin's quit (every host at once, nothing waited for).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    Waited,
    Watched,
    AtQuit,
}

/// A host's facts at a point of its close (each the OS side's, read then).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    /// An app Margin started (never the person's).
    pub launched_by_margin: bool,
    /// A Safari window a profile's copy made for Margin.
    pub copy_window: bool,
    /// Its app is asking something (a sheet or an alert of its own on screen).
    pub asking: bool,
    /// Another host shares its app.
    pub shares_app: bool,
    /// An app's window (not a Safari window's host).
    pub an_app: bool,
    /// Shown now.
    pub shown: bool,
    pub window_mode: bool,
    /// Margin set its frame and hasn't put it back yet.
    pub frame_changed: bool,
    /// A full-screen member.
    pub member: bool,
    /// Taken in and out of full screen through its Safari copy.
    pub via_copy: bool,
    /// Its window has a full-screen Space of its own.
    pub own_space: bool,
    /// An app the person opened.
    pub person: bool,
    /// Its window is in a private Space Margin made.
    pub private_space: bool,
    /// A Safari window Margin made (not through a copy).
    pub made_by_margin: bool,
    /// A Safari window's host.
    pub safari: bool,
    /// Accessibility didn't take its frame as it was given back.
    pub ax_refused: bool,
    /// Its last exit from full screen wasn't confirmed.
    pub exit_unconfirmed: bool,
}

impl Facts {
    /// From the FFI's bits (bit i: the i-th field above, in order).
    pub fn from_bits(b: u32) -> Facts {
        let on = |i: u32| b & (1 << i) != 0;
        Facts {
            launched_by_margin: on(0),
            copy_window: on(1),
            asking: on(2),
            shares_app: on(3),
            an_app: on(4),
            shown: on(5),
            window_mode: on(6),
            frame_changed: on(7),
            member: on(8),
            via_copy: on(9),
            own_space: on(10),
            person: on(11),
            private_space: on(12),
            made_by_margin: on(13),
            safari: on(14),
            ax_refused: on(15),
            exit_unconfirmed: on(16),
        }
    }
}

/// A row closed while its app is asking something: a Mac app does nothing else until it's answered, so it's asked to
/// quit at once with its window where it is (an app Margin started, its only host).
pub fn quit_at_once(exit: Exit, f: &Facts) -> bool {
    exit == Exit::Watched && f.launched_by_margin && !f.copy_window && f.asking && !f.shares_app && f.an_app
}

/// Whether its giving back is seen (a window-mode window shown or moved, a member out of full screen on the current
/// Space): under the freeze.
pub fn freeze(f: &Facts) -> bool {
    (f.shown && f.window_mode) || (f.window_mode && f.frame_changed) || (f.member && !f.via_copy)
}

/// What's given back first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GiveBack {
    Nothing,
    /// A window-mode window: its frame as it was.
    Frame,
    /// Out of full screen (a member, the one shown, or one mid-way in its own Space).
    OutOfFullScreen,
}

pub fn give_back(f: &Facts) -> GiveBack {
    if f.window_mode {
        GiveBack::Frame
    } else if (!f.via_copy && (f.member || f.shown || f.own_space)) || (f.via_copy && f.own_space) {
        // (Through its copy only one mid-way in its own Space now: a member is made normal later, through its copy.)
        GiveBack::OutOfFullScreen
    } else {
        GiveBack::Nothing
    }
}

/// Whether its app is quit: an app Margin started that no other host shares.
pub fn quits(f: &Facts) -> bool {
    f.launched_by_margin && !f.shares_app
}

/// Whether its window may be closed by its close button before its quit, asked of its app (does it keep its windows
/// across a quit: the OS side reads that only when this says so). Never a window Accessibility didn't take a frame
/// for (it wouldn't press its button either).
pub fn close_first_asks(quits: bool, f: &Facts) -> bool {
    quits && f.an_app && !f.copy_window && !f.ax_refused
}

/// Not closed first: a window-mode one and the person's go home.
pub fn home_after(closed: bool, f: &Facts) -> bool {
    !closed && (f.window_mode || f.person)
}

/// Whether where its window is before the quit matters (the OS side reads whether it's in Margin's Space then).
pub fn before_quit_asks(quits: bool, closed: bool, f: &Facts) -> bool {
    quits && !closed && f.an_app && !f.copy_window
}

/// Where its window goes before its app is asked to quit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BeforeQuit {
    Nothing,
    /// Not waiting for the app: on its Desktop first, out of Margin's Spaces (one that doesn't quit is the person's
    /// there).
    Home,
    /// Waiting for it, its window in Margin's Space: out of sight in a private Space until its quit is done.
    OutOfSight,
}

pub fn before_quit(exit: Exit, in_margin: bool, f: &Facts) -> BeforeQuit {
    let waits = exit == Exit::Waited;
    if !waits && (in_margin || f.private_space) {
        BeforeQuit::Home
    } else if waits && in_margin && !f.private_space {
        BeforeQuit::OutOfSight
    } else {
        BeforeQuit::Nothing
    }
}

/// A copy's window its copy didn't close: on the Desktop meanwhile (closed later), unless Margin waits for its
/// Safari's quit; only from a private Space.
pub fn copy_window_to_desktop(closed: bool, quits: bool, exit: Exit, f: &Facts) -> bool {
    !closed && (!quits || exit != Exit::Waited) && f.private_space
}

/// A Safari window not made by a copy for Margin (one Margin made, or a Safari another host shares): not Margin's to
/// close, left to the person on the Desktop, from a private Space.
pub fn left_to_the_person(f: &Facts) -> bool {
    (f.made_by_margin || (f.safari && f.shares_app)) && f.private_space
}

/// What Margin's quit couldn't finish for the marker (`in_margin`: its window in Margin's Space, as read then): None,
/// done; Some(as_member), kept: its frame not given back, its exit from full screen not confirmed, or its window left
/// in Margin's Space or a private Space (`as_member`: its exit not confirmed, so the next launch takes it out of full
/// screen on the current Space). Asked only of a window still open.
pub fn unfinished(in_margin: bool, f: &Facts) -> Option<bool> {
    let stranded = f.private_space || in_margin;
    let still_full = f.exit_unconfirmed && !f.via_copy;
    let keep = (f.frame_changed && (f.window_mode || f.person)) || ((stranded || still_full) && !f.copy_window);
    keep.then_some(still_full)
}

#[cfg(test)]
mod tests;

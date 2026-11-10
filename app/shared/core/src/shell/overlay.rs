//! One overlay as the shell sees it (the OS-neutral half of app/platforms/macos/shell/Overlay.swift `OverlayController`): whether its
//! page has drawn and asked for its hello, where it is and over which window, the page slot and what's drawn over
//! it, which pointer positions its page wants, and who has the keyboard. Each change the OS must make is a
//! [`Command`] for the driver (the overlay's window and web view are the driver's, by [`OverlayId`]).
//!
//! Left out (the Mac's): the catcher and the edge panel (a layered window's own pass-through stands in for them on
//! Windows; whether the first move over Margin from the page still reaches the browser is unverified), the own-Space
//! behaviour and `placeAhead` (no Spaces), `rekey` (the handoff's), the press-ended keyboard return (a click never
//! takes the keyboard on Windows: `WS_EX_NOACTIVATE`).

use crate::geometry::{Point, Rect};
use crate::passthrough::{PassThrough, PointerWant, Slot, SlotInsets};
use crate::protocol::PageLayout;
use crate::time::Secs;

use super::{Command, Out, WindowKey};

/// The shell's name for one overlay (its window and web view, the driver's).
pub type OverlayId = u64;

#[derive(Clone, Debug)]
pub struct OverlayModel {
    pub id: OverlayId,
    pub key: WindowKey,
    /// Its own window's number (an HWND's value), once the driver made it.
    pub number: Option<i64>,
    /// The page has drawn (`ready`).
    pub ready: bool,
    pub shown: bool,
    pub shown_at: Secs,
    /// The page has asked for its hello: pushes reach it.
    pub asked: bool,
    pub crash_ok: bool,
    crashes: Vec<Secs>,
    pub layout: Option<PageLayout>,
    pub hits: Vec<Rect>,
    pub capture_all: bool,
    /// Where it is (top left, DIPs).
    pub frame: Rect,
    /// Its browser window's bounds: the overlay's frame, or more when the browser takes part of it.
    pub window_frame: Option<Rect>,
    /// The window its layout's insets are measured from, when that isn't `window_frame` (a windowed overlay:
    /// planner::windowed_frame).
    pub layout_window: Option<Rect>,
    /// The browser window it's shown over.
    pub above: Option<i64>,
    pub window_full_screen: bool,
    pub page_fullscreen: bool,
    pub ignoring: bool,
    pass_through: Option<bool>,
    pub concealed: bool,
    pub has_keyboard: bool,
    pub page_wants_keyboard: bool,
    pub page_focus_at: Option<Secs>,
    pub pointer_want: PointerWant,
    pub browser_pid: u32,
    pub palette_key_at: Option<Secs>,
}

impl OverlayModel {
    /// Reloads after the page's process died, within [`OverlayModel::CRASH_WINDOW`]; past that, it stays put away.
    pub const CRASH_LIMIT: usize = 3;
    pub const CRASH_WINDOW: Secs = 300.0;
    /// A field focused at most this long before the overlay shows takes the keyboard as it shows.
    pub const FOCUS_FRESH: Secs = 2.0;

    pub fn new(id: OverlayId, key: WindowKey) -> Self {
        Self {
            id,
            key,
            number: None,
            ready: false,
            shown: false,
            shown_at: f64::INFINITY,
            asked: false,
            crash_ok: true,
            crashes: Vec::new(),
            layout: None,
            hits: Vec::new(),
            capture_all: false,
            frame: Rect::ZERO,
            window_frame: None,
            layout_window: None,
            above: None,
            window_full_screen: false,
            page_fullscreen: false,
            ignoring: false,
            pass_through: None,
            concealed: false,
            has_keyboard: false,
            page_wants_keyboard: false,
            page_focus_at: None,
            pointer_want: PointerWant::ALL,
            browser_pid: 0,
            palette_key_at: None,
        }
    }

    /// The page, loaded again (a new page: nothing of it drawn or focused yet).
    pub fn load(&mut self, out: &mut Out) {
        self.ready = false;
        self.asked = false;
        self.page_wants_keyboard = false;
        self.page_focus_at = None;
        out.push(Command::ReloadOverlay { id: self.id });
    }

    /// The slot in the window server's coordinates (`None` before the page reported its layout).
    pub fn slot(&self) -> Option<Slot> {
        let l = self.layout.as_ref()?;
        let insets = SlotInsets { left: l.left, top: l.top, right: l.right, bottom: l.bottom, radius: l.radius };
        Some(PassThrough::slot(self.frame, insets, &self.hits, self.capture_all))
    }

    /// A message to the page (`marginApp.receive`), as JSON text: only once it has asked for its hello (which has
    /// everything before).
    pub fn push(&self, out: &mut Out, json: impl Into<String>) {
        if self.asked {
            out.push(Command::Receive { id: self.id, json: json.into() });
        }
    }

    /// At the window's size before it shows, so its page measures the slot at the size it will have.
    pub fn size_to(&mut self, out: &mut Out, frame: Rect, above: i64) {
        if frame == self.frame {
            return;
        }
        self.frame = frame;
        out.push(Command::PlaceOverlay { id: self.id, frame, above });
    }

    /// Over the browser window `number`, at `frame`, just above it. False if it can't be shown (not drawn yet, or
    /// its page crashed too often).
    pub fn show(&mut self, out: &mut Out, number: i64, frame: Rect, why: &str, now: Secs) -> bool {
        if !self.ready || !self.crash_ok {
            return false;
        }
        let moved = frame != self.frame;
        self.frame = frame;
        self.reveal(out);
        let ordered = !self.shown || self.above != Some(number);
        self.above = Some(number);
        if ordered {
            out.push(Command::ShowOverlay { id: self.id, frame, above: number });
        } else if moved {
            out.push(Command::PlaceOverlay { id: self.id, frame, above: number });
        }
        if !self.shown {
            self.shown = true;
            self.shown_at = now;
            out.note(format!("overlay shown over {} (window {number}): {why}", self.key));
        }
        true
    }

    /// Put back just above its browser window (something came between them).
    pub fn reorder(&self, out: &mut Out) {
        if let (true, Some(above)) = (self.shown, self.above) {
            out.push(Command::RestackOverlay { id: self.id, above });
        }
    }

    /// Unseen where it is (its window missing from a read, or its page in full screen); the mouse passes through.
    pub fn conceal(&mut self, out: &mut Out) {
        if !self.shown || self.concealed {
            return;
        }
        self.concealed = true;
        out.push(Command::ConcealOverlay { id: self.id, on: true });
        self.apply_pass_through(out);
    }

    pub fn reveal(&mut self, out: &mut Out) {
        if !self.concealed {
            return;
        }
        self.concealed = false;
        out.push(Command::ConcealOverlay { id: self.id, on: false });
        self.apply_pass_through(out);
    }

    /// Put away. `why`: for the log (only a shown overlay put away is logged).
    pub fn hide(&mut self, out: &mut Out, why: &str) {
        if self.shown && self.page_wants_keyboard {
            self.let_go(out, &format!("put away: {why}"));
        } else if self.has_keyboard {
            self.hand_back(out, &format!("put away: {why}"));
        }
        if self.shown {
            out.note(format!("overlay put away ({}): {why}", self.key));
            out.push(Command::HideOverlay { id: self.id });
        }
        self.reveal(out);
        self.shown = false;
        self.above = None;
        self.set_ignoring(out, false);
    }

    /// Whether the pointer passes through to the page (said to the OS only when it changes).
    pub fn set_ignoring(&mut self, out: &mut Out, on: bool) {
        self.ignoring = on;
        self.apply_pass_through(out);
    }

    fn apply_pass_through(&mut self, out: &mut Out) {
        let want = self.ignoring || self.concealed;
        if self.pass_through != Some(want) {
            self.pass_through = Some(want);
            out.push(Command::SetPassThrough { id: self.id, on: want });
        }
    }

    /// A text field of Margin's has focus: the keyboard is the overlay's. Only while it's shown.
    pub fn take_keyboard(&mut self, out: &mut Out, now: Secs) {
        if !self.shown {
            return;
        }
        let had = self.has_keyboard;
        self.has_keyboard = true;
        if !had {
            let after = self
                .palette_key_at
                .map(|t| format!(" {} ms after the palette's key", ((now - t) * 1000.0).round() as i64))
                .unwrap_or_default();
            out.note(format!("{} took the keyboard{after}", self.key));
            out.push(Command::TakeKeyboard { id: self.id });
        }
        self.palette_key_at = None;
    }

    /// Shown just now (it wasn't). A field focused while hidden takes the keyboard only over the front window and
    /// if fresh; otherwise the page lets go (`blur`). Then the page hears it's shown.
    pub fn appeared(&mut self, out: &mut Out, front: bool, palette: bool, focus_launcher: bool, now: Secs) {
        if self.page_wants_keyboard && !self.has_keyboard {
            let age = self.page_focus_at.map(|t| now - t);
            match age {
                Some(age) if front && age <= Self::FOCUS_FRESH => {
                    out.note(format!(
                        "{}: shown {} ms after a field of its page took the focus: the keyboard is the overlay's",
                        self.key,
                        (age * 1000.0) as i64
                    ));
                    self.take_keyboard(out, now);
                }
                _ => {
                    let why = if front {
                        format!(
                            "shown {} after its field took the focus",
                            age.map(|a| format!("{} ms", (a * 1000.0) as i64)).unwrap_or_else(|| "long".into())
                        )
                    } else {
                        "shown, but not over the front window".into()
                    };
                    self.let_go(out, &why);
                }
            }
        }
        let free = !self.page_wants_keyboard;
        let focus = focus_launcher && !palette && free;
        let palette = palette && free;
        self.push(out, format!(r#"{{"type":"shown","focus":{focus},"palette":{palette}}}"#));
    }

    /// The page told to let go of its focus (`blur`), and the keyboard given back if it had it.
    pub fn let_go(&mut self, out: &mut Out, why: &str) {
        let had = self.has_keyboard;
        self.hand_back(out, why);
        if !had && self.page_wants_keyboard {
            out.note(format!("{}: its page told to let go of the focus: {why}", self.key));
        }
        self.page_wants_keyboard = false;
        self.page_focus_at = None;
        self.push(out, r#"{"type":"blur"}"#);
    }

    /// The keyboard back to the browser's window.
    pub fn hand_back(&mut self, out: &mut Out, why: &str) {
        let had = self.has_keyboard;
        self.has_keyboard = false;
        if !had {
            return;
        }
        out.note(format!("{} gave the keyboard back: {why}", self.key));
        out.push(Command::HandBack { id: self.id, to: self.above });
    }

    /// The page's process died: loaded again, unless that keeps happening. True if it's loaded again.
    pub fn crashed(&mut self, out: &mut Out, now: Secs) -> bool {
        self.crashes.retain(|t| now - t < Self::CRASH_WINDOW);
        self.crashes.push(now);
        self.page_wants_keyboard = false;
        self.hide(out, "its page stopped");
        if self.crashes.len() > Self::CRASH_LIMIT {
            out.warn(format!(
                "an overlay's page stopped {} times in {} minutes: put away until Margin opens again",
                self.crashes.len(),
                (Self::CRASH_WINDOW / 60.0) as i64
            ));
            self.crash_ok = false;
            return false;
        }
        out.warn("an overlay's page stopped: loading it again");
        self.load(out);
        true
    }

    /// Whether `point` is over it.
    pub fn contains(&self, point: Point) -> bool {
        self.frame.contains(point)
    }
}

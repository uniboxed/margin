//! A press on Margin's own UI and the keyboard (docs/SIDEBAR-PRESS.md; GitHub #29).
//!
//! While a Margin window shows a hosted window (hosting, its page card `shown`) and no field of Margin's wants the
//! keys, a press on Margin's UI (the sidebar, the frame around the page card, a split's divider: anything of the
//! window's that isn't the way through to what it hosts) leaves the keyboard where it is: the hosted app keeps its key
//! window and its active look. Margin's UI still gets the press, whatever it is (a row, a drag, a right-click's menu, a
//! double-click); a field the press focuses takes the keys then, as the page says (its `focus` op), and only then.
//!
//! The Mac's press tap delivers such a press to Margin's panel as the window server's own record, so the window server
//! never routes it and never moves the keyboard (app/platforms/macos/shell/PaneClickTap.swift); Windows' window
//! answers `MA_NOACTIVATE` to a press while it hosts (app/platforms/windows/src/appwindow.rs, which can read
//! [`keys_stay`] once its window has a page of the core's).
//!
//! Anything else is as it was: a field's keys are its own (a press while it has them is Margin's as before), the
//! launcher's press makes Margin the front app (nothing hosted: no app's look to keep), a press through the hole is the
//! hosted window's.

use super::{Page, PageState};
use crate::geometry::{Point, Rect};
use crate::passthrough::{Cg, Edges, SlotRef, passes};

/// Whether a press on Margin's UI leaves the keyboard where it is: hosting, a hosted window in place and shown, and no
/// field of Margin's wanting the keys.
pub fn keys_stay(hosting: bool, hosted: bool, state: PageState, field_keys: bool) -> bool {
    hosting && hosted && state == PageState::Shown && !field_keys
}

/// Which way a press goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PressWay {
    /// Not on this window's content at all.
    Outside = 0,
    /// Through it: to what it hosts (the slot's hole), or to the window's own buttons under the theme's controls while
    /// windowed. As the window server routes it.
    Through = 1,
    /// Margin's UI, the keyboard staying where it is ([`keys_stay`]): delivered to Margin's UI without the keyboard.
    Ui = 2,
    /// Margin's UI, as it always was (a field has the keys, nothing shown): routed, the keys may move.
    Routed = 3,
}

/// The way of a press at `at` (top left, the window server's coordinates) on a window whose content is at `content`,
/// with this pointer slot (None: none, Margin's everywhere), the theme's window controls (in the content; None: none)
/// and whether it's in full screen, and the window's [`keys_stay`]. CGRect's edges, as the pointer's own rules.
pub fn press_way(
    at: Point,
    content: Rect,
    slot: Option<SlotRef<'_>>,
    controls: Option<Rect>,
    full_screen: bool,
    keys_stay: bool,
) -> PressWay {
    if !Cg::contains(&content, at) {
        return PressWay::Outside;
    }
    if passes::<Cg>(at, content, slot, controls, full_screen) {
        return PressWay::Through;
    }
    if keys_stay { PressWay::Ui } else { PressWay::Routed }
}

impl Page {
    /// A field of Margin's wants the keys, or let go (the page's `focus`: a field focused, a menu or prompt open).
    /// Whether one wanted them before.
    pub fn set_field_keys(&mut self, on: bool) -> bool {
        std::mem::replace(&mut self.field_keys, on)
    }

    /// A field of Margin's wants the keys.
    pub fn field_keys(&self) -> bool {
        self.field_keys
    }

    /// Whether a press on Margin's UI leaves the keyboard where it is now ([`keys_stay`] of this window).
    pub fn presses_keep_keys(&self) -> bool {
        keys_stay(self.hosting, self.hosted.is_some(), self.state, self.field_keys)
    }

    /// The way of a press at `at` on this window, its content at `content` ([`press_way`] with its own slot, window
    /// controls and full screen).
    pub fn press_way(&self, at: Point, content: Rect) -> PressWay {
        let (controls, full_screen) = self.pointer.buttons();
        press_way(at, content, self.pointer.slot(), controls, full_screen, self.presses_keep_keys())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::passthrough::{Holes, SlotInsets};

    fn p(x: f64, y: f64) -> Point {
        Point::new(x, y)
    }
    const CONTENT: Rect = Rect::new(0.0, 0.0, 1512.0, 982.0);
    const PAGE: Rect = Rect::new(248.0, 8.0, 1256.0, 966.0);
    const DOCKED: SlotInsets = SlotInsets { left: 248.0, top: 8.0, right: 8.0, bottom: 8.0, radius: 10.0 };

    #[test]
    fn the_keys_stay_only_while_an_app_is_shown_and_no_field_wants_them() {
        use PageState::*;
        assert!(keys_stay(true, true, Shown, false), "an app shown, no field: the keys stay with it");
        assert!(!keys_stay(true, true, Shown, true), "a field of Margin's wants them: its own");
        assert!(!keys_stay(true, true, Loading, false), "an item opening: as before");
        assert!(!keys_stay(true, false, Shown, false), "nothing hosted");
        assert!(!keys_stay(false, true, Shown, false), "not hosting");
        assert!(!keys_stay(false, false, Empty, false), "the launcher: Margin made the front app, as before");
        assert!(!keys_stay(false, false, Elsewhere, false), "its card: its item in another window");
    }

    #[test]
    fn a_press_goes_through_to_the_app_or_is_margins_with_the_keys_staying() {
        let mut ptr = crate::passthrough::PagePointer::default();
        ptr.place(CONTENT, Some(DOCKED), &[Rect::new(600.0, 100.0, 300.0, 200.0)], false, Holes::One(Some(PAGE)));
        let slot = ptr.slot();
        assert!(slot.is_some());
        let way = |at: Point, keys: bool| press_way(at, CONTENT, slot, None, true, keys);
        assert_eq!(way(p(120.0, 400.0), true), PressWay::Ui, "the sidebar, an app shown: Margin's, the keys staying");
        assert_eq!(way(p(120.0, 400.0), false), PressWay::Routed, "the sidebar, a field's keys: as before");
        assert_eq!(way(p(1000.0, 500.0), true), PressWay::Through, "the page area: the app's");
        assert_eq!(way(p(1000.0, 500.0), false), PressWay::Through, "...whatever the keys");
        assert_eq!(way(p(700.0, 150.0), true), PressWay::Ui, "the palette over the page area (a hit): Margin's");
        assert_eq!(way(p(250.0, 9.0), true), PressWay::Ui, "outside the page card's rounded corner: the theme's frame");
        assert_eq!(way(p(1508.0, 500.0), true), PressWay::Ui, "the frame beside the page area");
        assert_eq!(way(p(-1.0, 400.0), true), PressWay::Outside, "left of the window");
        assert_eq!(way(p(1512.0, 400.0), true), PressWay::Outside, "its right edge is out (CGRect's)");
        assert_eq!(
            press_way(p(120.0, 400.0), CONTENT, None, None, true, true),
            PressWay::Ui,
            "no slot: Margin's everywhere"
        );
        // Windowed: the window's own buttons under the theme's controls are the base window's, the press goes through.
        let controls = Some(Rect::new(10.0, 10.0, 60.0, 16.0));
        assert_eq!(
            press_way(p(20.0, 18.0), CONTENT, slot, controls, false, true),
            PressWay::Through,
            "windowed: its buttons"
        );
        assert_eq!(press_way(p(20.0, 18.0), CONTENT, slot, controls, true, true), PressWay::Ui, "full screen: none");
        // A content not at the origin: the controls are the content's.
        let moved = Rect::new(100.0, 50.0, 1512.0, 982.0);
        assert_eq!(press_way(p(120.0, 68.0), moved, None, controls, false, true), PressWay::Through);
        assert_eq!(press_way(p(20.0, 18.0), moved, None, controls, false, true), PressWay::Outside);
    }

    // A page hosting in full screen, its page area measured.
    fn hosting() -> Page {
        let mut page = Page::new(0.12, "");
        page.set_full_screen(true);
        let layout = br#"{"insets":{"left":248,"top":8,"right":8,"bottom":8},"radius":10,"radii":[10,10,10,10],"container":{"width":1512,"height":982},"mode":"fullscreen","pageHosted":true}"#;
        assert!(page.set_layout_bytes(layout).taken);
        assert_eq!(page.set_hosting(true), Some(false));
        let _ = page.update_page(CONTENT, Some(CONTENT));
        page
    }

    #[test]
    fn the_page_keeps_the_fields_word_and_says_when_its_presses_keep_the_keys() {
        let mut page = hosting();
        assert!(!page.presses_keep_keys(), "hosting, nothing shown yet");
        assert_eq!(page.press_way(p(120.0, 400.0), CONTENT), PressWay::Routed);
        page.set_hosted(Some(42));
        assert!(matches!(page.settle(1.0), super::super::Settled::Applied(super::super::Applied { shown: true, .. })));
        page.place_hole(CONTENT);
        assert!(page.presses_keep_keys(), "an app shown, no field: the keys stay");
        assert_eq!(page.press_way(p(120.0, 400.0), CONTENT), PressWay::Ui);
        assert_eq!(page.press_way(p(1000.0, 500.0), CONTENT), PressWay::Through, "the hole: the app's");
        assert!(!page.set_field_keys(true), "none wanted them before");
        assert!(page.field_keys());
        assert!(!page.presses_keep_keys(), "a field of Margin's wants the keys");
        assert_eq!(page.press_way(p(120.0, 400.0), CONTENT), PressWay::Routed);
        assert!(page.set_field_keys(false), "one wanted them before");
        assert!(page.presses_keep_keys());
        // The page's `focus` op is the field's word, kept as it's read.
        let c = Rect::new(0.0, 0.0, 1512.0, 982.0);
        assert_eq!(page.said("focus", br#"{"on":true}"#, c), super::super::said::Said::Focus { on: true, was: false });
        assert!(page.field_keys() && !page.presses_keep_keys());
        assert_eq!(page.said("focus", br#"{"on":true}"#, c), super::super::said::Said::Focus { on: true, was: true });
        assert_eq!(page.said("focus", br#"{}"#, c), super::super::said::Said::Focus { on: false, was: true });
        assert!(!page.field_keys() && page.presses_keep_keys());
        // Not hosting any more: as before (what it hosted forgotten).
        assert_eq!(page.set_hosting(false), Some(false));
        assert!(!page.presses_keep_keys());
    }
}

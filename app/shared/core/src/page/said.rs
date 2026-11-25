//! What Margin's window's page says (docs/CORE-REFACTOR.md step 3, part 10; MarginWindowController.swift `pageSaid`):
//! each op read and routed, the Page's own (its layout report, the theme's hits, the pointer's wants) kept here, the
//! rest answered for the window's mechanism (its card's rect, its window controls and drag regions, the keys, its
//! sidebar's counts, the full screen, the sidebar's or a divider's drag, the haptic tick, a cut pane's slide, a request
//! of its source, a log line). The body is the op's JSON as the page sent it (Margin.app's window's page, its hello's
//! `saidText`: `JSON.stringify`'s text), or the Mac's dictionary made JSON (a test's, an older page): read as the
//! Swift read WebKit's objects (a number is never a bool, a list's cast all or nothing).

use serde_json::Value;

use super::{LayoutSaid, Page};
use crate::geometry::Rect;
use crate::json::{self, Object};
use crate::passthrough::{PointerWant, WantMode};

/// An op's route.
#[derive(Clone, Debug, PartialEq)]
pub enum Said {
    /// Nothing to do (not an op, or one that isn't whole).
    None,
    /// Its page drawn.
    Ready,
    /// Its layout report, kept (`set_layout_bytes`).
    Layout(LayoutSaid),
    /// Where the theme draws the preview card's page, in the window (rounded to whole points); None: none.
    PeekRect(Option<Rect>),
    /// What the theme draws over the page area that takes the pointer, kept (`set_hits`; the rects in `rects`).
    Hits { all: bool },
    /// The theme's window controls (None: none) and its drag regions (in `rects`).
    Chrome { controls: Option<Rect> },
    /// A field of Margin's wants the keys, or let go (`on`), kept (`Page::set_field_keys`); `was`: whether one
    /// wanted them before.
    Focus { on: bool, was: bool },
    /// Its sidebar's spaces and numbered rows.
    Counts { spaces: i64, items: i64 },
    /// The positions the page wants, kept (the pointer's).
    Want,
    /// The window's own full screen toggled (`window.fullscreen`).
    FullScreen,
    /// The sidebar's edge (or a split's divider) dragged, or let go.
    Resizing { on: bool, divider: bool },
    /// The trackpad's tick: its alignment (a detent, a step), or a level's change (`level`: Edit Theme Color's texture,
    /// M2.9 step 6).
    Haptic { level: bool },
    /// A cut pane's arrow: its item, the side (0 left, 1 right, 2 up, 3 down).
    Slide { item: String, side: u8 },
    /// A request of the window's source: its name and argument (an object).
    Ask { name: String, arg: Object },
    /// A line for the app's log (`warn`: the page's warning or error).
    Log { warn: bool, text: String },
}

/// A number as the Swift's `num` read one (an NSNumber that isn't a bool).
fn num(v: &Value) -> Option<f64> {
    json::num(Some(v))
}

/// `MarginWindowController.rect`: a list's numbers (anything else in it left out) when there are four, finite, with
/// sizes not below zero.
pub fn rect(v: &Value) -> Option<Rect> {
    let n: Vec<f64> = v.as_array()?.iter().filter_map(num).collect();
    (n.len() == 4 && n.iter().all(|x| x.is_finite()) && n[2] >= 0.0 && n[3] >= 0.0).then(|| Rect {
        x: n[0],
        y: n[1],
        width: n[2],
        height: n[3],
    })
}

/// A list of rects as Swift's `as? [[Any]]` cast it (every element a list, or none at all), each one `rect`'s.
fn rects(v: Option<&Value>, out: &mut Vec<Rect>) {
    out.clear();
    let Some(list) = v.and_then(Value::as_array) else { return };
    if !list.iter().all(Value::is_array) {
        return;
    }
    out.extend(list.iter().filter_map(rect));
}

/// A whole number as Swift's `as? Int` bridged WebKit's and JSONSerialization's NSNumber: a bool is 0 or 1, a number
/// exactly an Int's.
fn swift_int(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    if let Some(b) = v.as_bool() {
        return Some(i64::from(b));
    }
    if let Some(i) = v.as_i64() {
        return Some(i);
    }
    let f = v.as_f64()?;
    (f.fract() == 0.0 && (-(2f64.powi(63))..2f64.powi(63)).contains(&f)).then_some(f as i64)
}

/// The positions the page wants (`PointerWant(body)` as the Mac read it): its mode (`all` when it isn't one), its
/// edges, its zone (a bool a number, 1 or 0, as an NSNumber's `doubleValue`; else 24).
pub fn pointer_want(body: &Object) -> PointerWant {
    let mode = json::string(body.get("mode")).and_then(WantMode::parse).unwrap_or(WantMode::All);
    let edges = json::array(body.get("edges"))
        .map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    let zone = match body.get("zone") {
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        other => other.and_then(Value::as_f64).unwrap_or(PointerWant::DEFAULT_ZONE),
    };
    PointerWant { mode, edges, zone }
}

impl Page {
    /// An op the page said, its body's JSON (`content`: the window's content rect, for the card's rect in the
    /// window). The rects a route has (the hits, the drag regions) are in `said_rects` after it.
    pub fn said(&mut self, op: &str, body: &[u8], content: Rect) -> Said {
        if op == "layout" {
            return Said::Layout(self.set_layout_bytes(body));
        }
        let body = match serde_json::from_slice::<Value>(body) {
            Ok(Value::Object(o)) => o,
            _ => Object::new(),
        };
        let flag = |v: Option<&Value>| json::flag(v) == Some(true);
        match op {
            "ready" => Said::Ready,
            "peekRect" => {
                Said::PeekRect(body.get("rect").and_then(rect).filter(|r| r.width >= 1.0 && r.height >= 1.0).map(|r| {
                    let (cx, cy) =
                        (content.x.min(content.x + content.width), content.y.min(content.y + content.height));
                    Rect {
                        x: (cx + r.x).round(),
                        y: (cy + r.y).round(),
                        width: r.width.round(),
                        height: r.height.round(),
                    }
                }))
            }
            "hits" => {
                let mut list = std::mem::take(&mut self.said_rects);
                rects(body.get("rects"), &mut list);
                let all = flag(body.get("all")) || list.len() > 64;
                list.truncate(64);
                self.set_hits(&list, all);
                self.said_rects = list;
                Said::Hits { all }
            }
            "chrome" => {
                let controls = body.get("controls").and_then(rect);
                let mut list = std::mem::take(&mut self.said_rects);
                rects(body.get("drags"), &mut list);
                self.said_rects = list;
                Said::Chrome { controls }
            }
            "focus" => {
                let on = flag(body.get("on"));
                Said::Focus { on, was: self.set_field_keys(on) }
            }
            "counts" => match (swift_int(body.get("spaces")), swift_int(body.get("items"))) {
                (Some(spaces), Some(items)) if spaces >= 0 && items >= 0 => Said::Counts { spaces, items },
                _ => Said::None,
            },
            "pointerWant" => {
                self.pointer.set_want(pointer_want(&body).want());
                Said::Want
            }
            "perform" => {
                let name = json::string(body.get("name")).unwrap_or("");
                let arg = json::object(body.get("arg"));
                match name {
                    "window.fullscreen" => Said::FullScreen,
                    "sidebar.resizing" | "split.resizing" => {
                        Said::Resizing { on: flag(arg.and_then(|a| a.get("on"))), divider: name == "split.resizing" }
                    }
                    "haptic.alignment" => Said::Haptic { level: false },
                    "haptic.level" => Said::Haptic { level: true },
                    "split.slide" => {
                        let item = arg.and_then(|a| json::string(a.get("item")));
                        let side = arg.and_then(|a| json::string(a.get("side"))).and_then(|s| match s {
                            "left" => Some(0),
                            "right" => Some(1),
                            "up" => Some(2),
                            "down" => Some(3),
                            _ => None,
                        });
                        match (item, side) {
                            (Some(item), Some(side)) => Said::Slide { item: item.to_string(), side },
                            _ => Said::None,
                        }
                    }
                    "" => Said::None,
                    _ => Said::Ask { name: name.to_string(), arg: arg.cloned().unwrap_or_default() },
                }
            }
            "log" => {
                let level = json::string(body.get("level")).unwrap_or("");
                let text = json::string(body.get("text")).unwrap_or("").to_string();
                Said::Log { warn: level == "error" || level == "warn", text }
            }
            _ => Said::None,
        }
    }

    /// The rects the last `said` read (the hits kept, or the drag regions).
    pub fn said_rects(&self) -> &[Rect] {
        &self.said_rects
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn said(p: &mut Page, op: &str, v: Value) -> Said {
        p.said(op, v.to_string().as_bytes(), Rect { x: 100.0, y: 50.0, width: 800.0, height: 600.0 })
    }

    #[test]
    fn each_op_read_as_the_swift_read_it() {
        let mut p = Page::default();
        assert_eq!(said(&mut p, "ready", json!({})), Said::Ready);
        assert_eq!(
            said(&mut p, "peekRect", json!({ "rect": [10.4, 20.5, 300.5, 200], "radius": 8 })),
            Said::PeekRect(Some(Rect { x: 110.0, y: 71.0, width: 301.0, height: 200.0 }))
        );
        assert_eq!(said(&mut p, "peekRect", json!({ "rect": [1, 2, 0.5, 9] })), Said::PeekRect(None));
        assert_eq!(said(&mut p, "peekRect", json!({ "rect": null })), Said::PeekRect(None));
        assert_eq!(
            said(&mut p, "peekRect", json!({ "rect": [1, "x", 2, true, 3, 4] })),
            Said::PeekRect(Some(Rect { x: 101.0, y: 52.0, width: 3.0, height: 4.0 })),
            "anything but numbers left out of a rect's list"
        );
        let many: Vec<Value> = (0..70).map(|i| json!([i, 0, 1, 1])).collect();
        assert_eq!(said(&mut p, "hits", json!({ "rects": many })), Said::Hits { all: true });
        assert_eq!(p.said_rects().len(), 64);
        assert_eq!(said(&mut p, "hits", json!({ "rects": [[0, 0, 1, 1], "x"], "all": 1 })), Said::Hits { all: true });
        assert!(p.said_rects().is_empty(), "a list with one that isn't a list: none (Swift's cast)");
        assert_eq!(said(&mut p, "hits", json!({ "rects": [[0, 0, 1, 1], [0, 0, -1, 1]] })), Said::Hits { all: false });
        assert_eq!(p.said_rects().len(), 1);
        assert_eq!(
            said(&mut p, "chrome", json!({ "controls": [1, 2, 3, 4], "drags": [[0, 0, 5, 5], [1, 1, 1, 1]] })),
            Said::Chrome { controls: Some(Rect { x: 1.0, y: 2.0, width: 3.0, height: 4.0 }) }
        );
        assert_eq!(p.said_rects().len(), 2);
        assert_eq!(said(&mut p, "focus", json!({ "on": 1 })), Said::Focus { on: true, was: false });
        assert_eq!(said(&mut p, "focus", json!({})), Said::Focus { on: false, was: true });
        assert_eq!(said(&mut p, "counts", json!({ "spaces": 2, "items": 3.0 })), Said::Counts { spaces: 2, items: 3 });
        assert_eq!(said(&mut p, "counts", json!({ "spaces": 2, "items": 3.5 })), Said::None);
        assert_eq!(said(&mut p, "counts", json!({ "spaces": -1, "items": 3 })), Said::None);
        assert_eq!(
            said(&mut p, "pointerWant", json!({ "mode": "edges", "edges": ["left", 3], "zone": true })),
            Said::Want
        );
        let w = pointer_want(
            json!({ "mode": "edges", "edges": ["left"], "zone": true }).as_object().unwrap_or(&Object::new()),
        );
        assert_eq!((w.mode, w.zone), (WantMode::Edges, 1.0), "a boolean zone is 1 on the Mac");
        assert_eq!(pointer_want(&Object::new()).zone, 24.0);
        assert_eq!(said(&mut p, "perform", json!({ "name": "window.fullscreen" })), Said::FullScreen);
        assert_eq!(said(&mut p, "perform", json!({ "name": "haptic.alignment" })), Said::Haptic { level: false });
        assert_eq!(said(&mut p, "perform", json!({ "name": "haptic.level", "arg": 1 })), Said::Haptic { level: true });
        assert_eq!(
            said(&mut p, "perform", json!({ "name": "split.resizing", "arg": { "on": true } })),
            Said::Resizing { on: true, divider: true }
        );
        assert_eq!(
            said(&mut p, "perform", json!({ "name": "sidebar.resizing" })),
            Said::Resizing { on: false, divider: false }
        );
        assert_eq!(
            said(&mut p, "perform", json!({ "name": "split.slide", "arg": { "item": "a", "side": "up" } })),
            Said::Slide { item: "a".into(), side: 2 }
        );
        assert_eq!(
            said(&mut p, "perform", json!({ "name": "split.slide", "arg": { "item": "a", "side": "in" } })),
            Said::None
        );
        assert_eq!(said(&mut p, "perform", json!({ "name": "" })), Said::None);
        assert_eq!(
            said(&mut p, "perform", json!({ "name": "pinTab", "arg": [1] })),
            Said::Ask { name: "pinTab".into(), arg: Object::new() }
        );
        assert_eq!(
            said(&mut p, "log", json!({ "level": "warn", "text": "x" })),
            Said::Log { warn: true, text: "x".into() }
        );
        assert_eq!(said(&mut p, "log", json!({ "level": 1 })), Said::Log { warn: false, text: String::new() });
        assert_eq!(said(&mut p, "shownSpace", json!({})), Said::None);
        assert_eq!(p.said("hits", b"not json", Rect::default()), Said::Hits { all: false });
    }
}

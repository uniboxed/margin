//! Why something changed (docs/ARCHITECTURE-PLAN.md, "Cause tracking"): before Margin reacts to a change nobody asked
//! for, it works out what caused it from what it saw just before. A short memory of events (a window opened or closed
//! and its kind, Margin's own writes, the person's actions), each kept `KEEP` seconds; a change is explained by the
//! newest event that can cause it within `CAUSE_WITHIN`.
//!
//! The case that needs it (2026-11-18 13:30): macOS lays the first two tiles of Margin's Space out again after any
//! tile's window comes or goes. When the window that went is a helper (its app's answer to a resize), the cause is
//! that app: its reaction is counted against it (the loop guard), not against Margin's window.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use super::kinds::WindowKind;

/// How long an event is remembered.
pub const KEEP: f64 = 2.0;
/// How long after an event a change can still be its doing (macOS's re-layout came 15-30 ms after a close).
pub const CAUSE_WITHIN: f64 = 0.4;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    /// A window of a hosted app came (`kind` as classified then).
    Opened { host: String, window: i64, kind: WindowKind },
    /// ...or went.
    Closed { host: String, window: i64, kind: WindowKind },
    /// Margin set a window's or a tile's size (its own write).
    Sized { host: String },
    /// The person did something (a switch, a drag, a theme, a display change).
    Person,
}

/// What a change was caused by.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cause {
    /// The host it's counted against ("margin" when nothing explains it).
    pub host: String,
    /// The event's kind, when a window's coming or going explains it.
    pub kind: Option<WindowKind>,
    pub person: bool,
    pub text: String,
}

/// The changes that need explaining.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Change {
    /// The tiles of Margin's Space laid out again (Margin's own window a split's part).
    TilesRelaidOut,
    /// A hosted window not where Margin put it.
    WindowMoved,
}

#[derive(Debug, Default)]
pub struct Causes {
    events: VecDeque<(f64, Event)>,
}

impl Causes {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn note(&mut self, now: f64, e: Event) {
        while self.events.front().is_some_and(|(t, _)| now - t > KEEP) {
            self.events.pop_front();
        }
        self.events.push_back((now, e));
    }

    /// The newest event within `CAUSE_WITHIN` that explains `change`.
    pub fn explain(&self, now: f64, change: Change) -> Cause {
        for (t, e) in self.events.iter().rev() {
            if now - t > CAUSE_WITHIN {
                break;
            }
            match (change, e) {
                (_, Event::Person) => {
                    return Cause {
                        host: "margin".into(),
                        kind: None,
                        person: true,
                        text: "the person's own action".into(),
                    };
                }
                (
                    Change::TilesRelaidOut,
                    Event::Opened { host, window, kind } | Event::Closed { host, window, kind },
                ) => {
                    let went = if matches!(e, Event::Opened { .. }) { "came" } else { "went" };
                    return Cause {
                        host: host.clone(),
                        kind: Some(*kind),
                        person: false,
                        text: format!(
                            "{host}'s window {window} ({}) {went} {} ms before",
                            kind.name(),
                            ((now - t) * 1000.0).round() as i64
                        ),
                    };
                }
                (Change::WindowMoved, Event::Sized { host }) => {
                    return Cause {
                        host: host.clone(),
                        kind: None,
                        person: false,
                        text: format!("Margin sized {host} {} ms before", ((now - t) * 1000.0).round() as i64),
                    };
                }
                _ => {}
            }
        }
        Cause { host: "margin".into(), kind: None, person: false, text: "nothing seen just before explains it".into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_helpers_close_explains_the_relayout() {
        let mut c = Causes::new();
        c.note(10.0, Event::Sized { host: "app:com.apple.weather".into() });
        c.note(10.25, Event::Opened { host: "app:com.apple.weather".into(), window: 91222, kind: WindowKind::Helper });
        c.note(10.45, Event::Closed { host: "app:com.apple.weather".into(), window: 91222, kind: WindowKind::Helper });
        let cause = c.explain(10.47, Change::TilesRelaidOut);
        assert_eq!(cause.host, "app:com.apple.weather");
        assert_eq!(cause.kind, Some(WindowKind::Helper));
        assert_eq!(cause.text, "app:com.apple.weather's window 91222 (helper) went 20 ms before");
    }

    #[test]
    fn nothing_recent_is_margins_own() {
        let mut c = Causes::new();
        c.note(10.0, Event::Closed { host: "h".into(), window: 1, kind: WindowKind::Main });
        let cause = c.explain(11.0, Change::TilesRelaidOut);
        assert_eq!(cause.host, "margin");
        assert!(!cause.person);
        // The person's action just before: theirs.
        c.note(20.0, Event::Person);
        assert!(c.explain(20.1, Change::TilesRelaidOut).person);
    }

    #[test]
    fn events_age_out() {
        let mut c = Causes::new();
        for i in 0..100 {
            c.note(i as f64, Event::Person);
        }
        assert!(c.events.len() <= 3, "{}", c.events.len());
    }
}

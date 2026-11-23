//! Margin's window in front of what it hosts (MarginWindowController's `keepFront` and `frontRead`, docs/CORE-REFACTOR.md
//! step 3 part 11): how it's kept there (a raised level, or ordered right above the hosted window), what it lets in
//! front (another app's window in its Space), and the poll's read at rest of what the window server holds: put right at
//! once when the hosted window is above it; a raised level the window server doesn't hold on two reads at rest at least
//! `MISS_APART` apart falls back to the order; the order, fallen back to, tries the level again every `PROBE_EVERY`.
//!
//! The decisions only: the window's level and order are the OS's (the Mac's `setLevel`, `orderAbove`), carried out from
//! the answers in their order; the window levels are the OS's numbers (`raised`, `normal`), given at the start; the
//! clock is the caller's, read where the Swift read it (each change's time is the clock's at that change).

/// How it's kept in front (`FrontMechanism`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mechanism {
    /// A window level one above normal, which the window server holds whatever app is active or clicked.
    #[default]
    Level,
    /// At the normal level, ordered right above the hosted window whenever something could have raised that window.
    Order,
}

/// A read is at rest this long after Margin's own change of level or order and after a Space change.
pub const SETTLE: f64 = 0.5;
/// Two misses of the raised level at least this far apart: the order instead.
pub const MISS_APART: f64 = 1.0;
/// Fallen back to the order: the level tried again this often.
pub const PROBE_EVERY: f64 = 5.0;

/// What `keep_front` asks of the window, in this order: its level set (`Some(true)` raised, `Some(false)` normal),
/// ordered right above a window, ordered right below another app's window let in front.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KeepFront {
    pub level: Option<bool>,
    pub above: Option<i64>,
    pub below: Option<i64>,
}

/// One step of what a read at rest asks, carried out in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrontOp {
    /// Its level set: raised (true) or normal.
    Level(bool),
    /// Ordered right above this window.
    Above(i64),
    /// Said once: the hosted window above it in the window server's order (kept in front by this mechanism then).
    Wrong(Mechanism),
    /// Said once: in front by its level, held.
    Held,
    /// Said: the raised level not held at reads this many ms apart, at rest: by its order instead.
    FellBack(i64),
    /// Said: the raised level held again: by its level again.
    Back,
}

/// The read's steps, at most eight.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrontOps {
    pub ops: [Option<FrontOp>; 8],
    pub len: usize,
}

impl FrontOps {
    fn push(&mut self, op: FrontOp) {
        if self.len < self.ops.len() {
            self.ops[self.len] = Some(op);
            self.len += 1;
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = FrontOp> + '_ {
        self.ops[..self.len].iter().flatten().copied()
    }
}

/// What was done, counted (the tests read them).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct FrontCounts {
    pub level_sets: u64,
    pub front_orders: u64,
    pub yield_orders: u64,
    /// The poll found the hosted window above it: put right at once.
    pub front_restores: u64,
    /// Kept in front by its order, the raised level tried again...
    pub level_probes: u64,
    /// ...and held: back to the raised level.
    pub level_backs: u64,
}

/// The front watch of one Margin window.
#[derive(Clone, Debug)]
pub struct Front {
    pub mechanism: Mechanism,
    /// The one asked for (`MarginFront`): the order asked for is kept.
    pub asked: Mechanism,
    /// The window levels, the OS's numbers.
    pub raised: i64,
    pub normal: i64,
    /// Another app's window it lets in front (a hosted app's Settings), and a window of the engine's not shown yet.
    pub yielding: Option<i64>,
    pub covering: Option<i64>,
    pub counts: FrontCounts,
    changed_at: f64,
    space_changed_at: f64,
    miss_at: Option<f64>,
    probing: bool,
    probed_at: f64,
    reorder: bool,
    level_said: bool,
    wrong_said: bool,
}

impl Default for Front {
    fn default() -> Self {
        Front {
            mechanism: Mechanism::Level,
            asked: Mechanism::Level,
            raised: 1,
            normal: 0,
            yielding: None,
            covering: None,
            counts: FrontCounts::default(),
            changed_at: f64::NEG_INFINITY,
            space_changed_at: f64::NEG_INFINITY,
            miss_at: None,
            probing: false,
            probed_at: f64::NEG_INFINITY,
            reorder: false,
            level_said: false,
            wrong_said: false,
        }
    }
}

impl Front {
    /// Started with the mechanism asked for and the OS's two levels.
    pub fn new(asked: Mechanism, raised: i64, normal: i64) -> Front {
        Front { mechanism: asked, asked, raised, normal, ..Front::default() }
    }

    /// Another app's window let in front (`yield`), None: none any more (ordered above the hosted window again with its
    /// level). False: the same as before, nothing to do.
    pub fn set_yielding(&mut self, number: Option<i64>) -> bool {
        if number == self.yielding {
            return false;
        }
        self.yielding = number;
        if number.is_none() {
            self.reorder = true;
        }
        true
    }

    /// A window of the engine's not shown yet (`cover`). False: the same as before.
    pub fn set_covering(&mut self, number: Option<i64>) -> bool {
        if number == self.covering {
            return false;
        }
        self.covering = number;
        true
    }

    /// The current Space changed (its time).
    pub fn space_changed(&mut self, now: f64) {
        self.space_changed_at = now;
    }

    /// `keepFront`, once the caller has checked its window is open and on the current Space: in full screen and not
    /// yielding, its level raised (the level's way, or probing) or normal, ordered right above `target` (the frontmost
    /// visible host, else the hosted window, else the window it covers) by the order's way or after a yield; yielding,
    /// ordered right below the window let in front. `level` the window's level now; `now` read at each change.
    pub fn keep(
        &mut self,
        full_screen: bool,
        level: i64,
        target: Option<i64>,
        now: &mut dyn FnMut() -> f64,
    ) -> KeepFront {
        let mut out = KeepFront::default();
        let up = full_screen && self.yielding.is_none();
        let raised = up && (self.mechanism == Mechanism::Level || self.probing);
        let want = if raised { self.raised } else { self.normal };
        if level != want {
            out.level = Some(raised);
            self.counts.level_sets += 1;
            self.changed_at = now();
        }
        if up && (self.mechanism == Mechanism::Order || self.reorder) {
            if let Some(t) = target.or(self.covering) {
                out.above = Some(t);
                self.counts.front_orders += 1;
                self.changed_at = now();
            }
        }
        if up {
            self.reorder = false;
        }
        if let Some(other) = self.yielding {
            out.below = Some(other);
            self.counts.yield_orders += 1;
            self.changed_at = now();
        }
        out
    }

    /// Whether the poll's read is this window's to look at (`frontRead`'s guard but the caller's own: open, on the
    /// current Space): in full screen, nothing let in front, the read of its hosted window or a visible host's.
    pub fn reads(&self, full_screen: bool, ours: bool) -> bool {
        full_screen && self.yielding.is_none() && ours
    }

    /// `frontRead`: the read at rest of this window's layer (`layer`) and whether it's above the hosted window
    /// (`above`), its window level now `level`, the hosted window `hosted`; `now` read once. The steps to carry out.
    pub fn read(&mut self, hosted: i64, layer: i64, above: bool, level: i64, now: &mut dyn FnMut() -> f64) -> FrontOps {
        let mut ops = FrontOps::default();
        let t = now();
        let at_rest = t - self.changed_at >= SETTLE - 1e-9 && t - self.space_changed_at >= SETTLE - 1e-9;
        if !above {
            if !self.wrong_said {
                self.wrong_said = true;
                ops.push(FrontOp::Wrong(self.mechanism));
            }
            self.counts.front_restores += 1;
            if level == self.raised {
                ops.push(FrontOp::Level(false));
                ops.push(FrontOp::Level(true));
                self.counts.level_sets += 1;
            }
            ops.push(FrontOp::Above(hosted));
            self.counts.front_orders += 1;
            self.changed_at = t;
        } else if at_rest {
            self.wrong_said = false;
        }
        if !at_rest {
            return ops;
        }
        let held = layer == self.raised;
        match self.mechanism {
            Mechanism::Level => {
                if held {
                    self.miss_at = None;
                    if !self.level_said {
                        self.level_said = true;
                        ops.push(FrontOp::Held);
                    }
                } else if let Some(first) = self.miss_at.filter(|first| t - first >= MISS_APART - 1e-9) {
                    self.miss_at = None;
                    self.mechanism = Mechanism::Order;
                    ops.push(FrontOp::Level(false));
                    self.counts.level_sets += 1;
                    ops.push(FrontOp::Above(hosted));
                    self.counts.front_orders += 1;
                    self.changed_at = t;
                    self.probed_at = t;
                    // (Swift's `Int(ms)`: toward zero.)
                    ops.push(FrontOp::FellBack(((t - first) * 1000.0) as i64));
                } else {
                    if self.miss_at.is_none() {
                        self.miss_at = Some(t);
                    }
                    // (Set again, as it may have been lost: the next read at rest says.)
                    ops.push(FrontOp::Level(false));
                    ops.push(FrontOp::Level(true));
                    self.counts.level_sets += 1;
                    self.changed_at = t;
                }
            }
            Mechanism::Order => {
                if self.asked == Mechanism::Order {
                    return ops; // (asked for: kept)
                }
                if self.probing {
                    self.probing = false;
                    self.probed_at = t;
                    if held {
                        self.mechanism = Mechanism::Level;
                        self.counts.level_backs += 1;
                        self.level_said = true;
                        ops.push(FrontOp::Back);
                    } else {
                        ops.push(FrontOp::Level(false));
                        self.counts.level_sets += 1;
                        ops.push(FrontOp::Above(hosted));
                        self.counts.front_orders += 1;
                        self.changed_at = t;
                    }
                } else if t - self.probed_at >= PROBE_EVERY - 1e-9 {
                    self.probing = true;
                    self.counts.level_probes += 1;
                    ops.push(FrontOp::Level(true));
                    self.counts.level_sets += 1;
                    self.changed_at = t;
                }
            }
        }
        ops
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_in_front_and_read_at_rest() {
        let mut f = Front::new(Mechanism::Level, 1, 0);
        let mut t = 10.0;
        let k = f.keep(true, 0, Some(7), &mut || t);
        assert_eq!(k, KeepFront { level: Some(true), above: None, below: None }, "the level's way: raised, no order");
        assert!(f.set_yielding(Some(9)));
        let k = f.keep(true, 1, Some(7), &mut || t);
        assert_eq!(k, KeepFront { level: Some(false), above: None, below: Some(9) }, "yielding: normal, below it");
        assert!(f.set_yielding(None));
        let k = f.keep(true, 0, Some(7), &mut || t);
        assert_eq!(
            k,
            KeepFront { level: Some(true), above: Some(7), below: None },
            "a yield over: raised and above it"
        );
        assert_eq!(f.counts.level_sets, 3);
        // Read right after a change: nothing concluded.
        t += 0.1;
        let ops = f.read(7, 0, true, 1, &mut || t);
        assert_eq!((ops.len, f.mechanism), (0, Mechanism::Level));
        t += 1.0;
        assert_eq!(
            f.read(7, 0, true, 1, &mut || t).iter().collect::<Vec<_>>(),
            vec![FrontOp::Level(false), FrontOp::Level(true)],
            "a first miss: set again"
        );
        t += 0.6;
        assert_eq!(f.read(7, 0, true, 1, &mut || t).len, 2, "0.6 s after the first miss: set again, not yet the order");
        assert_eq!(f.mechanism, Mechanism::Level);
        t += 0.6;
        let ops: Vec<_> = f.read(7, 0, true, 1, &mut || t).iter().collect();
        assert_eq!(
            ops,
            vec![FrontOp::Level(false), FrontOp::Above(7), FrontOp::FellBack(1199)],
            "two misses 1.2 s apart (1199.99… ms: toward zero): the order"
        );
        assert_eq!(f.mechanism, Mechanism::Order);
        t += 5.0;
        assert_eq!(f.read(7, 0, true, 0, &mut || t).iter().collect::<Vec<_>>(), vec![FrontOp::Level(true)], "probed");
        t += 0.6;
        assert_eq!(
            f.read(7, 1, true, 1, &mut || t).iter().collect::<Vec<_>>(),
            vec![FrontOp::Back],
            "held: by its level again"
        );
        assert_eq!((f.mechanism, f.counts.level_probes, f.counts.level_backs), (Mechanism::Level, 1, 1));
        // The hosted window above it: put right, said once.
        t += 1.0;
        let ops: Vec<_> = f.read(7, 1, false, 1, &mut || t).iter().collect();
        assert_eq!(
            ops,
            vec![FrontOp::Wrong(Mechanism::Level), FrontOp::Level(false), FrontOp::Level(true), FrontOp::Above(7)]
        );
        let ops: Vec<_> = f.read(7, 1, false, 0, &mut || t).iter().collect();
        assert_eq!(ops, vec![FrontOp::Above(7)], "said once until all is well");
        assert_eq!(f.counts.front_restores, 2);
    }
}

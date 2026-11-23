//! An app's exit and its pid used again: whether a running app is still the launch Margin knew (marked, kept active,
//! asked to quit). A pid is used again by another launch; the launch time tells them apart. And the apps a row's close
//! asked to quit (docs/CORE-REFACTOR.md step 2 part 7): their exits heard, overdue, taken back, waited for.

use std::collections::BTreeMap;

/// Two launch times this close (seconds) are the same launch: the reads of one launch's time differ by a little.
pub const SAME_LAUNCH_WITHIN: f64 = 2.0;

/// Whether a running app (its launch time now) is the launch known then. Either time unknown: taken for the same
/// (nothing tells them apart). A caller that needs a known time first asks for it itself.
pub fn same_launch(then: Option<f64>, now: Option<f64>) -> bool {
    match (then, now) {
        (Some(then), Some(now)) => (then - now).abs() < SAME_LAUNCH_WITHIN,
        _ => true,
    }
}

/// The crash recovery's own rule for an app the marker kept (its bundle the same): marked with its launch time and
/// the running one's unread, it isn't taken for the same, unlike `same_launch` (a pid used again is the likelier).
pub fn same_marked_launch(then: Option<f64>, now: Option<f64>) -> bool {
    (then.is_none() || now.is_some()) && same_launch(then, now)
}

/// An app a row's close asked to quit (an app Margin started): its launch (pid, bundle, launch time), the host's id,
/// when it was asked.
#[derive(Clone, Debug, PartialEq)]
pub struct Exiting {
    pub pid: i64,
    pub bundle: String,
    pub launched_at: Option<f64>,
    pub id: String,
    pub asked_at: f64,
}

/// What `take_back` found.
#[derive(Clone, Debug, PartialEq)]
pub enum TakeBack {
    /// None asked for that pid.
    None,
    /// Gone unheard (no app runs as it, or another launch): forgotten as heard.
    Exited(Exiting),
    /// Still that launch running: it didn't quit, Margin's again.
    Back(Exiting),
}

/// Every app a row's close asked to quit, by pid (in pid order). Nothing allocated but an ask (its bundle and id kept).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Exits(BTreeMap<i64, Exiting>);

impl Exits {
    /// Asked to quit now (one asked again: the newer ask).
    pub fn asked(&mut self, e: Exiting) {
        self.0.insert(e.pid, e);
    }

    /// Its exit heard: forgotten (None: none asked for that pid).
    pub fn exited(&mut self, pid: i64) -> Option<Exiting> {
        self.0.remove(&pid)
    }

    /// `quit_wait` after its ask (`overdue`): the app running as that pid now (its bundle and launch time; None: none)
    /// still the launch asked (its bundle and launch time the same) is Margin's again; anything else is its exit
    /// unheard.
    pub fn take_back(&mut self, pid: i64, now: Option<(&str, Option<f64>)>) -> TakeBack {
        let Some(e) = self.0.get(&pid) else { return TakeBack::None };
        let same = now.is_some_and(|(bundle, launched)| bundle == e.bundle && launched == e.launched_at);
        match self.0.remove(&pid) {
            Some(e) if same => TakeBack::Back(e),
            Some(e) => TakeBack::Exited(e),
            None => TakeBack::None,
        }
    }

    /// The pids asked `quit_wait` or longer ago, in pid order, into `out` (as many as fit); how many there are.
    pub fn overdue(&self, now: f64, quit_wait: f64, out: &mut [i64]) -> usize {
        let mut n = 0;
        for e in self.0.values().filter(|e| now - e.asked_at >= quit_wait) {
            if let Some(slot) = out.get_mut(n) {
                *slot = e.pid;
            }
            n += 1;
        }
        n
    }

    /// The pids of `bundle`'s instances still finishing, in pid order.
    pub fn dying<'a>(&'a self, bundle: &'a str) -> impl Iterator<Item = i64> + 'a {
        self.0.values().filter(move |e| e.bundle == bundle).map(|e| e.pid)
    }

    pub fn get(&self, pid: i64) -> Option<&Exiting> {
        self.0.get(&pid)
    }
    pub fn has(&self, pid: i64) -> bool {
        self.0.contains_key(&pid)
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    /// Every one, in pid order.
    pub fn iter(&self) -> impl Iterator<Item = &Exiting> {
        self.0.values()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_launch_within_two_seconds_the_edge_out() {
        assert!(same_launch(Some(1000.0), Some(1000.0)));
        assert!(same_launch(Some(1000.0), Some(1001.99)) && same_launch(Some(1001.99), Some(1000.0)));
        assert!(!same_launch(Some(1000.0), Some(1002.0)), "2 s apart exactly: another launch");
        assert!(!same_launch(Some(1002.0), Some(1000.0)));
        assert!(!same_launch(Some(1000.0), Some(5000.0)));
        // Unknown on either side: the same.
        assert!(same_launch(None, Some(1000.0)) && same_launch(Some(1000.0), None) && same_launch(None, None));
    }

    #[test]
    fn a_marked_launch_with_its_time_against_one_unread_is_another() {
        assert!(same_marked_launch(Some(1000.0), Some(1001.0)));
        assert!(!same_marked_launch(Some(1000.0), None), "marked with its time, the running one's unread");
        assert!(same_marked_launch(None, Some(1000.0)) && same_marked_launch(None, None), "marked without: the same");
        assert!(!same_marked_launch(Some(1000.0), Some(1002.0)));
    }

    fn asked(pid: i64, bundle: &str, launched_at: Option<f64>, at: f64) -> Exiting {
        Exiting { pid, bundle: bundle.into(), launched_at, id: format!("app:{bundle}"), asked_at: at }
    }

    #[test]
    fn an_exit_heard_overdue_taken_back_or_forgotten() {
        let mut x = Exits::default();
        x.asked(asked(30, "com.apple.Maps", Some(100.0), 10.0));
        x.asked(asked(20, "com.apple.Notes", None, 12.0));
        x.asked(asked(40, "com.apple.Maps", Some(200.0), 14.0));
        assert_eq!((x.len(), x.has(30), x.has(31)), (3, true, false));
        let mut out = [0i64; 2];
        assert_eq!(x.overdue(14.0, 4.0, &mut out), 1, "4 s after its ask exactly: overdue");
        assert_eq!(out[0], 30);
        assert_eq!(x.overdue(30.0, 4.0, &mut out), 3, "all three, two written");
        assert_eq!(out, [20, 30], "in pid order");
        assert_eq!(x.dying("com.apple.Maps").collect::<Vec<_>>(), vec![30, 40]);
        // Still that launch: Margin's again. Another launch, or none: its exit unheard. Either way forgotten.
        assert!(
            matches!(x.take_back(30, Some(("com.apple.Maps", Some(100.0)))), TakeBack::Back(e) if e.id == "app:com.apple.Maps")
        );
        assert!(
            matches!(x.take_back(40, Some(("com.apple.Maps", Some(201.0)))), TakeBack::Exited(_)),
            "a second off: another"
        );
        assert!(matches!(x.take_back(20, Some(("com.apple.Notes", None))), TakeBack::Back(_)), "both unread: the same");
        assert_eq!(x.take_back(20, None), TakeBack::None);
        x.asked(asked(50, "a", None, 0.0));
        assert!(matches!(x.take_back(50, None), TakeBack::Exited(_)), "nothing runs as it");
        x.asked(asked(60, "a", None, 0.0));
        assert!(matches!(x.take_back(60, Some(("b", None))), TakeBack::Exited(_)), "another app as its pid");
        x.asked(asked(70, "a", Some(1.0), 0.0));
        assert!(x.exited(70).is_some() && x.exited(70).is_none());
        assert!(x.is_empty());
    }
}

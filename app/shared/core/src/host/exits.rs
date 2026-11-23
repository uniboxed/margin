//! An app's exit and its pid used again: whether a running app is still the launch Margin knew (marked, kept active,
//! asked to quit). A pid is used again by another launch; the launch time tells them apart.

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
}

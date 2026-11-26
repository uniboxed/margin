//! A Safari the person opened, restarted with Margin's hosting arguments, asked first (DECISIONS.md "Restarting a
//! Safari the person opened, asked first", Tirth 2026-11-26).
//!
//! The hosting arguments (`-NSMenuEnableMenuBarAgent NO`, HostEngine.Options `safariArguments`) keep Safari's own menu
//! bar and full-screen toolbar from sliding out at the top edge in Margin's Space, so Margin's menu bar is the one
//! there; they can only be given as Safari starts. A Safari the person opened has none, and was hosted as it is. Now,
//! before Margin hosts anything of such a Safari, the person is asked once (a Margin notice, `safari-restart`):
//! - Restart Safari: it's quit (politely) and started again by Margin, with the arguments: from then on exactly a
//!   Safari Margin started (no Dock icon, the windows it restores closed, quit with Margin: Tirth's answer). Its own
//!   windows close; what was open only in them, typed text and downloads are lost; Margin's own tabs stay in Margin.
//! - Not now, or no answer while the notice is up (its time out, closed, another notice in its place): hosted as it is.
//!
//! The answer is kept for that Safari process only (a Safari started again, by anyone, is asked again): never written.
//! A restart that doesn't happen (Safari asked something and the person kept it, it didn't start again) is said and
//! that process isn't asked again. Chrome and Edge aren't hosted this way: never asked.

/// The running Safari as the engine reads it (`Ports::safari_run`): its process, whether it already has Margin's hosting
/// arguments (Margin started it, or it was started with them), and whether Margin hosts any window of it now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SafariRun {
    pub pid: i64,
    pub hosting: bool,
    pub hosted: bool,
}

/// Where the question stands for one Safari process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asked {
    /// Asked, no answer yet.
    Pending,
    /// Restart Safari chosen, not started yet.
    Restart,
    /// The restart under way (one show does it, the others wait for it).
    Restarting,
    /// Over: Not now, no answer, or a restart that didn't happen. Hosted as it is.
    Settled,
}

/// What a show of a Safari window does next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Hosted now: nothing to ask (no Safari running: Margin starts it with the arguments; it has them; Margin hosts it
    /// already; or this process's question is over).
    Go,
    /// Ask the person (once for this process).
    Ask,
    /// Wait for the answer, or for the restart another show is making.
    Wait,
    /// Restart it now (the person chose that).
    Restart,
}

/// The rule: what a Safari show does, from the running Safari and where its question stands (`asked`: the process it
/// was asked for, and how far it went). A question about another process (an older Safari) is no answer for this one.
pub fn step(run: Option<SafariRun>, asked: Option<(i64, Asked)>) -> Step {
    let Some(run) = run else { return Step::Go };
    if run.hosting || run.hosted {
        return Step::Go;
    }
    match asked {
        Some((pid, a)) if pid == run.pid => match a {
            Asked::Pending | Asked::Restarting => Step::Wait,
            Asked::Restart => Step::Restart,
            Asked::Settled => Step::Go,
        },
        _ => Step::Ask,
    }
}

/// The answer a notice's button (or its going unanswered) gives, from its action: Restart Safari only by its own button.
pub fn answer(action: &str) -> Asked {
    if action == RESTART { Asked::Restart } else { Asked::Settled }
}

/// The notice's kind and its Restart button's id (extension/shared/notices.ts `safari-restart`).
pub const NOTICE: &str = "safari-restart";
pub const RESTART: &str = "restart";

impl super::Core {
    /// The notice's answer (the UI's `safariRestart`: its button, or its going unanswered): taken only while it's asked.
    pub(crate) fn safari_restart_answer(&self, action: &str) {
        let Some((pid, Asked::Pending)) = self.restart_ask.get() else { return };
        let a = answer(action);
        self.restart_ask.set(Some((pid, a)));
        self.note(if a == Asked::Restart {
            "Safari opened outside Margin: Restart Safari chosen".into()
        } else {
            let how = if action == "later" { "Not now" } else { "no answer" };
            format!("Safari opened outside Margin: not restarted ({how}): hosted as it is")
        });
        self.exec.notify();
    }

    /// Before Margin hosts a window of Safari for `item` in Margin's window `w` (`host`): the question asked, answered
    /// and acted on first, as `step` says. The show waits outside the session's turn meanwhile (other picks go on), and
    /// gives up once another item is asked for in `w`, `w` closes, or Margin quits. False: given up.
    pub(crate) async fn safari_restart_gate(&self, w: i64, item: &str) -> bool {
        loop {
            let run = self.ports.safari_run();
            match step(run, self.restart_ask.get()) {
                Step::Go => return true,
                Step::Ask => {
                    let Some(run) = run else { return true };
                    let at = self.ports.window(Some(w)).or_else(|| self.ports.window(None));
                    let Some(at) = at else {
                        // (Nowhere to ask: hosted as it is.)
                        self.restart_ask.set(Some((run.pid, Asked::Settled)));
                        continue;
                    };
                    self.restart_ask.set(Some((run.pid, Asked::Pending)));
                    self.note(format!(
                        "Safari was opened outside Margin (pid {}): its own menu bar shows in Margin's Space; asked whether to restart it",
                        run.pid
                    ));
                    self.ports.push(at, &serde_json::json!({ "type": "hostNote", "kind": NOTICE }).to_string());
                }
                Step::Restart => {
                    let Some(run) = run else { return true };
                    self.restart_ask.set(Some((run.pid, Asked::Restarting)));
                    let a = self.engine("restartSafari", serde_json::json!({ "pid": run.pid })).await;
                    if crate::json::flag(a.get("restarted")) == Some(true) {
                        let pid =
                            a.get("pid").and_then(serde_json::Value::as_i64).map_or("?".into(), |p| p.to_string());
                        self.note(format!("Safari restarted by Margin with its hosting arguments (pid {pid})"));
                    } else {
                        let why = a.get("why").and_then(serde_json::Value::as_str).unwrap_or("?");
                        self.note(format!("Safari not restarted ({why}): hosted as it is"));
                    }
                    // (Done for that process either way: one that didn't quit is hosted as it is, never asked again.)
                    self.restart_ask.set(Some((run.pid, Asked::Settled)));
                    self.exec.notify();
                    continue;
                }
                Step::Wait => {}
            }
            if !self.restart_waited(w, item).await {
                self.note(format!("{item}: its show given up while Safari's restart was asked (another item picked, its window closed, or Margin quits)"));
                return false;
            }
        }
    }

    /// Until the question moves on (an answer, the restart over), outside the session's turn; false: the show isn't
    /// wanted any more. Each change the session's flows read is a look (an answer notifies), never a look on a timer.
    async fn restart_waited(&self, w: i64, item: &str) -> bool {
        // (Wanted while what `w` was asked for and shows stays as it was: a pick there, shown or still on its way,
        // changes one of them; a show the person didn't pick (the last item at launch) has no request of its own.)
        let asked = (self.requested_in(w), self.shown_in(w));
        let left = self.exec.leave_turn();
        let wanted = || {
            !self.superseded(w, item)
                && (self.requested_in(w), self.shown_in(w)) == asked
                && self.ports.window(Some(w)).is_some()
                && self.quit_at.get().is_none()
        };
        while wanted() && step(self.ports.safari_run(), self.restart_ask.get()) == Step::Wait {
            self.exec.changed().await;
        }
        if left {
            self.exec.rejoin().await;
        }
        wanted()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PERSONS: SafariRun = SafariRun { pid: 77, hosting: false, hosted: false };

    #[test]
    fn asked_once_before_margin_hosts_anything_of_a_safari_the_person_opened() {
        assert_eq!(step(Some(PERSONS), None), Step::Ask);
        assert_eq!(step(Some(PERSONS), Some((77, Asked::Pending))), Step::Wait, "asked: the show waits");
        assert_eq!(step(Some(PERSONS), Some((77, Asked::Restart))), Step::Restart);
        assert_eq!(step(Some(PERSONS), Some((77, Asked::Restarting))), Step::Wait, "one restart for every show");
        assert_eq!(step(Some(PERSONS), Some((77, Asked::Settled))), Step::Go, "never asked again for it");
    }

    #[test]
    fn never_asked_with_nothing_running_with_margins_arguments_or_once_hosted() {
        assert_eq!(step(None, None), Step::Go, "Margin starts it itself, with them");
        assert_eq!(step(Some(SafariRun { hosting: true, ..PERSONS }), None), Step::Go);
        assert_eq!(step(Some(SafariRun { hosted: true, ..PERSONS }), None), Step::Go, "hosted as it is already");
        assert_eq!(step(Some(SafariRun { hosting: true, ..PERSONS }), Some((77, Asked::Pending))), Step::Go);
    }

    #[test]
    fn a_new_safari_process_is_asked_again_the_answer_kept_for_its_own_only() {
        assert_eq!(step(Some(SafariRun { pid: 78, ..PERSONS }), Some((77, Asked::Settled))), Step::Ask);
        assert_eq!(step(Some(SafariRun { pid: 78, ..PERSONS }), Some((77, Asked::Pending))), Step::Ask);
    }

    #[test]
    fn only_its_own_button_restarts() {
        assert_eq!(answer("restart"), Asked::Restart);
        assert_eq!(answer("later"), Asked::Settled);
        assert_eq!(answer(""), Asked::Settled);
        assert_eq!(answer("RESTART"), Asked::Settled);
    }
}

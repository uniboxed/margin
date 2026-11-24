//! An item shown in another Margin window (docs/CORE-REFACTOR.md step 3, part 5; HostedSession `showElsewhere`,
//! `pagePicture`, `focused`, `windowClosing`, `windowClosed`, `forgetElsewhere`), transliterated as requests.rs is.
//!
//! One Margin window hosts at a time. Another one's item stays on it as a card, faded (with its page's picture for a
//! web item, asked of its copy as its window leaves, never waited for longer than `pictureWait`); the window brought in
//! front takes the item back. A window closing while it hosts has what it shows parked first; one closed forgets what
//! the session kept for it.

use serde_json::{Value, json};

use super::exec::{Either, first_of};
use super::hosting::HostTarget;
use super::target::Target;
use super::{Command, Core, Field, SAFARI_BUNDLE, object};
use crate::hosted_browser::Role;

/// A picture a card takes (the Swift's rule: a JPEG or PNG data address, no cap on its size: Tirth, 2026-11-23).
pub fn picture(data: Option<&str>) -> Option<&str> {
    data.filter(|d| d.starts_with("data:image/jpeg;base64,") || d.starts_with("data:image/png;base64,"))
}

impl Core {
    pub(crate) fn elsewhere_in(&self, w: i64) -> Option<String> {
        self.read(|s| s.elsewhere.get(&w).cloned())
    }

    fn set_elsewhere_item(&self, w: i64, item: Option<&str>) {
        self.edit(Field::Elsewhere, |s| match item {
            Some(i) => s.elsewhere.insert(w, i.to_string()),
            None => s.elsewhere.remove(&w),
        });
    }

    /// Another window's item kept on `w` as its card: the app's name, else the page's title, else its address (120
    /// characters at most: counted as Unicode scalars, as step 1's caps).
    pub(crate) fn show_elsewhere(&self, item: &str, w: i64, picture: Option<&str>) {
        let Some(value) = self.item_value(item) else { return };
        self.set_elsewhere_item(w, Some(item));
        let (name, app) = match self.target_of(item) {
            Some(Target::App { bundle, name }) => (self.ports.app_name(&bundle).unwrap_or(name), bundle),
            _ => {
                let title = value.get("title").and_then(Value::as_str).filter(|t| !t.is_empty());
                let name = title.or_else(|| value.get("url").and_then(Value::as_str)).unwrap_or("the page");
                (name.to_string(), SAFARI_BUNDLE.to_string())
            }
        };
        let name: String = name.chars().take(120).collect();
        self.ports.set_elsewhere(w, Some(&name), Some(&app), picture);
        let with = if picture.is_some() { " with its page's picture" } else { "" };
        self.note(format!(
            "Margin's window {w}: its item {item} shown in another window now: its card{with}, until it's in front again"
        ));
    }

    /// Its card off `w` (the window hosts again: straight to the loader).
    pub(crate) fn clear_elsewhere(&self, w: i64) {
        if self.elsewhere_in(w).is_some() {
            self.set_elsewhere_item(w, None);
            self.ports.set_elsewhere(w, None, None, None);
        }
    }

    /// A web item's page as its Safari window shows it now (the copy's `hostPicture`), or None: not a web item, its
    /// copy not linked, no picture, or none within `pictureWait` (the move isn't held longer: the card alone then).
    pub(crate) async fn page_picture(&self, item: &str) -> Option<String> {
        let wait = self.options.borrow().picture_wait;
        if wait <= 0.0 {
            return None;
        }
        let open = self.open_item(item)?;
        let p = open.profile?;
        if open.host != HostTarget::Safari(p.clone(), Role::Main).id() {
            return None;
        }
        let window_id = self.safari_window(&p, Role::Main)?;
        let payload = object(json!({ "windowId": window_id, "itemId": item }));
        let command = Command::Ask { profile: p, kind: "hostPicture".into(), payload };
        match first_of(self.exec.command(command, false), self.sleep(wait)).await {
            Either::A(answer) => {
                let data = answer.get("result").and_then(|r| r.get("data")).and_then(Value::as_str);
                picture(data).map(str::to_string)
            }
            Either::B(()) => None,
        }
    }

    /// A Margin window brought in front: its item from another window shown here again.
    pub(crate) fn focused(&self, window: i64) {
        let Some(item) = self.elsewhere_in(window) else { return };
        if self.hosting() == Some(window) {
            return;
        }
        let Some(w) = self.ports.window(Some(window)) else { return };
        if self.item_value(&item).is_none() {
            self.set_elsewhere_item(window, None);
            return self.ports.set_elsewhere(w, None, None, None);
        }
        self.set_requested(window, Some(&item));
        self.ports.changed();
        let target = self.target_of(&item);
        let Some(c) = self.rc() else { return };
        self.exec.enqueue(async move {
            if c.requested_in(window).as_deref() != Some(item.as_str()) || c.hosting() == Some(window) {
                return;
            }
            c.show(&item, None, target, Some(window)).await;
            if c.requested_in(window).as_deref() == Some(item.as_str()) {
                c.set_requested(window, None);
            }
        });
    }

    /// A Margin window closing while it hosts (its close button): what it shows parked first, while its Space is still
    /// there, then Swift's `then` called (the window closes). Not queued behind the session's own work. False: it
    /// doesn't host, close it now.
    pub(crate) fn window_closing(&self, window: i64, then: u64) -> bool {
        if self.hosting() != Some(window) || self.ports.engine_shown().is_none() {
            return false;
        }
        self.note(format!("Margin's window {window} closing while it hosts: the one shown parked first"));
        let Some(c) = self.rc() else { return false };
        self.exec.spawn(async move {
            c.engine("parkShown", json!({ "why": "its Margin window closed" })).await;
            c.exec.command(Command::Done { then }, false).await;
        });
        true
    }

    /// A Margin window closed: what the session kept for it goes (its card, its item shown, asked for or to resume, its
    /// Margin page). It hosted: nothing hosts until another window shows something (parked already by its closing;
    /// now if that didn't get there in time).
    pub(crate) fn window_closed(&self, window: i64) {
        let card = self.elsewhere_in(window).map(|i| format!(", its card for {i} gone")).unwrap_or_default();
        self.note(format!("Margin's window {window} closed: its items stay open (parked){card}"));
        self.forget_elsewhere(Some(window), None);
        self.set_requested(window, None);
        self.edit(Field::Shown, |s| s.shown.remove(&window));
        self.edit(Field::MarginPages, |s| s.margin_pages.remove(&window));
        self.edit(Field::Resume, |s| s.resume.remove(&window));
        self.edit(Field::CycledAt, |s| s.cycled_at.remove(&window));
        self.loading_forget(Some(window), true, false, None); // (its standing pushes' window)
        if self.hosting() == Some(window) {
            self.set_hosting(None);
            if self.ports.engine_shown().is_some()
                && let Some(c) = self.rc()
            {
                self.exec.spawn(async move {
                    c.engine("parkShown", json!({ "why": "its Margin window closed" })).await;
                });
            }
        }
        self.refresh_loading();
        self.loading_forget(Some(window), false, true, None); // (what its loading bar was told)
        self.ports.changed();
    }

    /// A window gone, or its item closed: its card goes. (Rust's maps are in key order: of several windows with a card
    /// for the item, the lowest first; Swift's dictionary had none.)
    pub(crate) fn forget_elsewhere(&self, window: Option<i64>, item: Option<&str>) {
        let gone: Vec<i64> = self.read(|s| {
            s.elsewhere
                .iter()
                .filter(|(w, i)| Some(**w) == window || Some(i.as_str()) == item)
                .map(|(w, _)| *w)
                .collect()
        });
        for w in gone {
            self.set_elsewhere_item(w, None);
            if self.ports.window(Some(w)).is_some() {
                self.ports.set_elsewhere(w, None, None, None);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::picture;

    #[test]
    fn a_picture_is_a_jpeg_or_png_data_address_of_any_size() {
        assert_eq!(picture(Some("data:image/jpeg;base64,QUJD")), Some("data:image/jpeg;base64,QUJD"));
        assert_eq!(picture(Some("data:image/png;base64,")), Some("data:image/png;base64,"));
        let big = format!("data:image/png;base64,{}", "A".repeat(9 << 20));
        assert_eq!(picture(Some(&big)).map(str::len), Some(big.len()), "no 8 MiB cap");
        for no in ["data:image/gif;base64,R0", "DATA:image/png;base64,", " data:image/png;base64,", "", "https://x/"] {
            assert_eq!(picture(Some(no)), None, "{no:?}");
        }
        assert_eq!(picture(None), None);
    }
}

//! The loading bar and the page card's loader (docs/CORE-REFACTOR.md step 3, part 8; HostedSession.swift `loading`,
//! `paneLoadingStep`, `releaseReveal`, `copyLoading`, `refreshLoading`), and the UI's numbers for open items
//! (`number(ofItem:)`, `item(ofTab:)`, `openRow(ofItem:)`): given in order of first use, so the same calls in the same
//! order give the same numbers.

use std::collections::BTreeSet;

use super::unicode::{GRAPHEME_EXTEND, has};
use super::{Core, Field, SAFARI_BUNDLE, host_id};

/// Whether `text` starts with `prefix` (ASCII) as Swift's `hasPrefix` sees it: as whole characters.
pub(crate) fn has_prefix_characters(text: &str, prefix: &str) -> bool {
    text.starts_with(prefix) && !text[prefix.len()..].chars().next().is_some_and(|c| has(GRAPHEME_EXTEND, c))
}

/// The app a host's icon is (HostedSession.swift `HostID.iconApp`): an app's bundle id, else Safari's.
pub(crate) fn icon_app(host: &str) -> &str {
    if has_prefix_characters(host, "app:") { &host["app:".len()..] } else { SAFARI_BUNDLE }
}

impl Core {
    // ---- the UI's numbers ----

    /// The UI's number for an item with a page: its own once it has one, else the next.
    pub(crate) fn number(&self, item: &str) -> i64 {
        if let Some(n) = self.state.borrow().numbers.get(item) {
            return *n;
        }
        let mut s = self.state.borrow_mut();
        let n = s.next_number + 1;
        s.next_number = n;
        s.numbers.insert(item.to_string(), n);
        s.items.insert(n, item.to_string());
        n
    }

    /// The item a UI number is for (None: never given).
    pub(crate) fn item_of_tab(&self, n: i64) -> Option<String> {
        self.state.borrow().items.get(&n).cloned()
    }

    /// An open item's row number, as the UI has it (None: not open, or never numbered).
    pub(crate) fn open_row(&self, item: &str) -> Option<i64> {
        let s = self.state.borrow();
        (s.open.contains_key(item) || s.margin_open.contains(item)).then(|| s.numbers.get(item).copied()).flatten()
    }

    // ---- the loading bar ----

    /// The engine's slow step for a host started (its first open, its placing again: None when it's over): the
    /// hosting window's page card is opaque, with the theme's loader and the app's name.
    pub(crate) fn loading(&self, host: Option<&str>) {
        if self.card_loading_step(host) {
            return;
        }
        self.state.borrow_mut().app_loading = host.map(str::to_string);
        self.page_loader(host);
        self.refresh_loading();
    }

    /// The engine's slow step for a card's window (its first open): the card's own loader (it says `loading` until it's
    /// in place), never the page card's over main. True: a card's, taken here (HostedPeek.swift `cardLoadingStep`).
    fn card_loading_step(&self, host: Option<&str>) -> bool {
        let mut s = self.state.borrow_mut();
        match host {
            Some(h) if host_id::safari_role(h) == crate::hosted_browser::Role::Card => {
                s.card_loading = Some(h.to_string());
                true
            }
            None if s.card_loading.is_some() => {
                s.card_loading = None;
                true
            }
            _ => false,
        }
    }

    fn page_loader(&self, host: Option<&str>) {
        let Some(wid) = self.read(|s| s.hosting_window) else { return };
        let Some(w) = self.ports.window(Some(wid)) else { return };
        if self.pane_loading_step(host) {
            return self.ports.set_loading(w, None, None);
        }
        let label = host.map(|h| self.read(|s| s.labels.get(h).cloned()).unwrap_or_else(|| host_id::logged(h)));
        self.ports.set_loading(w, label.as_deref(), host.map(icon_app));
    }

    /// The engine's slow step for a split's pane opening (or placed again) beside the panes shown (docs/PEEK-SPLIT.md
    /// §4): its loader over its own box (its item, a web page's title or the app's name, its icon), the other panes
    /// shown and usable; never the page area's loader over all of them. True: it was a pane's (or one just over).
    fn pane_loading_step(&self, host: Option<&str>) -> bool {
        let wid = self.read(|s| s.hosting_window);
        let item = match (host, wid) {
            (Some(h), Some(w)) => self.read(|s| s.panes_laying.get(&w).and_then(|m| m.get(h)).cloned()),
            _ => None,
        };
        let mut was = false;
        if let Some((had_w, had_h)) = self.read(|s| s.pane_loading_at.clone())
            && (item.is_none() || Some(had_w) != wid || Some(had_h.as_str()) != host)
        {
            if host.is_none() && self.read(|s| s.reveal_held.contains(&had_w)) {
                return true; // (kept: `release_reveal`)
            }
            if let Some(w) = self.ports.window(Some(had_w)) {
                self.ports.set_pane_loading(w, None, None, None);
            }
            self.state.borrow_mut().pane_loading_at = None;
            was = host.is_none();
        }
        let (Some(host), Some(item), Some(wid)) = (host, item, wid) else { return was };
        let Some(w) = self.ports.window(Some(wid)) else { return was };
        self.state.borrow_mut().pane_loading_at = Some((wid, host.to_string()));
        let title = self.title_of(&item);
        let label = self.read(|s| s.labels.get(host).cloned());
        let label = if has_prefix_characters(host, "app:") {
            label.unwrap_or_else(|| host_id::logged(host))
        } else {
            title.or(label).unwrap_or_else(|| "Safari".into())
        };
        self.ports.set_pane_loading(w, Some(&item), Some(&label), Some(icon_app(host)));
        true
    }

    /// A Margin window whose new pane kept its loader (applyLayout's `revealHeld`): let go, the loader lifted if the
    /// engine's slow step for it is over.
    pub(crate) fn release_reveal(&self, wid: i64) {
        let held = self.edit(Field::RevealHeld, |s| s.reveal_held.remove(&wid));
        if !held {
            return;
        }
        let Some((had_w, had_h)) = self.read(|s| s.pane_loading_at.clone()) else { return };
        if had_w != wid || self.read(|s| s.app_loading.as_deref() == Some(had_h.as_str())) {
            return;
        }
        if let Some(w) = self.ports.window(Some(wid)) {
            self.ports.set_pane_loading(w, None, None, None);
        }
        self.state.borrow_mut().pane_loading_at = None;
    }

    /// A Safari profile's copy's `loading` push (background/page-loads.ts: its tabs loading in one of its windows):
    /// kept for the window Margin hosts for that profile (its main one), the bar drawn for its items' tabs.
    pub(crate) fn copy_loading(&self, profile: &str, window: Option<i64>, tabs: &[i64]) {
        let Some(window) = window else { return };
        if self.safari_window(profile, crate::hosted_browser::Role::Main) != Some(window) {
            return;
        }
        let next: BTreeSet<i64> = tabs.iter().copied().collect();
        if self.read(|s| s.copy_loading.get(profile).map_or(next.is_empty(), |had| *had == next)) {
            return;
        }
        self.state.borrow_mut().copy_loading.insert(profile.to_string(), next);
        self.refresh_loading();
    }

    /// The items loading now, by the UI's numbers, told to the hosting Margin window when they change: the item an
    /// app is being opened (or placed again) for while the engine's slow step runs, and every web item whose tab its
    /// copy says is loading. Nothing hosted: none (the other windows told none).
    pub(crate) fn refresh_loading(&self) {
        let hosting = self.read(|s| s.hosting_window);
        let items: BTreeSet<String> = self.read(|s| {
            let mut items = BTreeSet::new();
            let Some(wid) = hosting else { return items };
            if let Some(id) = &s.app_loading {
                let shown = s.shown.get(&wid).filter(|i| s.open.get(*i).is_some_and(|o| &o.host == id));
                if let Some(item) = s.showing.get(id).or(shown) {
                    items.insert(item.clone());
                }
            }
            for (item, o) in &s.open {
                let Some(p) = &o.profile else { continue };
                let Some(tab) = s.safari_tabs.get(item) else { continue };
                if s.copy_loading.get(p).is_some_and(|t| t.contains(tab)) {
                    items.insert(item.clone());
                }
            }
            items
        });
        let others: Vec<i64> = self.read(|s| {
            s.loading_said
                .iter()
                .filter(|(w, said)| Some(**w) != hosting && !said.is_empty())
                .map(|(w, _)| *w)
                .collect()
        });
        for wid in others {
            self.state.borrow_mut().loading_said.insert(wid, Vec::new());
            if let Some(w) = self.ports.window(Some(wid)) {
                self.ports.set_loading_tabs(w, &[]);
            }
        }
        let Some(wid) = hosting else { return };
        let Some(w) = self.ports.window(Some(wid)) else { return };
        let mut numbers: Vec<i64> = items.iter().map(|i| self.number(i)).collect();
        numbers.sort_unstable();
        if self.read(|s| s.loading_said.get(&wid).map_or(numbers.is_empty(), |had| *had == numbers)) {
            return;
        }
        self.state.borrow_mut().loading_said.insert(wid, numbers.clone());
        self.ports.set_loading_tabs(w, &numbers);
    }

    /// What the loading bar kept for a window gone (its standing pushes' window, `standing`; what it was told,
    /// `said`), or a profile's copy whose main window went (`profile`).
    pub(crate) fn loading_forget(&self, window: Option<i64>, standing: bool, said: bool, profile: Option<&str>) {
        let mut s = self.state.borrow_mut();
        if let Some(w) = window {
            if standing {
                s.standing_to.retain(|_, to| *to != w);
            }
            if said {
                s.loading_said.remove(&w);
            }
        }
        if let Some(p) = profile {
            s.copy_loading.remove(p);
        }
    }
}

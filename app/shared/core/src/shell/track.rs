//! Following the windows (Shell.swift `track`, `followKept`, `updateDrawn`, `layoutChanged`), the keys
//! (`updateKeys`, `run`, `keyHeard`), the pointer (`pointerMoved`, `pressed`) and what a copy pushed that the shell
//! weighs first (`palettePush`).

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::{Value, json};

use crate::binder::{self, ExtWindow, Update, WindowBinder};
use crate::geometry::{Point, Rect};
use crate::json::{self, Object};
use crate::passthrough::{PassThrough, WantMode};
use crate::planner::{self, OverlayDecision, OverlayFacts};
use crate::protocol::{AppMessage, SpaceWindowAnswer};
use crate::shortcuts::{self, AppCommand, KeyRoute};
use crate::system::ServerWindow;
use crate::time::Secs;

use super::{
    BrowserProcess, Command, HotKey, LinkEntry, OverlayModel, Pending, Shell, WindowKey, WindowRead, json_text,
};

/// A group of links whose windows are one binder's: a browser's process (the relay's pid), or every process of that
/// browser when the relay didn't know it.
#[derive(Clone, Debug)]
struct Group {
    browser: String,
    pids: HashSet<u32>,
    links: Vec<String>,
    held: BTreeSet<String>,
}

impl Shell {
    /// The processes of a browser's link: its relay's pid and the processes under it, or every process of that
    /// browser when the relay didn't say.
    pub(crate) fn pids_of(&self, browser: &str, pid: Option<u32>, procs: &[BrowserProcess]) -> HashSet<u32> {
        match pid {
            Some(pid) => std::iter::once(pid).chain(procs.iter().filter(|p| p.root == pid).map(|p| p.pid)).collect(),
            None => procs.iter().filter(|p| p.browser == browser).map(|p| p.pid).collect(),
        }
    }

    fn link_pid(entry: &LinkEntry) -> Option<u32> {
        entry.hello.pid.and_then(|p| u32::try_from(p).ok())
    }

    /// Each group of links (live ones, and, `with_kept`, dropped ones kept for a moment).
    fn groups(&self, procs: &[BrowserProcess], with_kept: bool) -> BTreeMap<String, Group> {
        let mut out: BTreeMap<String, Group> = BTreeMap::new();
        let mut add = |shell: &Shell, browser: &str, pid: Option<u32>, link: &str, held: bool| {
            let name = format!("{browser}@{}", pid.map(|p| p.to_string()).unwrap_or_else(|| "any".into()));
            let g = out.entry(name).or_insert_with(|| Group {
                browser: browser.to_owned(),
                pids: shell.pids_of(browser, pid, procs),
                links: Vec::new(),
                held: BTreeSet::new(),
            });
            g.links.push(link.to_owned());
            if held {
                g.held.insert(link.to_owned());
            }
        };
        for (key, e) in &self.links {
            add(self, &e.hello.browser, Self::link_pid(e), key, !e.mirror.has_state());
        }
        if with_kept {
            for (key, k) in &self.reconnecting {
                if !self.links.contains_key(key) {
                    add(self, &k.browser, k.pid, key, true);
                }
            }
        }
        out
    }

    /// The process in front, as far as the keys go: an overlay's own window in front (it took the keyboard) is its
    /// browser's.
    pub(crate) fn effective_front_pid(&self) -> Option<u32> {
        let read = &self.last_read;
        if let Some(w) = read.front_window
            && let Some(o) = self.overlays.values().find(|o| o.number == Some(w))
        {
            return Some(o.browser_pid);
        }
        read.front_pid
    }

    /// The overlay over the front app's frontmost window, if it's a linked browser's (an overlay itself in front:
    /// that one).
    pub(crate) fn front_overlay(&mut self) -> Option<WindowKey> {
        let read = &self.last_read;
        if let Some(w) = read.front_window
            && let Some(o) = self.overlays.values().find(|o| o.number == Some(w) && o.shown)
        {
            return Some(o.key.clone());
        }
        let front = read.front_pid?;
        let pids: HashSet<u32> = std::iter::once(front).collect();
        let top = binder::candidates(&read.list, &pids).into_iter().filter(|w| w.on_screen).min_by_key(|w| w.order);
        let Some(top) = top else {
            // None of its windows on screen: its overlay kept unseen over the one in front a moment ago.
            let last = self.last_front_window;
            return self
                .overlays
                .values()
                .find(|o| o.shown && o.concealed && o.browser_pid == front && o.above == last && last.is_some())
                .map(|o| o.key.clone());
        };
        self.last_front_window = Some(top.number);
        self.overlays.values().find(|o| o.shown && o.above == Some(top.number)).map(|o| o.key.clone())
    }

    /// One read of the windows, and everything that follows from it.
    pub(crate) fn track(&mut self, read: WindowRead) {
        self.poll_due = None;
        let now = self.now;
        self.last_read = read;
        let read = self.last_read.clone();
        // (A dropped link's browser too, while its overlays are kept: they're checked against its windows.)
        let groups = self.groups(&read.browsers, true);
        let read_pids: HashSet<u32> = groups.values().flat_map(|g| g.pids.iter().copied()).collect();
        let all_pids: HashSet<u32> = self.groups(&read.browsers, false).values().flat_map(|g| g.pids.clone()).collect();
        let front = self.effective_front_pid();
        let browser_in_front = front.is_some_and(|p| read_pids.contains(&p));
        if !self.started {
            if !browser_in_front {
                return self.update_keys(&all_pids); // nothing until a linked browser is in front
            }
            self.started = true;
            self.out.note("a linked browser is in front: following its windows");
        }
        self.tracks += 1;
        let list = read.list.clone();
        let by_number: BTreeMap<i64, ServerWindow> = list.iter().map(|w| (w.number, w.clone())).collect();
        // The browser's windows coming on or going off screen: read often for a moment.
        let on_screen: BTreeSet<i64> =
            binder::candidates(&list, &read_pids).into_iter().filter(|w| w.on_screen).map(|w| w.number).collect();
        if on_screen != self.last_browser_on_screen {
            self.burst_until = self.burst_until.max(now + self.opts.burst_for);
        }
        self.last_browser_on_screen = on_screen;

        // Each group's windows, bound (WindowBinder: it logs every binding made, moved or dropped, and why).
        let mut next: BTreeMap<WindowKey, i64> = BTreeMap::new();
        let mut free: BTreeMap<String, Vec<ServerWindow>> = BTreeMap::new();
        let mut absent: BTreeSet<i64> = BTreeSet::new();
        let mut ext: BTreeMap<WindowKey, ExtWindow> = BTreeMap::new();
        for (name, g) in &groups {
            let entries: Vec<&String> =
                g.links.iter().filter(|k| self.links.get(*k).is_some_and(|e| e.mirror.has_state())).collect();
            let mut windows = Vec::new();
            let mut copies = BTreeMap::new();
            for key in &entries {
                let Some(e) = self.links.get(*key) else { continue };
                let list: Vec<Value> = e.mirror.windows().iter().cloned().map(Value::Object).collect();
                for w in ExtWindow::parse(&list, key) {
                    ext.insert(w.key.clone(), w.clone());
                    windows.push(w);
                }
                copies.insert((*key).clone(), e.hello.copy_id());
            }
            let log = self.binder_log.clone();
            let binder = self.binders.entry(name.clone()).or_insert_with(|| {
                WindowBinder::new(
                    &g.browser,
                    binder::Timing::default(),
                    Box::new(move |line: &str| {
                        if let Ok(mut l) = log.lock() {
                            l.push(line.to_owned());
                        }
                    }),
                )
            });
            let bound = binder.update(&Update {
                now,
                ext: windows,
                reporting: entries.iter().map(|k| (*k).clone()).collect(),
                copies,
                held: g.held.clone(),
                server: list.clone(),
                pids: g.pids.clone(),
                browser_in_front: front.is_some_and(|p| g.pids.contains(&p)),
                listed: true,
                ..Update::default()
            });
            let numbers: BTreeSet<i64> = bound.values().copied().collect();
            free.entry(g.browser.clone())
                .or_default()
                .extend(binder::candidates(&list, &g.pids).into_iter().filter(|w| !numbers.contains(&w.number)));
            absent.extend(binder.absent_numbers().iter().copied());
            next.extend(bound);
        }
        // (Their lines, in order with the rest.)
        let lines: Vec<String> = self.binder_log.lock().map(|mut l| std::mem::take(&mut *l)).unwrap_or_default();
        for line in lines {
            self.out.note(line);
        }
        // Binders of groups gone (a browser quit): forgotten.
        self.binders.retain(|name, _| groups.contains_key(name));
        self.matches = next.clone();
        self.lines.retain(|link, w| ext.contains_key(&WindowKey::new(link, w)));
        // Each copy told which of its windows the app draws over, before any overlay shows or layout goes.
        self.update_drawn(&ext, &free);

        // The overlays: made when wanted, shown when they can be, closed when their window is gone.
        for (key, w) in &ext {
            let Some(entry) = self.links.get(&key.link) else { continue };
            let has_theme = entry.theme.is_some();
            let bound = next.get(key).copied();
            let window = bound.and_then(|n| by_number.get(&n).cloned());
            let existing = self.overlays.get(key);
            let facts = OverlayFacts {
                full: w.state == "fullscreen" || self.opts.windowed_too,
                has_theme,
                early: has_theme
                    && self.switcher.busy()
                    && self.switcher.target().is_some_and(|t| t.profile == key.link)
                    && self.switcher.new_window() == Some(key.window_id),
                bound,
                absent: bound.is_some_and(|n| absent.contains(&n)),
                fills: self.opts.windowed_too
                    || window.as_ref().is_some_and(|s| planner::fills_display(&s.bounds, &read.displays)),
                window: window.clone(),
                // Not owned by its window (overlay.rs): it doesn't follow it anywhere by itself.
                follows_window: false,
                shown: existing.is_some_and(|o| o.shown),
                over: existing.and_then(|o| o.above),
                window_frame: existing.and_then(|o| o.window_frame),
                ..OverlayFacts::default()
            };
            let decision = planner::decide(&facts);
            if !decision.needs_overlay() {
                if let (OverlayDecision::NotWanted(why), Some(o)) = (&decision, self.overlays.get_mut(key)) {
                    o.hide(&mut self.out, why);
                } else if let Some(o) = self.overlays.get_mut(key) {
                    o.hide(&mut self.out, "its window leaves full screen for a switch");
                }
                continue;
            }
            if !self.overlays.contains_key(key) {
                self.make_overlay(key);
            }
            let Some(o) = self.overlays.get_mut(key) else { continue };
            let number = match decision {
                OverlayDecision::Hide(why) => {
                    o.hide(&mut self.out, &why);
                    continue;
                }
                OverlayDecision::Conceal => {
                    o.conceal(&mut self.out);
                    continue;
                }
                OverlayDecision::Reveal => {
                    o.reveal(&mut self.out);
                    continue;
                }
                // No placing ahead on Windows (no Spaces): put away, as the Mac did before it.
                OverlayDecision::PlaceAhead { or_hide } => {
                    o.hide(&mut self.out, &or_hide);
                    continue;
                }
                OverlayDecision::Keep
                | OverlayDecision::NotWanted(_)
                | OverlayDecision::Parked
                | OverlayDecision::Leaving => continue,
                OverlayDecision::Show(number) => number,
            };
            let Some(server) = window else { continue };
            o.browser_pid = server.pid;
            // Its page (or a video in it) in full screen: out of sight over the window until it's back.
            if o.page_fullscreen != w.page_fullscreen {
                o.page_fullscreen = w.page_fullscreen;
                self.out.note(format!(
                    "{key}: its page {}",
                    if w.page_fullscreen {
                        "went into full screen: Margin's layout out of sight"
                    } else {
                        "came out of full screen: Margin's layout back"
                    }
                ));
            }
            if w.page_fullscreen {
                if o.shown {
                    o.conceal(&mut self.out);
                }
                continue;
            }
            let was_shown = o.shown && o.above == Some(number);
            let was_shown_anywhere = o.shown;
            // Over the part of the window that's the page's and Margin's: not docked DevTools.
            let viewport = if w.state == "fullscreen" { w.viewport } else { None };
            o.window_full_screen = w.state == "fullscreen";
            let docked = planner::docked_left(o.pointer_want.mode == WantMode::None, o.layout.as_ref().map(|l| l.left));
            let (frame, layout_window) = if w.state != "fullscreen" && self.opts.windowed_too {
                // Over the page area only, under the browser's tabs and toolbar.
                let (frame, from) = planner::windowed_frame(server.bounds, w.bounds, w.viewport, w.viewport_measured);
                (frame, (from != server.bounds).then_some(from))
            } else {
                (planner::overlay_frame(server.bounds, viewport, docked), None)
            };
            o.layout_window = layout_window;
            if frame != server.bounds
                && layout_window.is_none()
                && (o.window_frame != Some(server.bounds) || o.frame != frame)
            {
                self.out.note(format!(
                    "{key}: the browser takes part of its window (DevTools docked?): Margin draws in {} of {}",
                    frame.describe(),
                    server.bounds.describe()
                ));
            }
            o.window_frame = Some(server.bounds);
            o.size_to(&mut self.out, frame, number);
            let showed = o.show(&mut self.out, number, frame, "its window is on screen", now);
            if showed && was_shown {
                let stacked = o.number.is_some_and(|n| binder::stacked_above(&list, n, number, None, &BTreeSet::new()));
                if !stacked {
                    o.reorder(&mut self.out);
                }
            }
            let layout = o.layout.clone();
            if showed && !was_shown_anywhere {
                self.appeared(key, w);
            }
            if showed {
                self.deliver_held_palette(key);
            }
            if let Some(layout) = layout {
                self.layout_changed(key, &layout);
            }
        }
        self.follow_kept(&by_number, &read);
        // (Not a link's that dropped a moment ago, nor one back but without its state yet: kept as they are.)
        let gone: Vec<WindowKey> = self
            .overlays
            .keys()
            .filter(|k| {
                !ext.contains_key(*k)
                    && !self.reconnecting.contains_key(&k.link)
                    && self.links.get(&k.link).is_none_or(|e| e.mirror.has_state())
            })
            .cloned()
            .collect();
        for k in gone {
            self.close_overlay(&k);
        }
        let any_shown = self.overlays.values().any(|o| o.shown);
        if any_shown != self.pointer_watch {
            self.pointer_watch = any_shown;
            self.out.push(Command::PointerWatch { on: any_shown });
        }
        self.update_keys(&all_pids);
        if let Some((at, buttons)) = self.pointer {
            self.pointer_moved(at, buttons, true);
        }
        if self.switcher.busy() {
            self.switch_tick();
        }
        // The next read.
        let every = if now < self.burst_until {
            self.opts.burst_poll
        } else if browser_in_front {
            self.opts.rest_poll
        } else {
            self.opts.idle_poll
        };
        if !self.links.is_empty() || !self.reconnecting.is_empty() {
            self.poll_due = Some(now + every);
        }
    }

    fn make_overlay(&mut self, key: &WindowKey) {
        let id = self.next_overlay;
        self.next_overlay += 1;
        self.overlays.insert(key.clone(), OverlayModel::new(id, key.clone()));
        self.by_id.insert(id, key.clone());
        self.out.push(Command::CreateOverlay { id });
        self.out.note(format!("overlay made for {key}"));
    }

    /// An overlay just shown (it wasn't): whether it's the front window's, and whether its window is new.
    fn appeared(&mut self, key: &WindowKey, w: &ExtWindow) {
        let now = self.now;
        let front = self.front_overlay().as_ref() == Some(key);
        let within = self.opts.launcher_focus_within;
        let new = w.created_at.is_some_and(|t| now - t <= within);
        let made = self.palette_on_show.remove(key).is_some_and(|t| now - t <= within);
        if let Some(o) = self.overlays.get_mut(key) {
            o.appeared(&mut self.out, front, front && made, front && new, now);
        }
    }

    /// A dropped link's overlays, kept dimmed for it to come back: each put away once the window it's over is gone,
    /// off screen, moved or resized, or no longer fills its display.
    fn follow_kept(&mut self, by_number: &BTreeMap<i64, ServerWindow>, read: &WindowRead) {
        let keys: Vec<WindowKey> = self
            .overlays
            .iter()
            .filter(|(k, o)| self.reconnecting.contains_key(&k.link) && !self.links.contains_key(&k.link) && o.shown)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            let Some(o) = self.overlays.get_mut(&key) else { continue };
            let Some(number) = o.above else { continue };
            let why = match by_number.get(&number) {
                Some(s) if !s.on_screen => Some("its window isn't on screen"),
                Some(s) if o.window_frame.is_some_and(|f| f != s.bounds) => {
                    Some("its window moved or changed size (out of full screen?)")
                }
                Some(s) if !(self.opts.windowed_too || planner::fills_display(&s.bounds, &read.displays)) => {
                    Some("its window doesn't fill its display")
                }
                Some(_) => None,
                None => Some("its window is gone from the window server"),
            };
            if let Some(why) = why {
                o.hide(&mut self.out, &format!("{why}, while its link is reconnecting"));
            }
        }
    }

    /// Whether the app draws over each reported window, to its copy: on at once as it's bound (and wanted), off
    /// after the grace, off at once for a closed window that was on.
    fn update_drawn(&mut self, ext: &BTreeMap<WindowKey, ExtWindow>, free: &BTreeMap<String, Vec<ServerWindow>>) {
        let now = self.now;
        let mut sends: Vec<(WindowKey, bool, String)> = Vec::new();
        for (key, w) in ext {
            let Some(entry) = self.links.get_mut(&key.link) else { continue };
            let wanted = (w.state == "fullscreen" || self.opts.windowed_too) && entry.theme.is_some();
            let bound = self.matches.contains_key(key);
            let same: Vec<&ServerWindow> = w
                .bounds
                .map(|b| {
                    free.get(&entry.hello.browser)
                        .map(|f| f.iter().filter(|s| binder::close(&s.bounds, &b)).collect())
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            let pending = !bound && w.state == "fullscreen" && !same.is_empty() && same.iter().all(|s| !s.on_screen);
            let r = entry.drawn.offer(key.window_id, now, bound, wanted, pending);
            if let Some(on) = r.send {
                sends.push((key.clone(), on, r.why));
            }
            match r.due {
                Some(due) => {
                    self.drawn_due.insert(key.clone(), due);
                }
                None => {
                    self.drawn_due.remove(key);
                }
            }
        }
        for (link, entry) in self.links.iter_mut().filter(|(_, e)| e.mirror.has_state()) {
            for id in entry.drawn.windows() {
                let key = WindowKey::new(link.as_str(), id);
                if ext.contains_key(&key) {
                    continue;
                }
                self.drawn_due.remove(&key);
                if let Some(on) = entry.drawn.closed(id) {
                    sends.push((key, on, "closed".into()));
                }
            }
        }
        for (key, on, why) in sends {
            self.send_drawn(&key, on, &why);
        }
    }

    pub(crate) fn send_drawn(&mut self, key: &WindowKey, on: bool, why: &str) {
        let Some(e) = self.links.get(&key.link) else { return };
        let (conn, epoch) = (e.conn, e.epoch().to_owned());
        self.send(conn, &AppMessage::Drawn { epoch, window_id: key.window_id, on });
        self.out.note(format!("{key}: told {}: {why}", if on { "drawn" } else { "not drawn" }));
    }

    /// Only a layout measured at the overlay's own size goes, and only for a bound window.
    pub(crate) fn layout_changed(&mut self, key: &WindowKey, layout: &crate::protocol::PageLayout) {
        if !self.matches.contains_key(key) {
            return;
        }
        let Some(o) = self.overlays.get(key) else { return };
        let size = o.frame;
        if (layout.width - size.width).abs() >= 1.0 || (layout.height - size.height).abs() >= 1.0 {
            return;
        }
        let window = o.layout_window.or(o.window_frame).unwrap_or(o.frame);
        let in_window = layout.in_window(o.frame, window);
        let Some(entry) = self.links.get_mut(&key.link) else { return };
        let Some((seq, rounded)) = entry.outbox.offer(key.window_id, &in_window) else { return };
        let (conn, epoch) = (entry.conn, entry.epoch().to_owned());
        self.send(conn, &AppMessage::SetLayout { epoch, window_id: key.window_id, seq, layout: rounded });
    }

    // ---- the keys ----

    /// The hot keys held as they should be now: the front window's copy's combinations, while a linked browser is in
    /// front with an overlay shown over its front window.
    pub(crate) fn update_keys(&mut self, all_pids: &HashSet<u32>) {
        let now = self.now;
        let matched = self.front_overlay().and_then(|k| self.overlays.get(&k).map(|o| (k, o.browser_pid)));
        let front_pid = self.effective_front_pid();
        let overlays = &self.overlays;
        let front = self.keys_front.front(matched, front_pid, now, |k| overlays.get(k).is_some_and(|o| o.shown));
        if let Some(k) = &front {
            let keys = self.links.get(&k.link).and_then(|e| e.keys.clone()).unwrap_or_default();
            let page_full = self.overlays.get(k).is_some_and(|o| o.page_fullscreen);
            let bindings = shortcuts::bindings_for_front(&keys, self.opts.os, false, page_full);
            self.shortcuts.rebind(&mut self.registrar, bindings);
        }
        let active = shortcuts::active(front_pid, all_pids, front.is_some());
        for (combo, command) in self.shortcuts.set_active(&mut self.registrar, active) {
            self.out.note(format!("{combo} ({}) is another app's: not Margin's", command.name()));
        }
        self.sync_hot_keys();
        // Off with a linked browser in front: why, once.
        let browser_in_front = front_pid.is_some_and(|p| all_pids.contains(&p));
        let why =
            if self.shortcuts.is_active() || !browser_in_front { None } else { Some(self.keys_off_reason(&front)) };
        if why != self.keys_off_why {
            match &why {
                Some(w) => self.out.note(format!("Margin's keys are the browser's for now: {w}")),
                None if self.keys_off_why.is_some() && self.shortcuts.is_active() => {
                    self.out.note("Margin's keys are the app's again")
                }
                None => {}
            }
            self.keys_off_why = why;
        }
    }

    /// The hot keys as the registrar holds them, to the OS layer when they changed.
    pub(crate) fn sync_hot_keys(&mut self) {
        let keys: Vec<HotKey> = self
            .shortcuts
            .bindings()
            .iter()
            .enumerate()
            .filter_map(|(i, (combo, command))| {
                let id = u32::try_from(i).ok()?;
                (self.registrar.held.get(&id) == Some(combo)).then_some(HotKey {
                    id,
                    combo: *combo,
                    command: *command,
                    repeats: command.repeats(),
                })
            })
            .collect();
        if keys != self.hotkeys_sent {
            self.hotkeys_sent = keys.clone();
            self.out.push(Command::HotKeys { keys });
        }
    }

    fn keys_off_reason(&self, front: &Option<WindowKey>) -> String {
        match front {
            None => {
                let shown = self.overlays.values().filter(|o| o.shown).count();
                format!(
                    "the front window has no overlay shown ({shown} shown elsewhere; the front window read: {})",
                    self.last_front_window.map(|n| n.to_string()).unwrap_or_else(|| "none".into())
                )
            }
            Some(k) => format!("the overlay over the front window ({k}) doesn't hold them"),
        }
    }

    /// A key the app holds heard by the copy anyway: logged, with whether the app's hot keys were on and why not.
    fn key_heard(&mut self, link: &str, window_id: Option<i64>, msg: &Object) {
        let command = json::string(msg.get("command")).unwrap_or("a key");
        let from = json::string(msg.get("from")).unwrap_or("the copy");
        let at = window_id.map(|w| WindowKey::new(link, w).to_string()).unwrap_or_else(|| link.to_owned());
        let front = self.front_overlay();
        let front_pid = self.effective_front_pid();
        let linked: HashSet<u32> =
            self.groups(&self.last_read.browsers, false).values().flat_map(|g| g.pids.clone()).collect();
        let state = if self.shortcuts.is_active() {
            format!(
                "the app's hot keys were on (the front overlay: {}): another combination, or the browser's own command",
                front.as_ref().map(|k| k.to_string()).unwrap_or_else(|| "none".into())
            )
        } else if front_pid.is_none() {
            "the app's hot keys were off: no app in front".into()
        } else if !front_pid.is_some_and(|p| linked.contains(&p)) {
            "the app's hot keys were off: the front app isn't a linked browser".into()
        } else {
            format!("the app's hot keys were off: {}", self.keys_off_reason(&front))
        };
        self.out.note(format!("{at}: {command} reached the extension ({from}): {state}"));
    }

    /// A hot key's command. `is_repeat`: a held key's repeat, not a press.
    pub(crate) fn run(&mut self, command: AppCommand, is_repeat: bool) {
        let Some(key) = self.front_overlay().or_else(|| {
            // (Within the keys' grace: the overlay that last had them.)
            let pid = self.effective_front_pid();
            let overlays = &self.overlays;
            self.keys_front.front(None, pid, self.now, |k| overlays.get(k).is_some_and(|o| o.shown))
        }) else {
            return;
        };
        if !self.links.contains_key(&key.link) {
            return;
        }
        let ready = self.overlays.get(&key).is_some_and(|o| o.ready);
        match shortcuts::route(command, is_repeat, ready) {
            KeyRoute::Overlay { name, repeat } => {
                let now = self.now;
                let Some(o) = self.overlays.get_mut(&key) else { return };
                if command == AppCommand::Palette {
                    o.palette_key_at = Some(now);
                    let closes = if o.has_keyboard { " (it has the keyboard: the palette closes)" } else { "" };
                    self.out.note(format!("the palette's key: sent to {key}'s overlay{closes}"));
                }
                o.push(&mut self.out, json_text(&shortcuts::command_push(name, repeat)));
            }
            KeyRoute::NewWindow => self.new_margin_window(&key),
            KeyRoute::Space { dir, action } => {
                if !self.space_key(&key, dir, is_repeat) {
                    self.navigate(&key, action);
                }
            }
            KeyRoute::Navigate { action } => self.navigate(&key, action),
        }
    }

    fn navigate(&mut self, key: &WindowKey, action: &str) {
        let payload = json!({ "action": action, "windowId": key.window_id });
        self.ask(&key.link, "navigate", payload, Some(key.window_id));
    }

    /// ⌘N (docs/BROWSER-WINDOWS.md §5): a new window of the front window's profile, a Margin window of its own.
    pub(crate) fn new_margin_window(&mut self, from: &WindowKey) {
        let linked = self.links.get(&from.link).is_some_and(|e| e.mirror.has_state());
        let from_s = crate::switch::WindowKey::new(&from.link, from.window_id);
        let Some(req) = crate::across::new_margin_window(&from_s, linked) else {
            self.out.note(format!("⌘N: {} isn't linked: no window", from.link));
            return;
        };
        self.out.note(format!("⌘N: a new window of {} from {from}", from.link));
        let asked = self.now;
        let link = req.link.clone();
        self.request(&req.link, req.kind, req.payload, req.window_id, Pending::NewWindow { link, asked });
    }

    /// A window the app's own request made (asked at `asked`): its binder binds it to the one new window the OS lists
    /// from then, by the bounds the answer gave until the copy's list has it.
    pub(crate) fn window_made(&mut self, link: &str, window_id: i64, asked: Secs, bounds: Option<Rect>) {
        let Some(entry) = self.links.get(link) else { return };
        let browser = entry.hello.browser.clone();
        let pid = Self::link_pid(entry);
        let name = format!("{browser}@{}", pid.map(|p| p.to_string()).unwrap_or_else(|| "any".into()));
        let log = self.binder_log.clone();
        let binder = self.binders.entry(name).or_insert_with(|| {
            WindowBinder::new(
                &browser,
                binder::Timing::default(),
                Box::new(move |line: &str| {
                    if let Ok(mut l) = log.lock() {
                        l.push(line.to_owned());
                    }
                }),
            )
        });
        binder.expect(WindowKey::new(link, window_id), asked, self.now, "made by Margin's openSpaceWindow", bounds);
        self.burst("window made");
    }

    /// A window made from another (⌘N, the palette's New window): bound as Margin's, and the palette opens over its
    /// new tab as it shows.
    pub(crate) fn made_from_window(&mut self, link: &str, made: &SpaceWindowAnswer, asked: Secs) {
        let key = WindowKey::new(link, made.window_id);
        self.window_made(link, made.window_id, asked, made.bounds);
        match self.overlays.get(&key) {
            Some(o) if o.shown => o.push(&mut self.out, r#"{"type":"push","msg":{"type":"palette","newTab":false}}"#),
            _ => {
                self.palette_on_show.insert(key, self.now);
            }
        }
    }

    // ---- what a copy pushed ----

    pub(crate) fn pushed(&mut self, link: &str, window_id: Option<i64>, msg: Object) {
        let now = self.now;
        let Some(entry) = self.links.get_mut(link) else { return };
        entry.held.offer(window_id, &msg, now);
        let json = json_text(&json!({ "type": "push", "msg": msg }));
        match json::string(msg.get("type")) {
            Some("keyHeard") => return self.key_heard(link, window_id, &msg),
            Some("palette") if window_id.is_some() => {
                let new_tab = json::boolean(msg.get("newTab")) == Some(true);
                return self.palette_push(link, window_id.unwrap_or_default(), json, new_tab);
            }
            _ => {}
        }
        for o in self.overlays.values().filter(|o| o.key.link == link && window_id.is_none_or(|w| o.key.window_id == w))
        {
            o.push(&mut self.out, json.clone());
        }
    }

    /// A palette for one window: to its overlay if that's shown; else held up to `palette_hold` and given to it as it
    /// shows, dropped after that.
    fn palette_push(&mut self, link: &str, window_id: i64, json: String, new_tab: bool) {
        let key = WindowKey::new(link, window_id);
        let bound = self.matches.contains_key(&key);
        if let Some(o) = self.overlays.get(&key)
            && o.shown
            && bound
        {
            return o.push(&mut self.out, json);
        }
        let why = if !self.overlays.contains_key(&key) {
            "no overlay drawn there"
        } else if !bound {
            "no overlay drawn there (its window isn't bound)"
        } else {
            "its overlay isn't shown yet"
        };
        let hold = self.opts.palette_hold;
        self.out.note(format!("palette push for window {window_id} ({key}): {why}: held {hold} s for it to show"));
        let new_tab = new_tab || self.held_palette.get(&key).is_some_and(|h| h.2);
        self.held_palette.insert(key, (json, self.now + hold, new_tab));
    }

    pub(crate) fn palette_dropped(&mut self, key: &WindowKey, new_tab: bool) {
        let hold = self.opts.palette_hold;
        let opens = if new_tab { "; its copy asked to open Margin's new-tab page there" } else { "" };
        self.out.note(format!(
            "palette push for window {} ({key}) dropped: no overlay was shown there within {hold} s{opens}",
            key.window_id
        ));
        let now = self.now;
        let Some(entry) = self.links.get_mut(&key.link) else { return };
        if entry.drawn.not_shown(key.window_id, now) {
            self.send_drawn(key, false, "a palette for it couldn't be shown");
        }
        if new_tab {
            let payload = json!({ "windowId": key.window_id, "newTab": true });
            self.ask(&key.link, "paletteDropped", payload, Some(key.window_id));
        }
    }

    /// An overlay just shown: a palette held for it, if it's still fresh.
    fn deliver_held_palette(&mut self, key: &WindowKey) {
        let Some((json, until, _)) = self.held_palette.remove(key) else { return };
        if self.now > until {
            return;
        }
        self.out.note(format!("palette push for {key}: given to its overlay as it showed"));
        if let Some(o) = self.overlays.get(key) {
            o.push(&mut self.out, json);
        }
    }

    // ---- the pointer ----

    /// The pointer at `at`: each shown overlay lets it through over its page slot and takes it elsewhere; a page that
    /// wants positions gets them (at most every `pointer_every`, the last of a run after it).
    pub(crate) fn pointer_moved(&mut self, at: Point, buttons: bool, from_track: bool) {
        let now = self.now;
        let every = self.opts.pointer_every;
        let keys: Vec<WindowKey> = self.overlays.iter().filter(|(_, o)| o.shown).map(|(k, _)| k.clone()).collect();
        for key in keys {
            let Some(o) = self.overlays.get_mut(&key) else { continue };
            let slot = o.slot();
            let ignore = PassThrough::decide(at, slot.as_ref(), buttons, o.ignoring);
            o.set_ignoring(&mut self.out, ignore);
            let frame = o.frame;
            if frame.contains(at) {
                self.pointer_inside.insert(key.clone());
                if from_track {
                    continue;
                }
                let local = Point::new(at.x - frame.min_x(), at.y - frame.min_y());
                if !o.pointer_want.wants(local, frame.width, frame.height) {
                    if self.pointer_wanted.remove(&key) {
                        push_pointer(o, &mut self.out, local);
                        self.last_pointer_push.insert(key.clone(), now);
                        self.last_pointer.insert(key.clone(), local);
                    }
                    continue;
                }
                self.pointer_wanted.insert(key.clone());
                if self.last_pointer.get(&key) == Some(&local) {
                    continue;
                }
                let last = self.last_pointer_push.get(&key).copied().unwrap_or(f64::NEG_INFINITY);
                if now - last >= every {
                    push_pointer(o, &mut self.out, local);
                    self.last_pointer_push.insert(key.clone(), now);
                    self.last_pointer.insert(key.clone(), local);
                } else {
                    self.trailing.entry(key.clone()).or_insert(last + every);
                }
            } else if self.pointer_inside.remove(&key) {
                self.pointer_wanted.remove(&key);
                let (x, y) = (at.x - frame.min_x(), at.y - frame.min_y());
                o.push(&mut self.out, json_text(&json!({ "type": "pointerLeft", "x": x, "y": y })));
            }
        }
    }

    /// A move skipped for the rate: the position the pointer rests at goes once the time's up.
    pub(crate) fn trail_pointer(&mut self, key: &WindowKey) {
        let Some((at, _)) = self.pointer else { return };
        let now = self.now;
        let Some(o) = self.overlays.get(key) else { return };
        if !o.shown {
            return;
        }
        let frame = o.frame;
        let local = Point::new(at.x - frame.min_x(), at.y - frame.min_y());
        if !frame.contains(at) || !o.pointer_want.wants(local, frame.width, frame.height) {
            return;
        }
        if self.last_pointer.get(key) == Some(&local) {
            return;
        }
        push_pointer(o, &mut self.out, local);
        self.last_pointer_push.insert(key.clone(), now);
        self.last_pointer.insert(key.clone(), local);
    }

    /// A press anywhere: a press on the page (or another app) takes the keyboard back from an overlay that had it; a
    /// field focused in an overlay not shown lets go.
    pub(crate) fn pressed(&mut self, at: Point) {
        for o in self.overlays.values_mut() {
            if o.has_keyboard && (!o.frame.contains(at) || PassThrough::page_gets(at, o.slot().as_ref())) {
                o.push(&mut self.out, r#"{"type":"pressOutside"}"#);
                o.hand_back(&mut self.out, "a press on the page or another app");
            }
        }
        for o in self.overlays.values_mut() {
            if o.page_wants_keyboard && !o.shown {
                o.let_go(&mut self.out, "a press while it wasn't shown");
            }
        }
        self.burst("press");
    }
}

fn push_pointer(o: &OverlayModel, out: &mut super::Out, local: Point) {
    o.push(out, json_text(&json!({ "type": "pointer", "x": local.x, "y": local.y })));
}

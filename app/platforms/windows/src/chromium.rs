//! Chrome and Edge on Windows for the hosted design (docs/HOSTED-WINDOWS-CHROMIUM.md §4.4), the OS-neutral half:
//!
//! - `bind`: which top-level window is the one a copy made for Margin. The copy's `newWindow { mark }` opens it at
//!   Margin's new-tab page titled `Margin <mark>`, and Chromium titles its window after its front tab, so the window is
//!   the one of the browser's process tree whose title has the mark. With no title match: the one new window (not there
//!   before the ask) at the bounds the copy answered, converted to pixels; anything less sure is no binding (the caller
//!   waits on the next window event, or gives up at its deadline and has the copy close the window).
//! - `launch_args`: the browser started by Margin when it isn't running: its profile's folder, and no window of its
//!   own (`--no-startup-window`: its copy links, then Margin asks for the window it wants).
//! - `quote`: an argument for a Windows command line, as `CommandLineToArgvW` reads it back.
//! - `profiles`: the profiles' folders and names from Chromium's `Local State` (read only).
//!
//! Tested on any OS; the window list and the process tree are the Win32 half's.

use std::collections::HashSet;

use margin_core::geometry::Rect;
use margin_core::hosted_browser::title_has_mark;

/// Chromium's top-level window class.
pub const WINDOW_CLASS: &str = "Chrome_WidgetWin_1";

/// A top-level window as the binder sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub hwnd: i64,
    /// Its process's browser main process (a Chromium browser's windows all belong to it).
    pub root: u32,
    pub class: String,
    pub title: String,
    /// Owned by another window, or a tool window: never a browser window of its own.
    pub owned: bool,
    pub visible: bool,
    /// Its visible frame, physical pixels.
    pub bounds: Rect,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Binding {
    Found(i64),
    /// Not yet: no window has the mark, and no single new window is at the answered bounds.
    NotYet,
    /// Several windows have the mark (it's random: a copy of Margin's page in another window?): none taken.
    Ambiguous(Vec<i64>),
}

/// The window a copy made for Margin, among `windows` of the browser whose main process is `root`. `before`: the
/// windows there before the ask; `answered`: the bounds the copy answered, in pixels, if any.
pub fn bind(windows: &[Candidate], root: u32, mark: &str, before: &HashSet<i64>, answered: Option<Rect>) -> Binding {
    let ours: Vec<&Candidate> =
        windows.iter().filter(|w| w.root == root && w.class == WINDOW_CLASS && !w.owned).collect();
    let marked: Vec<i64> = ours.iter().filter(|w| title_has_mark(&w.title, mark)).map(|w| w.hwnd).collect();
    match marked.len() {
        1 => return Binding::Found(marked[0]),
        n if n > 1 => return Binding::Ambiguous(marked),
        _ => {}
    }
    let Some(at) = answered else { return Binding::NotYet };
    let near = |a: &Rect| {
        // (Windows' invisible borders and rounding of DIPs: a few pixels either way.)
        let tol = 10.0;
        (a.x - at.x).abs() <= tol
            && (a.y - at.y).abs() <= tol
            && (a.width - at.width).abs() <= tol
            && (a.height - at.height).abs() <= tol
    };
    let fresh: Vec<i64> =
        ours.iter().filter(|w| !before.contains(&w.hwnd) && w.visible && near(&w.bounds)).map(|w| w.hwnd).collect();
    if fresh.len() == 1 { Binding::Found(fresh[0]) } else { Binding::NotYet }
}

/// The arguments that start a browser for Margin in a profile's folder, with no window of its own.
pub fn launch_args(profile_dir: &str) -> Vec<String> {
    vec![format!("--profile-directory={profile_dir}"), "--no-startup-window".into()]
}

/// One argument quoted for a Windows command line so `CommandLineToArgvW` gives it back exactly (backslashes doubled
/// only before a quote or the end).
pub fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.into();
    }
    let mut out = String::from("\"");
    let mut slashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

/// A whole command line: the program and its arguments, each quoted.
pub fn command_line(program: &str, args: &[String]) -> String {
    std::iter::once(quote(program)).chain(args.iter().map(|a| quote(a))).collect::<Vec<_>>().join(" ")
}

/// The profiles in Chromium's `Local State` (`profile.info_cache`): each folder and its name, sorted by folder. Read
/// only; anything missing is left out.
pub fn profiles(local_state: &str) -> Vec<(String, String)> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(local_state) else { return Vec::new() };
    let Some(cache) = v.pointer("/profile/info_cache").and_then(|c| c.as_object()) else { return Vec::new() };
    let mut out: Vec<(String, String)> = cache
        .iter()
        .filter(|(dir, _)| !dir.is_empty() && !dir.contains(['/', '\\']) && dir.as_str() != "..")
        .map(|(dir, p)| {
            (dir.clone(), p.get("name").and_then(|n| n.as_str()).unwrap_or(dir).chars().take(100).collect())
        })
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(hwnd: i64, root: u32, title: &str, bounds: Rect) -> Candidate {
        Candidate { hwnd, root, class: WINDOW_CLASS.into(), title: title.into(), owned: false, visible: true, bounds }
    }
    const AT: Rect = Rect::new(100.0, 80.0, 1280.0, 800.0);

    #[test]
    fn the_marked_window_of_its_browser() {
        let list = vec![
            win(1, 10, "Item page - Google Chrome", AT),
            win(2, 10, "Margin m1A2b3C4d5 - Google Chrome", AT),
            win(3, 20, "Margin m1A2b3C4d5 - Personal - Microsoft Edge", AT), // another browser's: not this one
        ];
        assert_eq!(bind(&list, 10, "m1A2b3C4d5", &HashSet::new(), None), Binding::Found(2));
        assert_eq!(bind(&list, 20, "m1A2b3C4d5", &HashSet::new(), None), Binding::Found(3));
        let mut owned = list.clone();
        owned[1].owned = true;
        assert_eq!(bind(&owned, 10, "m1A2b3C4d5", &HashSet::new(), None), Binding::NotYet, "an owned window never");
        let mut twice = list.clone();
        twice[0].title = "Margin m1A2b3C4d5 - Google Chrome".into();
        assert_eq!(bind(&twice, 10, "m1A2b3C4d5", &HashSet::new(), None), Binding::Ambiguous(vec![1, 2]));
    }

    #[test]
    fn with_no_title_the_one_new_window_at_the_answered_bounds() {
        let list = vec![
            win(1, 10, "Old - Google Chrome", AT),
            win(2, 10, "New Tab - Google Chrome", Rect::new(104.0, 80.0, 1276.0, 806.0)),
        ];
        let before: HashSet<i64> = [1].into();
        assert_eq!(bind(&list, 10, "m1A2b3C4d5", &before, Some(AT)), Binding::Found(2));
        assert_eq!(
            bind(&list, 10, "m1A2b3C4d5", &HashSet::new(), Some(AT)),
            Binding::NotYet,
            "two new at those bounds: not sure"
        );
        assert_eq!(bind(&list, 10, "m1A2b3C4d5", &before, None), Binding::NotYet);
        let far = Rect::new(600.0, 80.0, 1280.0, 800.0);
        assert_eq!(bind(&list, 10, "m1A2b3C4d5", &before, Some(far)), Binding::NotYet);
    }

    #[test]
    fn quoted_as_command_line_to_argv_reads_it() {
        assert_eq!(quote("plain"), "plain");
        assert_eq!(quote(""), "\"\"");
        assert_eq!(
            quote("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"),
            "\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\""
        );
        assert_eq!(quote("--profile-directory=Profile 1"), "\"--profile-directory=Profile 1\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote("dir\\ end\\"), "\"dir\\ end\\\\\"");
        assert_eq!(quote("x\\\\\"y"), "\"x\\\\\\\\\\\"y\"");
        assert_eq!(
            command_line("C:\\Apps\\chrome.exe", &launch_args("Profile 2")),
            "C:\\Apps\\chrome.exe \"--profile-directory=Profile 2\" --no-startup-window"
        );
    }

    #[test]
    fn profiles_from_local_state() {
        let text = r#"{ "profile": { "info_cache": {
            "Default": { "name": "Personal" },
            "Profile 1": { "name": "Work" },
            "Profile 2": {},
            "..": { "name": "x" },
            "a\\b": { "name": "y" }
        } } }"#;
        assert_eq!(
            profiles(text),
            vec![
                ("Default".into(), "Personal".into()),
                ("Profile 1".into(), "Work".into()),
                ("Profile 2".into(), "Profile 2".into())
            ]
        );
        assert!(profiles("{}").is_empty());
        assert!(profiles("not json").is_empty());
    }
}

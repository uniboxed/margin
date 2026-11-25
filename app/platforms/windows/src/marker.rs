//! What Margin did to other apps' windows, kept on disk so a crash never leaves them changed
//! (docs/HOSTED-WINDOWS-CHROMIUM.md §4.6): `%LOCALAPPDATA%\Margin\hosted.json`, written atomically whenever a window
//! is first hosted or something about it that would need undoing changes (hidden, its taskbar button removed); never on
//! a placement alone. At the next start, before anything else, each record whose window still belongs to the same
//! process (the same id and start time: a window number can be used again by another process) is given back as it was
//! found; any other is dropped, never touched. OS-neutral and tested on any OS; the Win32 reads are the caller's.

use std::io;
use std::path::Path;

use margin_core::geometry::Rect;
use serde::{Deserialize, Serialize};

pub const FILE: &str = "hosted.json";
const VERSION: u32 = 1;

/// How a window was shown before Margin touched it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Show {
    #[default]
    Normal,
    Maximized,
    Minimized,
    Hidden,
}

/// A window's placement as Windows keeps it (`GetWindowPlacement`): its normal frame (physical pixels, as
/// `rcNormalPosition`) and how it was shown.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Kept {
    pub normal: Rect,
    pub show: Show,
}

/// One window Margin hosts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// margin-core's host id.
    pub host: String,
    pub hwnd: i64,
    pub pid: u32,
    /// Its process's start (`GetProcessTimes`' creation time, 100 ns since 1601): with the pid, the process itself.
    pub started: u64,
    /// As it was before Margin touched it (None: Margin made it).
    #[serde(default)]
    pub kept: Option<Kept>,
    #[serde(default)]
    pub taskbar_removed: bool,
    /// Hidden by Margin (parked) when this was written.
    #[serde(default)]
    pub hidden: bool,
    /// A browser window a copy made for Margin: its link and window id (closed by that copy once it links again).
    #[serde(default)]
    pub browser_window: Option<(String, i64)>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    pub v: u32,
    pub records: Vec<Record>,
}

impl Marker {
    pub fn new(records: Vec<Record>) -> Self {
        Self { v: VERSION, records }
    }

    /// The marker in `dir`, or none (no file, another version, unreadable: nothing to give back).
    pub fn read(dir: &Path) -> Option<Marker> {
        let text = std::fs::read_to_string(dir.join(FILE)).ok()?;
        serde_json::from_str::<Marker>(&text).ok().filter(|m| m.v == VERSION)
    }

    /// Written atomically (a crash mid-write leaves the one before); with no record, the file removed.
    pub fn write(&self, dir: &Path) -> io::Result<()> {
        let path = dir.join(FILE);
        if self.records.is_empty() {
            return match std::fs::remove_file(&path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            };
        }
        let text = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        margin_core::data::store::write_atomically(&text, &path)
    }
}

/// What to do with one record at the next start.
#[derive(Clone, Debug, PartialEq)]
pub enum Recover {
    /// The window is still that process's: put it back as kept (shown again if Margin hid it, its taskbar button
    /// back).
    GiveBack(Record),
    /// A browser window a copy made for Margin: left for that copy to close once it links (never closed blind).
    CloseByCopy(Record),
    /// Gone, or not that process's any more: nothing touched.
    Drop(Record),
}

/// The start's plan for a marker: `owner(hwnd)` is the window's process now and that process's start (None: no such
/// window).
pub fn recover(marker: &Marker, owner: impl Fn(i64) -> Option<(u32, u64)>) -> Vec<Recover> {
    marker
        .records
        .iter()
        .cloned()
        .map(|r| match owner(r.hwnd) {
            Some((pid, started)) if pid == r.pid && started == r.started => {
                if r.browser_window.is_some() && r.kept.is_none() {
                    Recover::CloseByCopy(r)
                } else {
                    Recover::GiveBack(r)
                }
            }
            _ => Recover::Drop(r),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(host: &str, hwnd: i64, pid: u32, started: u64) -> Record {
        Record {
            host: host.into(),
            hwnd,
            pid,
            started,
            kept: Some(Kept { normal: Rect::new(100.0, 100.0, 800.0, 600.0), show: Show::Maximized }),
            taskbar_removed: true,
            hidden: true,
            browser_window: None,
        }
    }

    #[test]
    fn written_read_back_and_removed_when_empty() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(Marker::read(dir.path()), None);
        let m = Marker::new(vec![record("app:notepad", 0x1234, 42, 7)]);
        m.write(dir.path()).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(Marker::read(dir.path()), Some(m));
        Marker::new(vec![]).write(dir.path()).unwrap_or_else(|e| panic!("{e}"));
        assert!(!dir.path().join(FILE).exists());
        Marker::new(vec![]).write(dir.path()).unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(dir.path().join(FILE), b"{\"v\":9,\"records\":[]}").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(Marker::read(dir.path()), None, "another version: nothing given back");
        std::fs::write(dir.path().join(FILE), b"not json").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(Marker::read(dir.path()), None);
    }

    #[test]
    fn only_a_window_still_its_processs_is_given_back() {
        let mut made = record("chrome:p-1", 0x30, 9, 5);
        made.kept = None;
        made.browser_window = Some(("chrome:p-1".into(), 77));
        let m = Marker::new(vec![
            record("app:notepad", 0x10, 42, 7),
            record("app:paint", 0x20, 43, 8),
            record("app:calc", 0x40, 44, 9),
            made.clone(),
        ]);
        let plan = recover(&m, |hwnd| match hwnd {
            0x10 => Some((42, 7)),  // the same process
            0x20 => Some((43, 99)), // the same pid, another process (restarted): never touched
            0x30 => Some((9, 5)),
            _ => None, // gone
        });
        assert_eq!(plan[0], Recover::GiveBack(m.records[0].clone()));
        assert_eq!(plan[1], Recover::Drop(m.records[1].clone()));
        assert_eq!(plan[2], Recover::Drop(m.records[2].clone()));
        assert_eq!(plan[3], Recover::CloseByCopy(made));
    }
}

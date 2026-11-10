//! A simple file log in `%LOCALAPPDATA%\Margin\logs` (OS-neutral, tested on the Mac): one line per note, UTC
//! time first, kept to about 1 MiB (`<name>.log`, then renamed to `<name>.1.log` and started again: at most
//! about 2 MiB on disk). Lines are written on a thread of their own, so a note never blocks the UI thread.
//!
//! It writes only what it's given: callers never pass addresses, titles or page contents (as the Mac's
//! Diagnostics). Lines are cut at 2000 characters and kept to one line.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// About where a log file is rotated.
pub const MAX_BYTES: u64 = 1024 * 1024;
const MAX_LINE: usize = 2000;

enum Cmd {
    Line(String),
    Flush(Sender<()>),
}

static LOG: OnceLock<Mutex<Sender<Cmd>>> = OnceLock::new();

/// Starts the log in `dir` as `<name>.log` (`margin` for the app). Only the first call
/// counts. Notes made before it go to stderr only.
pub fn init(dir: &Path, name: &str) {
    let mut file = FileLog::new(dir, name, MAX_BYTES);
    let (tx, rx) = mpsc::channel::<Cmd>();
    if LOG.set(Mutex::new(tx)).is_err() {
        return;
    }
    let spawned = std::thread::Builder::new().name("margin-log".into()).spawn(move || {
        for cmd in rx {
            match cmd {
                Cmd::Line(line) => file.write_line(&line),
                Cmd::Flush(done) => {
                    let _ = done.send(());
                }
            }
        }
    });
    if spawned.is_err() {
        eprintln!("margin: the log's thread didn't start: notes go to stderr only");
    }
}

pub fn note(text: impl AsRef<str>) {
    write("note", text.as_ref());
}

pub fn warn(text: impl AsRef<str>) {
    write("warn", text.as_ref());
}

/// Waits (at most a second) until every note made so far is on disk: before the process exits.
pub fn flush() {
    let Some(log) = LOG.get() else { return };
    let (tx, rx) = mpsc::channel();
    if log.lock().map(|s| s.send(Cmd::Flush(tx)).is_ok()).unwrap_or(false) {
        let _ = rx.recv_timeout(Duration::from_secs(1));
    }
}

fn write(level: &str, text: &str) {
    let line = format_line(SystemTime::now(), level, text);
    match LOG.get() {
        Some(log) => {
            let sent = log.lock().map(|s| s.send(Cmd::Line(line.clone())).is_ok()).unwrap_or(false);
            if !sent {
                eprintln!("{line}");
            }
        }
        None => eprintln!("{line}"),
    }
}

/// `2026-11-09 12:34:56.789Z [note] text`, on one line, at most `MAX_LINE` characters of text.
pub fn format_line(at: SystemTime, level: &str, text: &str) -> String {
    let one: String = text.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).take(MAX_LINE).collect();
    format!("{} [{level}] {one}", timestamp(at))
}

/// UTC, to the millisecond.
pub fn timestamp(at: SystemTime) -> String {
    let d = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    let (y, m, dd) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{dd:02} {:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        d.subsec_millis()
    )
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// The file itself: appended to, rotated once it's `max` bytes or more. Other processes may append to the
/// same file: the size is read from the file, so whoever crosses `max` rotates.
pub struct FileLog {
    path: PathBuf,
    rotated: PathBuf,
    max: u64,
    file: Option<File>,
}

impl FileLog {
    pub fn new(dir: &Path, name: &str, max: u64) -> Self {
        Self { path: dir.join(format!("{name}.log")), rotated: dir.join(format!("{name}.1.log")), max, file: None }
    }

    pub fn write_line(&mut self, line: &str) {
        if self.file.is_none() {
            self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        }
        let Some(file) = self.file.as_mut() else { return };
        let mut bytes = Vec::with_capacity(line.len() + 2);
        bytes.extend_from_slice(line.as_bytes());
        bytes.extend_from_slice(if cfg!(windows) { b"\r\n" } else { b"\n" });
        if file.write_all(&bytes).is_err() {
            self.file = None;
            return;
        }
        if file.metadata().map(|m| m.len() >= self.max).unwrap_or(false) {
            self.file = None;
            let _ = std::fs::rename(&self.path, &self.rotated);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_format() {
        let at = UNIX_EPOCH + Duration::from_millis(1_762_689_296_789);
        assert_eq!(format_line(at, "note", "a\nb"), "2025-11-09 11:54:56.789Z [note] a b");
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01 00:00:00.000Z");
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }

    #[test]
    fn long_lines_are_cut() {
        let line = format_line(UNIX_EPOCH, "warn", &"x".repeat(5000));
        assert_eq!(line.matches('x').count(), MAX_LINE);
    }

    #[test]
    fn rotates_at_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = FileLog::new(dir.path(), "t", 100);
        for i in 0..7 {
            log.write_line(&format!("line {i:02} ........"));
        }
        let now = std::fs::read_to_string(dir.path().join("t.log")).unwrap();
        let old = std::fs::read_to_string(dir.path().join("t.1.log")).unwrap();
        assert!(old.len() >= 100 && now.len() < 100, "{} {}", old.len(), now.len());
        assert!(now.contains("line 06") && !now.contains("line 05"));
    }
}

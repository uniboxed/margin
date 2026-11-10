//! Where Margin keeps things on Windows, and the names of its per-user kernel objects. The building is
//! OS-neutral and tested on the Mac; only finding `%LOCALAPPDATA%` is Windows'.
//!
//! Everything is under `%LOCALAPPDATA%\Margin`: `data` (the lasting data), `themes` (imported themes), `logs`,
//! `WebView2` (the overlay's web view's user data folder) and `NativeMessagingHosts` (the host manifest).

use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    pub root: PathBuf,
    pub data: PathBuf,
    pub themes: PathBuf,
    pub logs: PathBuf,
    pub webview2: PathBuf,
    pub hosts: PathBuf,
}

impl Paths {
    /// The folders under this `%LOCALAPPDATA%`.
    pub fn under(local_app_data: &Path) -> Self {
        let root = local_app_data.join("Margin");
        Self {
            data: root.join("data"),
            themes: root.join("themes"),
            logs: root.join("logs"),
            webview2: root.join("WebView2"),
            hosts: root.join("NativeMessagingHosts"),
            root,
        }
    }

    /// Makes every folder (those already there are left as they are).
    pub fn create_all(&self) -> std::io::Result<()> {
        for dir in [&self.root, &self.data, &self.themes, &self.logs, &self.webview2, &self.hosts] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    /// The paths for this user, or `None` when Windows gave no `%LOCALAPPDATA%`.
    #[cfg(windows)]
    pub fn for_user() -> Option<Self> {
        local_app_data().map(|p| Self::under(&p))
    }
}

/// The overlay page's files (`npm run build`'s `dist/app/`), in a folder `app` beside `margin.exe`.
pub fn overlay_dir(exe: &Path) -> PathBuf {
    exe.parent().unwrap_or(Path::new(".")).join("app")
}

/// The app's named pipe, one per user: `\\.\pipe\Margin-<SID>`.
pub fn pipe_name(sid: &str) -> String {
    format!(r"\\.\pipe\Margin-{sid}")
}

/// The single-instance mutex, in this session's namespace: `Local\Margin-<SID>`.
pub fn mutex_name(sid: &str) -> String {
    format!(r"Local\Margin-{sid}")
}

/// The pipe's security descriptor: a protected DACL (nothing inherited) giving this user, and no one else,
/// full access. SYSTEM and Administrators aren't listed: the pipe is only ever opened by this user's relay.
pub fn pipe_sddl(sid: &str) -> String {
    format!("D:P(A;;GA;;;{sid})")
}

/// Whether two Win32 paths name the same file, as far as their text says: case-insensitive, `/` taken as
/// `\`, and a `\\?\` prefix ignored (QueryFullProcessImageNameW and GetModuleFileNameW give the same form
/// for the same file, but one of them may carry the prefix). Short (8.3) names and links aren't resolved.
pub fn same_file_path(a: &str, b: &str) -> bool {
    fn norm(p: &str) -> String {
        let p = p.replace('/', "\\");
        let p = p.strip_prefix(r"\\?\").unwrap_or(&p);
        p.trim_end_matches('\\').to_lowercase()
    }
    !a.is_empty() && norm(a) == norm(b)
}

/// The last part of a Win32 path (the executable's name), lowercase.
pub fn file_name_lower(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase()
}

#[cfg(windows)]
pub fn local_app_data() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_LocalAppData, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
    // SAFETY: FOLDERID_LocalAppData is a valid GUID for the call's lifetime; on success the returned string is
    // CoTaskMem-allocated, read once and freed here (also when it isn't valid UTF-16).
    let known = unsafe {
        match SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, None) {
            Ok(p) => {
                let s = p.to_string().ok();
                CoTaskMemFree(Some(p.0 as *const _));
                s
            }
            Err(_) => None,
        }
    };
    known.filter(|s| !s.is_empty()).map(PathBuf::from).or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders() {
        let base = Path::new("base");
        let p = Paths::under(base);
        assert_eq!(p.root, base.join("Margin"));
        assert_eq!(p.data, base.join("Margin").join("data"));
        assert_eq!(p.webview2, base.join("Margin").join("WebView2"));
        assert_eq!(p.hosts, base.join("Margin").join("NativeMessagingHosts"));
    }

    #[test]
    fn create_all_makes_them() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::under(dir.path());
        p.create_all().unwrap();
        p.create_all().unwrap();
        assert!(p.logs.is_dir() && p.themes.is_dir());
    }

    #[test]
    fn names() {
        assert_eq!(pipe_name("S-1-5-21-1-2-3-1001"), r"\\.\pipe\Margin-S-1-5-21-1-2-3-1001");
        assert_eq!(mutex_name("S-1-5-21-1"), r"Local\Margin-S-1-5-21-1");
        assert_eq!(pipe_sddl("S-1-5-21-1"), "D:P(A;;GA;;;S-1-5-21-1)");
    }

    #[test]
    fn same_paths() {
        assert!(same_file_path(r"C:\Program Files\Margin\margin.exe", r"c:\program files\margin\MARGIN.EXE"));
        assert!(same_file_path(r"\\?\C:\Margin\margin.exe", r"C:/Margin/margin.exe"));
        assert!(!same_file_path(r"C:\Margin\margin.exe", r"C:\Other\margin.exe"));
        assert!(!same_file_path("", ""));
    }

    #[test]
    fn file_names() {
        assert_eq!(file_name_lower(r"C:\Program Files\Google\Chrome\Application\chrome.exe"), "chrome.exe");
        assert_eq!(file_name_lower("msedge.exe"), "msedge.exe");
    }

    #[test]
    fn overlay_beside_the_exe() {
        assert_eq!(overlay_dir(Path::new("dir").join("margin.exe").as_path()), Path::new("dir").join("app"));
    }
}

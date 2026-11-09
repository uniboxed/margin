//! The connector on the Mac and Linux: the app's Unix socket (only this user may open it; Margin.app also checks
//! the connector's code signature: RelayLink.swift), the browser it was started by (its parent process), the
//! app started in the background, and host files as files in each browser's folder.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Where the app listens: the Mac's ~/Library/Application Support/Margin/connector.sock; Linux's, in the
/// user's runtime folder.
pub fn socket_path() -> String {
    if cfg!(target_os = "macos") {
        return home().join("Library/Application Support/Margin/connector.sock").to_string_lossy().into_owned();
    }
    let base = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".local/share"));
    base.join("margin/connector.sock").to_string_lossy().into_owned()
}

pub fn connect(path: &str) -> Option<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    let stream = UnixStream::connect(path).ok()?;
    let reader = stream.try_clone().ok()?;
    Some((Box::new(reader), Box::new(stream)))
}

/// The browser that started it, and its process: the parent (the browser's own process starts native hosts).
pub fn browser_and_pid() -> (String, u32) {
    let parent = std::os::unix::process::parent_id();
    // Its program's own name only (Microsoft Edge, msedge), never a folder above it.
    let path = process_path(parent).unwrap_or_default();
    let name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    (if name.contains("edge") { "edge" } else { "chrome" }.to_string(), parent)
}

#[cfg(target_os = "macos")]
fn process_path(pid: u32) -> Option<String> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is PROC_PIDPATHINFO_MAXSIZE bytes, as the call needs; it writes at most that and says how many.
    let n = unsafe { libc::proc_pidpath(pid as i32, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&buffer[..n as usize]).into_owned())
}

#[cfg(not(target_os = "macos"))]
fn process_path(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok().map(|p| p.to_string_lossy().into_owned())
}

/// Margin.app (…/Margin.app/Contents/Helpers/margin-connector → Margin.app), opened in the background, never
/// activated (as Safari's handler opens it). False where there's no app to start (Linux has none yet).
pub fn launch_app() -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let Some(app) = exe.ancestors().nth(3) else { return false };
    if !cfg!(target_os = "macos") || app.extension().and_then(|e| e.to_str()) != Some("app") {
        return false;
    }
    std::process::Command::new("/usr/bin/open")
        .arg("-g")
        .arg(app)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
}

/// The host files, one in each installed Chromium browser's folder: under ~/Library/Application Support on the
/// Mac, ~/.config on Linux (`support`: another root, for the tests).
pub fn install(connector: &Path, support: Option<&Path>) -> Result<Vec<String>, String> {
    let linux = !cfg!(target_os = "macos");
    let root = support.map(Path::to_path_buf).unwrap_or_else(|| {
        if linux {
            std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config"))
        } else {
            home().join("Library/Application Support")
        }
    });
    let files = margin_chromium::host_files(&root, linux);
    let written =
        margin_chromium::write_host_files(&files, &margin_chromium::manifest(connector)).map_err(|e| e.to_string())?;
    Ok(written.iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

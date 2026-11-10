//! The connector on Windows: the app's named pipe (this user only; each end checks the other: the app that its client
//! is `margin-connector.exe` beside `margin.exe`, the connector here that the pipe's server is that `margin.exe`:
//! app/platforms/windows/src/pipe.rs), the browser that started it (Chrome and Edge start hosts through cmd.exe: the first
//! ancestor that isn't), the app started detached, inheriting none of the browser's handles (so the browser's
//! port never hangs on the app), and host files as one file named in each browser's registry key.
//!
//! The pipe carries these JSON lines as the Mac's Unix socket does (margin-core `relay` on the app's side); the
//! link itself is the copy's WebSocket to the app, on Windows as on the Mac. Not yet run on Windows
//! (docs/windows/UNVERIFIED.md).

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use margin_windows::pipe::Pipe;
use windows::Win32::System::Registry::HKEY_CURRENT_USER;
use windows::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CreateProcessW, DETACHED_PROCESS, PROCESS_CREATION_FLAGS,
    PROCESS_INFORMATION, STARTUPINFOW,
};
use windows::core::{HSTRING, PCWSTR, PWSTR};

// margin.exe, beside the connector.
fn app_exe() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|dir| dir.join("margin.exe"))
}

pub fn socket_path() -> String {
    margin_windows::security::current_user_sid().map(|sid| margin_windows::paths::pipe_name(&sid)).unwrap_or_default()
}

struct PipeRead(Arc<Pipe>);
impl Read for PipeRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read_some(buf, u32::MAX)
    }
}
struct PipeWrite(Arc<Pipe>);
impl Write for PipeWrite {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write_some(buf, 5000)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn connect(path: &str) -> Option<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    let exe = app_exe()?;
    let pipe = Arc::new(margin_windows::pipe::connect(path, &exe.to_string_lossy()).ok()?);
    Some((Box::new(PipeRead(pipe.clone())), Box::new(PipeWrite(pipe))))
}

pub fn browser_and_pid() -> (String, u32) {
    match margin_windows::process::ancestor_not_named(std::process::id(), &["cmd.exe"], 3) {
        Some((pid, name)) => (if name.to_lowercase().contains("msedge") { "edge" } else { "chrome" }.to_string(), pid),
        None => ("chrome".to_string(), 0),
    }
}

pub fn launch_app() -> bool {
    let Some(exe) = app_exe() else { return false };
    let exe = exe.to_string_lossy().into_owned();
    let dir = Path::new(&exe).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    // A job that doesn't allow breaking away refuses the flag: started inside it then.
    create_process(&exe, &dir, base | CREATE_BREAKAWAY_FROM_JOB).or_else(|_| create_process(&exe, &dir, base)).is_ok()
}

fn create_process(exe: &str, dir: &str, flags: PROCESS_CREATION_FLAGS) -> Result<(), String> {
    let app = HSTRING::from(exe);
    // CreateProcessW may write into the command line: a buffer of our own, null-terminated.
    let mut command: Vec<u16> = format!("\"{exe}\"").encode_utf16().chain(std::iter::once(0)).collect();
    let cwd = HSTRING::from(dir);
    let si = STARTUPINFOW { cb: size_of::<STARTUPINFOW>() as u32, ..Default::default() };
    let mut pi = PROCESS_INFORMATION::default();
    // SAFETY: every string is null-terminated and alive for the call; `command` is a mutable buffer as the call
    // requires; bInheritHandles is false, so the browser's pipes stay the connector's alone.
    unsafe {
        CreateProcessW(
            &app,
            Some(PWSTR(command.as_mut_ptr())),
            None,
            None,
            false,
            flags,
            None,
            if dir.is_empty() { PCWSTR::null() } else { PCWSTR(cwd.as_ptr()) },
            &si,
            &mut pi,
        )
    }
    .map_err(|e| e.to_string())?;
    // SAFETY: CreateProcessW gave both handles to us: closed at once (the app runs on).
    unsafe {
        let _ = windows::Win32::Foundation::CloseHandle(pi.hProcess);
        let _ = windows::Win32::Foundation::CloseHandle(pi.hThread);
    }
    Ok(())
}

/// The host file in the user's Margin folder, named by each Chromium browser's registry key.
pub fn install(connector: &Path, support: Option<&Path>) -> Result<Vec<String>, String> {
    let root = support
        .map(Path::to_path_buf)
        .or_else(margin_windows::paths::local_app_data)
        .ok_or("no local app data folder")?;
    let file = root.join("Margin").join(format!("{}.json", margin_chromium::HOST_NAME));
    let mut written: Vec<String> =
        margin_chromium::write_host_files(std::slice::from_ref(&file), &margin_chromium::manifest(connector))
            .map_err(|e| e.to_string())?
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
    for key in margin_chromium::windows_keys() {
        margin_windows::win::RegKey::create(HKEY_CURRENT_USER, &key)?.set_string(None, &file.to_string_lossy())?;
        written.push(format!(r"HKEY_CURRENT_USER\{key}"));
    }
    Ok(written)
}

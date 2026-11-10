//! Other processes: their executable's path, their parent, when they started. Windows only.

use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::core::PWSTR;

use crate::win::{Handle, from_wide};

fn open(pid: u32) -> Option<Handle> {
    // SAFETY: OpenProcess has no memory arguments; the handle it returns is owned by the Handle.
    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok().and_then(|h| Handle::new(h)) }
}

/// The full Win32 path of a process's executable (`C:\…\chrome.exe`). PROCESS_QUERY_LIMITED_INFORMATION is
/// enough, and is granted for this user's processes at the same or lower integrity.
pub fn image_path(pid: u32) -> Option<String> {
    let process = open(pid)?;
    let mut buf = vec![0u16; 32_768];
    let mut size = buf.len() as u32;
    // SAFETY: `buf` holds `size` UTF-16 units, as the call is told; the handle is open for this query.
    unsafe { QueryFullProcessImageNameW(process.raw(), PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size) }
        .ok()?;
    buf.truncate(size as usize);
    Some(from_wide(&buf))
}

/// When a process started (FILETIME as one number: 100 ns since 1601).
pub fn started_at(pid: u32) -> Option<u64> {
    let process = open(pid)?;
    let (mut created, mut exited, mut kernel, mut user) =
        (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: four FILETIME out-parameters; the handle is open for PROCESS_QUERY_LIMITED_INFORMATION.
    unsafe { GetProcessTimes(process.raw(), &mut created, &mut exited, &mut kernel, &mut user) }.ok()?;
    Some(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

/// The parent's pid as Windows recorded it at this process's start, and the parent's executable name.
/// The parent may have exited since and its pid been reused: `ancestor_not_named` checks start times.
pub fn parent(pid: u32) -> Option<(u32, String)> {
    // SAFETY: a process snapshot; the handle is owned by the Handle and closed when it drops.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok().and_then(|h| Handle::new(h)) }?;
    let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    // SAFETY: `entry` is a PROCESSENTRY32W with dwSize set, as Process32FirstW/NextW require.
    let mut ok = unsafe { Process32FirstW(snapshot.raw(), &mut entry) }.is_ok();
    let mut parent_pid = None;
    while ok {
        if entry.th32ProcessID == pid {
            parent_pid = Some(entry.th32ParentProcessID);
            break;
        }
        // SAFETY: as above.
        ok = unsafe { Process32NextW(snapshot.raw(), &mut entry) }.is_ok();
    }
    let parent_pid = parent_pid?;
    // A second walk for the parent's name (the snapshot is a fixed list: walking it again is cheap).
    // SAFETY: as above.
    let mut ok = unsafe { Process32FirstW(snapshot.raw(), &mut entry) }.is_ok();
    while ok {
        if entry.th32ProcessID == parent_pid {
            return Some((parent_pid, from_wide(&entry.szExeFile).to_lowercase()));
        }
        // SAFETY: as above.
        ok = unsafe { Process32NextW(snapshot.raw(), &mut entry) }.is_ok();
    }
    None
}

/// The nearest ancestor of `pid` whose executable isn't one of `skip` (lowercase file names), at most
/// `depth` levels up: Chrome starts its native hosts through `cmd.exe /d /c`, so the relay's parent is
/// `cmd.exe` and the browser is its parent. Each ancestor must have started before its child, or its pid was
/// reused by an unrelated process after the real parent exited: then `None`.
pub fn ancestor_not_named(pid: u32, skip: &[&str], depth: usize) -> Option<(u32, String)> {
    let mut child = pid;
    let mut child_started = started_at(pid);
    for _ in 0..depth {
        let (p, name) = parent(child)?;
        let started = started_at(p);
        if let (Some(c), Some(s)) = (child_started, started) {
            if s > c {
                return None;
            }
        }
        if !skip.contains(&name.as_str()) {
            return Some((p, name));
        }
        child = p;
        child_started = started;
    }
    None
}

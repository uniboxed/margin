//! Other processes: their executable's path, their parent, when they started, their integrity level. Windows only.

use windows::Win32::Foundation::{FILETIME, HANDLE};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    TokenIntegrityLevel,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
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
/// `depth` levels up: Chrome starts its native hosts through `cmd.exe /d /c`, so the connector's parent is
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

/// A process's integrity level: its token's mandatory label's last sub-authority (0x2000 medium, 0x3000 high: an app
/// run as administrator, 0x4000 system). None: its token can't be read (often itself a sign of a higher level).
pub fn integrity(pid: u32) -> Option<u32> {
    let process = open(pid)?;
    token_integrity(process.raw())
}

/// This process's own integrity level.
pub fn own_integrity() -> Option<u32> {
    // SAFETY: the current-process pseudo handle needs no closing.
    token_integrity(unsafe { GetCurrentProcess() })
}

fn token_integrity(process: HANDLE) -> Option<u32> {
    let mut token = HANDLE::default();
    // SAFETY: `process` is open for PROCESS_QUERY_LIMITED_INFORMATION (or the pseudo handle); `token` is an out-parameter.
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
    // SAFETY: OpenProcessToken succeeded: the token handle is ours to close.
    let token = unsafe { Handle::new(token) }?;
    let mut size = 0u32;
    // SAFETY: a size query (no buffer): it fails with ERROR_INSUFFICIENT_BUFFER and sets `size`.
    let _ = unsafe { GetTokenInformation(token.raw(), TokenIntegrityLevel, None, 0, &mut size) };
    if size == 0 || size > 4096 {
        return None;
    }
    // u64s keep the buffer aligned for TOKEN_MANDATORY_LABEL (pointer-aligned).
    let mut buf = vec![0u64; (size as usize).div_ceil(8)];
    // SAFETY: `buf` holds at least `size` bytes, as the call is told.
    unsafe { GetTokenInformation(token.raw(), TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut _), size, &mut size) }
        .ok()?;
    // SAFETY: GetTokenInformation(TokenIntegrityLevel) filled `buf` with a TOKEN_MANDATORY_LABEL whose SID points into
    // `buf`, alive for the reads below; the sub-authority index is within the count the SID says it has.
    unsafe {
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, (count - 1) as u32))
    }
}

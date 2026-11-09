//! Small Win32 helpers the other modules share: an owned kernel handle, an owned registry key, wide strings,
//! and errors as text. Windows only.

use std::path::PathBuf;

use windows::Win32::Foundation::{CloseHandle, HANDLE, WIN32_ERROR};
use windows::Win32::System::Registry::{
    HKEY, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE, RegCloseKey,
    RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
};
use windows::core::{HSTRING, PCWSTR};

/// A kernel handle, closed when dropped. Kernel handles may be used from any thread, so it's `Send + Sync`.
#[derive(Debug)]
pub struct Handle(HANDLE);

// SAFETY: a kernel object handle is a process-wide value that Windows lets any thread use and close.
unsafe impl Send for Handle {}
// SAFETY: as above: every call this crate makes with a shared handle is itself thread-safe in Windows.
unsafe impl Sync for Handle {}

impl Handle {
    /// Takes ownership of `h`. `None` for a null or INVALID_HANDLE_VALUE handle.
    ///
    /// # Safety
    /// `h` must be a handle this process owns and nothing else closes.
    pub unsafe fn new(h: HANDLE) -> Option<Self> {
        (!h.is_invalid()).then_some(Self(h))
    }

    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle is owned (Handle::new's contract) and closed only here, once.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// An open registry key, closed when dropped.
pub struct RegKey(HKEY);

impl Drop for RegKey {
    fn drop(&mut self) {
        // SAFETY: the key was opened by RegKey::create/open and is closed only here, once.
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

fn win32(e: WIN32_ERROR) -> Result<(), String> {
    if e.is_ok() { Ok(()) } else { Err(error_text(e.to_hresult().into())) }
}

impl RegKey {
    /// Opens `subkey` of `root` for writing, making it (and its parents) if it isn't there.
    pub fn create(root: HKEY, subkey: &str) -> Result<Self, String> {
        let mut key = HKEY::default();
        // SAFETY: `subkey` is a null-terminated HSTRING alive for the call; `key` is an out-parameter.
        let e = unsafe {
            RegCreateKeyExW(
                root,
                &HSTRING::from(subkey),
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE | KEY_QUERY_VALUE,
                None,
                &mut key,
                None,
            )
        };
        win32(e).map(|_| Self(key))
    }

    /// Opens `subkey` of `root` for reading and writing; `None` if it isn't there (or can't be opened).
    pub fn open(root: HKEY, subkey: &str) -> Option<Self> {
        let mut key = HKEY::default();
        // SAFETY: as in `create`.
        let e = unsafe { RegOpenKeyExW(root, &HSTRING::from(subkey), None, KEY_SET_VALUE | KEY_QUERY_VALUE, &mut key) };
        e.is_ok().then_some(Self(key))
    }

    /// Sets a REG_SZ value (`None`: the key's default value).
    pub fn set_string(&self, name: Option<&str>, value: &str) -> Result<(), String> {
        let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: REG_SZ data is the UTF-16 string with its null terminator, as bytes, alive for the call.
        let bytes = unsafe { std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2) };
        let name = name.map(HSTRING::from);
        let name_ptr = name.as_ref().map(|n| PCWSTR(n.as_ptr())).unwrap_or(PCWSTR::null());
        // SAFETY: the key is open for KEY_SET_VALUE; `name_ptr` is null or a live null-terminated string.
        win32(unsafe { RegSetValueExW(self.0, name_ptr, None, REG_SZ, Some(bytes)) })
    }

    /// A REG_SZ value, `None` if it isn't there or isn't a string.
    pub fn get_string(&self, name: Option<&str>) -> Option<String> {
        let name = name.map(HSTRING::from);
        let name_ptr = name.as_ref().map(|n| PCWSTR(n.as_ptr())).unwrap_or(PCWSTR::null());
        let mut kind = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        // SAFETY: a size query: no data pointer, out-parameters only.
        let e = unsafe { RegQueryValueExW(self.0, name_ptr, None, Some(&mut kind), None, Some(&mut size)) };
        if e.is_err() || kind != REG_SZ || size > 64 * 1024 {
            return None;
        }
        let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
        let mut bytes = (buf.len() * 2) as u32;
        // SAFETY: `buf` holds `bytes` bytes, as the call is told.
        let e = unsafe {
            RegQueryValueExW(
                self.0,
                name_ptr,
                None,
                Some(&mut kind),
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut bytes),
            )
        };
        if e.is_err() {
            return None;
        }
        buf.truncate((bytes as usize) / 2);
        Some(from_wide(&buf))
    }

    /// Removes a value; one that isn't there is fine.
    pub fn delete_value(&self, name: &str) -> Result<(), String> {
        // SAFETY: the key is open for KEY_SET_VALUE; the name is a live null-terminated HSTRING.
        let e = unsafe { RegDeleteValueW(self.0, &HSTRING::from(name)) };
        if e == windows::Win32::Foundation::ERROR_FILE_NOT_FOUND { Ok(()) } else { win32(e) }
    }
}

/// A UTF-16 buffer up to its first NUL, as text (invalid UTF-16 replaced).
pub fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// An error, as text for the log: its HRESULT and Windows' message.
pub fn error_text(e: windows::core::Error) -> String {
    format!("{:#010x} {}", e.code().0 as u32, e.message().trim())
}

/// This executable's full path.
pub fn exe_path() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

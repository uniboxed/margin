//! This user's SID, and security descriptors from SDDL. Windows only.

use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::core::{HSTRING, PWSTR};

use crate::win::{Handle, error_text};

/// The SID of the user this process runs as, as a string (`S-1-5-21-…`).
pub fn current_user_sid() -> Result<String, String> {
    let mut token = HANDLE::default();
    // SAFETY: the current-process pseudo handle needs no closing; `token` is an out-parameter.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.map_err(error_text)?;
    // SAFETY: OpenProcessToken succeeded: the token handle is ours to close.
    let token = unsafe { Handle::new(token) }.ok_or("no token")?;
    let mut size = 0u32;
    // SAFETY: a size query (no buffer); it fails with ERROR_INSUFFICIENT_BUFFER and sets `size`.
    let _ = unsafe { GetTokenInformation(token.raw(), TokenUser, None, 0, &mut size) };
    if size == 0 || size > 64 * 1024 {
        return Err("the token's user didn't fit".into());
    }
    // u64s keep the buffer aligned for TOKEN_USER (pointer-aligned).
    let mut buf = vec![0u64; (size as usize).div_ceil(8)];
    // SAFETY: `buf` holds at least `size` bytes, as the call is told.
    unsafe { GetTokenInformation(token.raw(), TokenUser, Some(buf.as_mut_ptr() as *mut _), size, &mut size) }
        .map_err(error_text)?;
    // SAFETY: GetTokenInformation(TokenUser) filled `buf` with a TOKEN_USER whose SID points into `buf`.
    let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    let mut text = PWSTR::null();
    // SAFETY: the SID is valid while `buf` lives; the string it returns is LocalAlloc'd and freed below.
    unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) }.map_err(error_text)?;
    // SAFETY: `text` is a valid null-terminated string from ConvertSidToStringSidW, freed once after reading.
    let sid = unsafe {
        let s = text.to_string().map_err(|_| "the SID isn't text".to_string());
        LocalFree(Some(HLOCAL(text.0 as *mut _)));
        s
    }?;
    Ok(sid)
}

/// A security descriptor made from SDDL, freed when dropped.
pub struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

// SAFETY: the descriptor is a self-contained block of memory, never changed after it's made; Windows only
// reads it (CreateNamedPipeW), from whichever thread.
unsafe impl Send for SecurityDescriptor {}
// SAFETY: as above: shared reads only.
unsafe impl Sync for SecurityDescriptor {}

impl SecurityDescriptor {
    pub fn from_sddl(sddl: &str) -> Result<Self, String> {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: `sddl` is a null-terminated HSTRING alive for the call; `sd` receives a LocalAlloc'd
        // descriptor, owned by the returned value.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(&HSTRING::from(sddl), SDDL_REVISION_1, &mut sd, None)
        }
        .map_err(error_text)?;
        Ok(Self(sd))
    }

    /// SECURITY_ATTRIBUTES pointing at this descriptor (not inheritable). Valid while `self` lives.
    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0.0,
            bInheritHandle: false.into(),
        }
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: the descriptor was LocalAlloc'd by ConvertStringSecurityDescriptorToSecurityDescriptorW and
        // is freed only here.
        unsafe {
            LocalFree(Some(HLOCAL(self.0.0)));
        }
    }
}

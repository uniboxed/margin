//! One Margin per user session, and opening at sign-in (app/platforms/macos/startup/AppDelegate.swift's single instance and
//! login item).
//!
//! The single instance is a named mutex, `Local\Margin-<SID>` (paths.rs): the first app holds it for its whole
//! life; a second launch finds it there, tells the first nothing and exits (the connector starts the app only
//! when the pipe isn't there, so a second launch is a person's double click). Opening at sign-in is the value
//! `Margin` of `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, a setting the shell turns on and off:
//! `"<margin.exe>" --login`. (Windows' Settings › Apps › Startup can still turn it off; that's kept apart, in
//! `Explorer\StartupApproved\Run`, and Margin leaves it alone.)

/// The Run key's command for this executable.
pub fn run_command(exe: &str) -> String {
    format!("\"{exe}\" {}", crate::args::LOGIN_FLAG)
}

pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const RUN_VALUE: &str = "Margin";

#[cfg(windows)]
pub use win::*;

#[cfg(windows)]
mod win {
    use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
    use windows::Win32::System::Registry::HKEY_CURRENT_USER;
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::core::HSTRING;

    use super::{RUN_KEY, RUN_VALUE, run_command};
    use crate::win::{Handle, RegKey, error_text};

    /// Held for the app's life: the single instance's mutex.
    pub struct Instance(#[allow(dead_code)] Handle);

    pub enum Claim {
        /// This is the only app: keep the value until the app quits.
        First(Instance),
        /// Another app of this user's session is running.
        Running,
    }

    pub fn claim(sid: &str) -> Result<Claim, String> {
        let name = HSTRING::from(crate::paths::mutex_name(sid));
        // SAFETY: a named mutex with the default security (this user's); the name is a live HSTRING. The
        // last error is read straight after, before any other call can change it.
        let (h, existed) = unsafe {
            let h = CreateMutexW(None, false, &name).map_err(error_text)?;
            (h, GetLastError() == ERROR_ALREADY_EXISTS)
        };
        // SAFETY: CreateMutexW gave a handle we own.
        let handle = unsafe { Handle::new(h) }.ok_or("no mutex")?;
        Ok(if existed { Claim::Running } else { Claim::First(Instance(handle)) })
    }

    /// Whether Margin opens at sign-in: the Run value is there and names this executable.
    pub fn opens_at_login(exe: &str) -> bool {
        RegKey::open(HKEY_CURRENT_USER, RUN_KEY)
            .and_then(|k| k.get_string(Some(RUN_VALUE)))
            .is_some_and(|v| v == run_command(exe))
    }

    /// Turns opening at sign-in on (for this executable) or off.
    pub fn set_open_at_login(on: bool, exe: &str) -> Result<(), String> {
        if on {
            RegKey::create(HKEY_CURRENT_USER, RUN_KEY)?.set_string(Some(RUN_VALUE), &run_command(exe))
        } else {
            match RegKey::open(HKEY_CURRENT_USER, RUN_KEY) {
                Some(k) => k.delete_value(RUN_VALUE),
                None => Ok(()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_run_command_quotes_the_path() {
        assert_eq!(
            run_command(r"C:\Users\Nora Field\AppData\Local\Programs\Margin\margin.exe"),
            r#""C:\Users\Nora Field\AppData\Local\Programs\Margin\margin.exe" --login"#
        );
    }
}

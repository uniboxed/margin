//! Which mode `margin.exe` starts in, from its command line (OS-neutral, tested on the Mac).
//!
//! Chrome and Edge start a native-messaging host with the caller's origin as the first argument
//! (`chrome-extension://<id>/`) and, on Windows, `--parent-window=<n>`: the HWND of the window that made the
//! call as a decimal number, 0 when the call came from a background (Margin's always does: its service worker).
//! Anything else is the app: started by hand, by the relay (no arguments) or at login (`--login`).

/// What Chrome said when it started the relay.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayArgs {
    /// The caller's origin as Chrome gave it (`chrome-extension://<id>/`).
    pub origin: String,
    /// `--parent-window=<n>`: the calling window's HWND; `None` when absent or 0 (a background called).
    pub parent_window: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The app. `login`: started from the Run key at sign-in (instance.rs `run_command`).
    App { login: bool },
    /// The native-messaging host: relays Chrome's port to the running app (relay.rs).
    Relay(RelayArgs),
}

pub const LOGIN_FLAG: &str = "--login";
const PARENT_WINDOW: &str = "--parent-window=";
const EXTENSION_SCHEME: &str = "chrome-extension://";

/// The mode for these arguments (without the program's own name). The relay is chosen by the first argument
/// alone, as Chrome always puts the origin first; an unknown origin still makes a relay (it talks only stdio
/// to the browser that started it, never shows anything, and the app checks the origin it reports).
pub fn mode<I: IntoIterator<Item = String>>(args: I) -> Mode {
    let args: Vec<String> = args.into_iter().collect();
    match args.first() {
        Some(first) if first.starts_with(EXTENSION_SCHEME) => {
            let parent_window = args
                .iter()
                .skip(1)
                .find_map(|a| a.strip_prefix(PARENT_WINDOW))
                .and_then(|n| n.trim().parse::<i64>().ok())
                .filter(|&n| n != 0);
            Mode::Relay(RelayArgs { origin: first.clone(), parent_window })
        }
        _ => Mode::App { login: args.iter().any(|a| a == LOGIN_FLAG) },
    }
}

/// Whether an origin is a well-formed Chromium extension origin: `chrome-extension://` + 32 letters a–p + `/`.
pub fn is_extension_origin(origin: &str) -> bool {
    origin
        .strip_prefix(EXTENSION_SCHEME)
        .and_then(|rest| rest.strip_suffix('/'))
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    const ORIGIN: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";

    #[test]
    fn no_arguments_is_the_app() {
        assert_eq!(mode(strings(&[])), Mode::App { login: false });
        assert_eq!(mode(strings(&["--login"])), Mode::App { login: true });
        assert_eq!(mode(strings(&["--something", "--login"])), Mode::App { login: true });
    }

    #[test]
    fn chrome_starts_the_relay() {
        assert_eq!(
            mode(strings(&[ORIGIN, "--parent-window=132456"])),
            Mode::Relay(RelayArgs { origin: ORIGIN.into(), parent_window: Some(132456) })
        );
        assert_eq!(
            mode(strings(&[ORIGIN, "--parent-window=0"])),
            Mode::Relay(RelayArgs { origin: ORIGIN.into(), parent_window: None })
        );
        assert_eq!(mode(strings(&[ORIGIN])), Mode::Relay(RelayArgs { origin: ORIGIN.into(), parent_window: None }));
    }

    #[test]
    fn the_origin_only_counts_first() {
        assert_eq!(mode(strings(&["--login", ORIGIN])), Mode::App { login: true });
    }

    #[test]
    fn extension_origins() {
        assert!(is_extension_origin(ORIGIN));
        assert!(!is_extension_origin("chrome-extension://abc/"));
        assert!(!is_extension_origin("chrome-extension://abcdefghijklmnopabcdefghijklmnoq/"));
        assert!(!is_extension_origin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"));
        assert!(!is_extension_origin("https://abcdefghijklmnopabcdefghijklmnop/"));
    }
}

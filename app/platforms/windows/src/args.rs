//! Which mode `margin.exe` starts in, from its command line (OS-neutral, tested on the Mac).
//!
//! `margin.exe` is the app only: started by hand, by Margin's connector (no arguments) or at sign-in (`--login`).
//! The browsers' native-messaging host is Margin's connector (`margin-connector.exe`, app/shared/connector/); an
//! older registration may still name `margin.exe`, which Chrome and Edge start with the caller's origin first
//! (`chrome-extension://<id>/`): that start exits at once (it must not become the app with the browser's pipes as
//! its standard handles). The app's next launch runs `margin-connector.exe --install`, which points the browsers
//! at the connector.

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The app. `login`: started from the Run key at sign-in (instance.rs `run_command`).
    App { login: bool },
    /// Started by a browser as its native-messaging host (an older registration): exits.
    NotTheHost,
}

pub const LOGIN_FLAG: &str = "--login";
const EXTENSION_SCHEME: &str = "chrome-extension://";

/// The mode for these arguments (without the program's own name). A browser always puts the origin first.
pub fn mode<I: IntoIterator<Item = String>>(args: I) -> Mode {
    let args: Vec<String> = args.into_iter().collect();
    match args.first() {
        Some(first) if first.starts_with(EXTENSION_SCHEME) => Mode::NotTheHost,
        _ => Mode::App { login: args.iter().any(|a| a == LOGIN_FLAG) },
    }
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
    fn a_browser_starting_it_as_its_host_isnt_the_app() {
        assert_eq!(mode(strings(&[ORIGIN, "--parent-window=132456"])), Mode::NotTheHost);
        assert_eq!(mode(strings(&[ORIGIN])), Mode::NotTheHost);
    }

    #[test]
    fn the_origin_only_counts_first() {
        assert_eq!(mode(strings(&["--login", ORIGIN])), Mode::App { login: true });
    }
}

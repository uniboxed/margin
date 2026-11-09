//! Margin's connector (docs/PROTOCOL.md "Transport (Chrome and Edge, on the Mac)"): the program Chrome, Edge and
//! the other Chromium browsers start for Margin's extension through native messaging, one per native port and
//! one per one-off message. It passes the browser's messages to the running Margin app (Margin.app's
//! RelayLink.swift) and the app's back, as Safari's extension handler does for Safari: the link itself is then
//! the copy's WebSocket to the app. The same program on every OS; what differs (how it reaches the app, which
//! browser started it, how it starts the app, where host files go) is in unix.rs and windows.rs.
//!
//!   margin-connector chrome-extension://<id>/      started by the browser (stdio: its framing)
//!   margin-connector --install [--support <dir>]   writes the browsers' host files (the app runs it at launch)
//!
//! For the tests: MARGIN_CONNECTOR_SOCKET (another socket), MARGIN_CONNECTOR_NO_LAUNCH (never start the app),
//! MARGIN_CONNECTOR_BROWSER and MARGIN_CONNECTOR_VERSION (what it says it is).

mod host;
#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as os;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as os;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--install") {
        let support =
            args.iter().position(|a| a == "--support").and_then(|i| args.get(i + 1)).map(std::path::PathBuf::from);
        std::process::exit(install(support.as_deref()));
    }
    host::run(&host::Facts::now());
}

// The host files, one written path per line on stdout; 1 (and why, on stderr) if they couldn't be.
fn install(support: Option<&std::path::Path>) -> i32 {
    let Ok(connector) = std::env::current_exe() else {
        eprintln!("margin-connector: its own path couldn't be read");
        return 1;
    };
    match os::install(&connector, support) {
        Ok(written) => {
            for path in written {
                println!("{path}");
            }
            0
        }
        Err(why) => {
            eprintln!("margin-connector: {why}");
            1
        }
    }
}

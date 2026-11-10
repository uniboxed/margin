//! The native-messaging host's registration, rewritten at every app launch (PLAN.md Spike 3: "the app
//! rewrites the host manifests at every launch"), so a moved or updated `margin.exe` is always the one Chrome
//! and Edge start.
//!
//! The manifest, `%LOCALAPPDATA%\Margin\NativeMessagingHosts\io.tirth.margin.json`:
//! `{ name, description, path: <margin.exe>, type: "stdio", allowed_origins }`; and each browser's registry
//! key, whose default value is the manifest's path: Chrome's (Chrome Beta, Dev and Canary read it too), Edge's,
//! Brave's and Chromium's, all under HKCU (no administrator needed).

use serde::Serialize;

pub const HOST_NAME: &str = "io.tirth.margin";
pub const MANIFEST_FILE: &str = "io.tirth.margin.json";
const DESCRIPTION: &str = "Margin: links the Margin extension to the Margin app";

/// The Margin extension's ids, in Chrome's and Edge's stores. TODO(Tirth): fill these in. Neither
/// `engines/chromium/extension/manifest.json` nor anything else in the repo fixes one (no `key`): an unpacked build's id
/// comes from its folder, the e2e harness makes a key per run (tests/e2e/harness/build.ts `extensionId`), and the
/// stores give their own ids at the first upload. Until then, set `MARGIN_EXTENSION_IDS` (ids separated by
/// commas) before starting the app, for an unpacked build's id (chrome://extensions shows it).
pub const EXTENSION_IDS: &[&str] = &[];

/// Where each browser looks for the host, under HKCU. Chrome Beta, Dev and Canary share Chrome's key.
pub const REGISTRY_KEYS: &[&str] = &[
    r"Software\Google\Chrome\NativeMessagingHosts\io.tirth.margin",
    r"Software\Microsoft\Edge\NativeMessagingHosts\io.tirth.margin",
    r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\io.tirth.margin",
    r"Software\Chromium\NativeMessagingHosts\io.tirth.margin",
];

/// A Chromium extension id: 32 letters a–p.
pub fn is_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// The origins Chrome lets start the host: the fixed ids, then those of `MARGIN_EXTENSION_IDS` (`extra`),
/// each once, malformed ones left out.
pub fn allowed_origins(fixed: &[&str], extra: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in fixed.iter().copied().chain(extra.unwrap_or("").split(',').map(str::trim)) {
        let origin = format!("chrome-extension://{id}/");
        if is_extension_id(id) && !out.contains(&origin) {
            out.push(origin);
        }
    }
    out
}

#[derive(Serialize)]
struct Manifest<'a> {
    name: &'a str,
    description: &'a str,
    path: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
    allowed_origins: &'a [String],
}

/// The manifest's JSON.
pub fn manifest_json(exe: &str, origins: &[String]) -> String {
    let m = Manifest { name: HOST_NAME, description: DESCRIPTION, path: exe, kind: "stdio", allowed_origins: origins };
    serde_json::to_string_pretty(&m).unwrap_or_default()
}

/// Writes a file whole or not at all: a temporary file beside it, then a rename over it.
pub fn write_atomically(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(windows)]
pub use win::*;

#[cfg(windows)]
mod win {
    use std::path::Path;

    use windows::Win32::System::Registry::HKEY_CURRENT_USER;

    use super::*;
    use crate::paths::Paths;
    use crate::win::RegKey;

    /// What the registration did, for the log: the origins it allowed, and what failed.
    pub struct Installed {
        pub origins: usize,
        pub failures: Vec<String>,
    }

    /// Writes the manifest and every registry key. Failures are listed, not fatal: one browser's key failing
    /// leaves the others registered.
    pub fn install(paths: &Paths, exe: &Path) -> Installed {
        let extra = std::env::var("MARGIN_EXTENSION_IDS").ok();
        let origins = allowed_origins(EXTENSION_IDS, extra.as_deref());
        let mut failures = Vec::new();
        let manifest = paths.hosts.join(MANIFEST_FILE);
        let exe = exe.to_string_lossy();
        let written = std::fs::create_dir_all(&paths.hosts)
            .and_then(|_| write_atomically(&manifest, manifest_json(&exe, &origins).as_bytes()));
        if let Err(e) = written {
            failures.push(format!("the manifest: {e}"));
            return Installed { origins: origins.len(), failures };
        }
        let manifest = manifest.to_string_lossy();
        for key in REGISTRY_KEYS {
            let set = RegKey::create(HKEY_CURRENT_USER, key).and_then(|k| k.set_string(None, &manifest));
            if let Err(e) = set {
                failures.push(format!("{key}: {e}"));
            }
        }
        Installed { origins: origins.len(), failures }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "abcdefghijklmnopabcdefghijklmnop";

    #[test]
    fn origins() {
        assert_eq!(allowed_origins(&[ID], None), vec![format!("chrome-extension://{ID}/")]);
        assert_eq!(
            allowed_origins(
                &[ID],
                Some(&format!(" {ID} ,bad,ppppppppppppppppppppppppppppppppp,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
            ),
            vec![
                format!("chrome-extension://{ID}/"),
                "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/".to_string()
            ]
        );
        assert!(allowed_origins(&[], Some("")).is_empty());
    }

    #[test]
    fn manifest() {
        let json = manifest_json(r"C:\Margin\margin.exe", &[format!("chrome-extension://{ID}/")]);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["name"], "io.tirth.margin");
        assert_eq!(v["path"], r"C:\Margin\margin.exe");
        assert_eq!(v["type"], "stdio");
        assert_eq!(v["allowed_origins"][0], format!("chrome-extension://{ID}/"));
        assert!(v["description"].is_string());
    }

    #[test]
    fn atomic_write_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(MANIFEST_FILE);
        write_atomically(&p, b"one").unwrap();
        write_atomically(&p, b"two").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        assert!(!p.with_extension("tmp").exists());
    }

    #[test]
    fn keys_name_the_host() {
        assert!(REGISTRY_KEYS.iter().all(|k| k.ends_with(r"NativeMessagingHosts\io.tirth.margin")));
    }
}

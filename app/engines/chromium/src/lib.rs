//! Chromium's side of Margin's app, on every OS (engines/README.md): what every Chromium browser shares (the
//! native-messaging host file's format, which names Margin's connector and only Margin's extension) and where
//! each browser looks for host files. Margin's connector writes them (`margin-connector --install`,
//! app/shared/connector/): a file that already says the same is left alone, so a launch writes nothing once
//! they're right; an app moved elsewhere writes its new path.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The host's name, as the extension asks for it (`runtime.connectNative('com.unibox.margin')`).
pub const HOST_NAME: &str = "com.unibox.margin";

/// Margin's extension in every Chromium browser: the id its manifest's key gives
/// (extension/engines/chromium/manifest.json; tests/build.test.ts checks the two agree).
pub const EXTENSION_IDS: &[&str] = &["njeebbcmlenfopaecfbphgcfihbdmkec"];

/// One Chromium browser: where it keeps its user data on the Mac (under ~/Library/Application Support) and on
/// Linux (under ~/.config), and its registry key on Windows (under HKEY_CURRENT_USER). `None`: not on that OS.
pub struct Browser {
    pub name: &'static str,
    pub mac: Option<&'static str>,
    pub linux: Option<&'static str>,
    pub windows: Option<&'static str>,
}

/// Chrome and Edge, each with its channels, then Brave and Chromium. (Each family's channels share one registry
/// key on Windows: the first of each names it.)
pub const BROWSERS: &[Browser] = &[
    Browser {
        name: "Chrome",
        mac: Some("Google/Chrome"),
        linux: Some("google-chrome"),
        windows: Some(r"Software\Google\Chrome"),
    },
    Browser { name: "Chrome Beta", mac: Some("Google/Chrome Beta"), linux: Some("google-chrome-beta"), windows: None },
    Browser {
        name: "Chrome Dev",
        mac: Some("Google/Chrome Dev"),
        linux: Some("google-chrome-unstable"),
        windows: None,
    },
    Browser { name: "Chrome Canary", mac: Some("Google/Chrome Canary"), linux: None, windows: None },
    Browser {
        name: "Edge",
        mac: Some("Microsoft Edge"),
        linux: Some("microsoft-edge"),
        windows: Some(r"Software\Microsoft\Edge"),
    },
    Browser { name: "Edge Beta", mac: Some("Microsoft Edge Beta"), linux: Some("microsoft-edge-beta"), windows: None },
    Browser { name: "Edge Dev", mac: Some("Microsoft Edge Dev"), linux: Some("microsoft-edge-dev"), windows: None },
    Browser { name: "Edge Canary", mac: Some("Microsoft Edge Canary"), linux: None, windows: None },
    Browser {
        name: "Brave",
        mac: Some("BraveSoftware/Brave-Browser"),
        linux: Some("BraveSoftware/Brave-Browser"),
        windows: Some(r"Software\BraveSoftware\Brave-Browser"),
    },
    Browser { name: "Chromium", mac: Some("Chromium"), linux: Some("chromium"), windows: Some(r"Software\Chromium") },
];

/// The host file's text: the connector at `connector`, spoken to over stdio, by Margin's extension only.
pub fn manifest(connector: &Path) -> String {
    let mut object = serde_json::Map::new();
    object.insert(
        "allowed_origins".into(),
        EXTENSION_IDS.iter().map(|id| format!("chrome-extension://{id}/")).collect::<Vec<_>>().into(),
    );
    object.insert("description".into(), "Margin.app's connector, for Margin's extension".into());
    object.insert("name".into(), HOST_NAME.into());
    object.insert("path".into(), connector.to_string_lossy().into_owned().into());
    object.insert("type".into(), "stdio".into());
    let mut text = serde_json::to_string_pretty(&serde_json::Value::Object(object)).unwrap_or_default();
    text.push('\n');
    text
}

/// The host files to write where host files are folders (the Mac, Linux): one in each browser's
/// `NativeMessagingHosts` folder under `root` (~/Library/Application Support, or ~/.config), for each browser
/// whose folder is there. `linux`: Linux's folder names, else the Mac's.
pub fn host_files(root: &Path, linux: bool) -> Vec<PathBuf> {
    BROWSERS
        .iter()
        .filter_map(|b| if linux { b.linux } else { b.mac })
        .map(|folder| root.join(folder))
        .filter(|folder| folder.is_dir())
        .map(|folder| folder.join("NativeMessagingHosts").join(format!("{HOST_NAME}.json")))
        .collect()
}

/// Each file written with `body` (its folder made), unless it says that already. The files written, or the
/// first error.
pub fn write_host_files(files: &[PathBuf], body: &str) -> io::Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    for file in files {
        if fs::read_to_string(file).is_ok_and(|now| now == body) {
            continue;
        }
        if let Some(folder) = file.parent() {
            fs::create_dir_all(folder)?;
        }
        // Whole or not at all: a browser reading it meanwhile sees the old file or the new one.
        let partial = file.with_extension("json.partial");
        fs::write(&partial, body)?;
        fs::rename(&partial, file)?;
        written.push(file.clone());
    }
    Ok(written)
}

/// Windows: the registry keys (under HKEY_CURRENT_USER) whose default value names the host file.
pub fn windows_keys() -> Vec<String> {
    BROWSERS.iter().filter_map(|b| b.windows).map(|key| format!(r"{key}\NativeMessagingHosts\{HOST_NAME}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_file_names_the_connector_and_only_margins_extension() {
        let text = manifest(Path::new("/Applications/Margin.app/Contents/Helpers/margin-connector"));
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["name"], "com.unibox.margin");
        assert_eq!(value["type"], "stdio");
        assert_eq!(value["path"], "/Applications/Margin.app/Contents/Helpers/margin-connector");
        assert_eq!(
            value["allowed_origins"],
            serde_json::json!(["chrome-extension://njeebbcmlenfopaecfbphgcfihbdmkec/"])
        );
    }

    #[test]
    fn only_browsers_whose_folder_is_there_get_one_and_the_same_again_writes_nothing() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("Google/Chrome")).unwrap();
        fs::create_dir_all(root.path().join("Microsoft Edge Beta")).unwrap();
        let files = host_files(root.path(), false);
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|f| f.ends_with("NativeMessagingHosts/com.unibox.margin.json")));
        let body = manifest(Path::new("/x/margin-connector"));
        assert_eq!(write_host_files(&files, &body).unwrap().len(), 2);
        assert_eq!(fs::read_to_string(&files[0]).unwrap(), body);
        assert!(write_host_files(&files, &body).unwrap().is_empty(), "the same again: nothing written");
        assert_eq!(
            write_host_files(&files, &manifest(Path::new("/y/margin-connector"))).unwrap().len(),
            2,
            "moved: written again"
        );
    }

    #[test]
    fn linux_folders_and_windows_keys() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("google-chrome")).unwrap();
        fs::create_dir_all(root.path().join("Google/Chrome")).unwrap(); // the Mac's name: not Linux's
        let files = host_files(root.path(), true);
        assert_eq!(files, vec![root.path().join("google-chrome/NativeMessagingHosts/com.unibox.margin.json")]);
        assert_eq!(
            windows_keys(),
            vec![
                r"Software\Google\Chrome\NativeMessagingHosts\com.unibox.margin".to_string(),
                r"Software\Microsoft\Edge\NativeMessagingHosts\com.unibox.margin".to_string(),
                r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.unibox.margin".to_string(),
                r"Software\Chromium\NativeMessagingHosts\com.unibox.margin".to_string(),
            ]
        );
    }
}

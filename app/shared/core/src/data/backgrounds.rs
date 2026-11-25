//! Pictures as space backgrounds (M2.9 step 7, docs/SPACE-BACKGROUNDS.md Part B §7), kept by the app beside its library
//! (macOS: `~/Library/Application Support/Margin/data/app/backgrounds/`):
//!
//! ```text
//! <id>.jpg | <id>.png    the picture as the platform made it: decoded, at most MAX_SIDE on its long side, encoded
//!                        again (its metadata, EXIF and GPS among it, gone); `<id>` its bytes' SHA-256 in hex
//! ```
//!
//! The platform decodes what the person chose (macOS: ImageIO, BackgroundStore.swift; Windows: WIC, later) and hands
//! this the result. What's kept here is checked again, by its bytes, never by a name: a JPEG or a PNG by its signature,
//! within MAX_BYTES, its size read from its own header within MAX_SIDE. Content-addressed: the same picture twice is
//! one file, and a file is never written over. Each written as the data sets' files are (a temporary file, flushed, a
//! rename). A space's background names its picture by id (library/state.rs `bg_image_id_ok`); a file no space names is
//! removed when the library opens (`prune`), not as a space changes, so ⌘Z and Escape can always bring one back.
//! Served to Margin's page by id alone (`path`): the id checked, the file looked up, no path made of anything else.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::store::write_atomically;
use crate::library::state::bg_image_id_ok;

/// What's kept, at most (after the platform made it: 3840 px on its long side, JPEG or PNG).
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
/// A picture's long side, at most, in pixels.
pub const MAX_SIDE: u32 = 3840;
/// What the person may choose, at most, before the platform decodes it.
pub const MAX_INPUT_BYTES: usize = 40 * 1024 * 1024;

/// A picture's kind, by its bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Jpeg,
    Png,
}

impl Kind {
    pub fn ext(self) -> &'static str {
        match self {
            Kind::Jpeg => "jpg",
            Kind::Png => "png",
        }
    }
    pub fn mime(self) -> &'static str {
        match self {
            Kind::Jpeg => "image/jpeg",
            Kind::Png => "image/png",
        }
    }
    fn of_ext(ext: &str) -> Option<Kind> {
        match ext {
            "jpg" => Some(Kind::Jpeg),
            "png" => Some(Kind::Png),
            _ => None,
        }
    }
}

/// A JPEG or a PNG by its signature; anything else none.
pub fn kind_of(bytes: &[u8]) -> Option<Kind> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(Kind::Jpeg)
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(Kind::Png)
    } else {
        None
    }
}

/// Its width and height from its own header: a PNG's IHDR, a JPEG's first frame header (SOF). None when there's none.
pub fn size_of(kind: Kind, b: &[u8]) -> Option<(u32, u32)> {
    let be16 = |i: usize| -> Option<u32> { Some(u32::from(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]))) };
    match kind {
        Kind::Png => {
            // The signature, then the IHDR chunk first: its length (13), its type, width, height.
            if b.get(12..16)? != b"IHDR" {
                return None;
            }
            let w = u32::from_be_bytes(b.get(16..20)?.try_into().ok()?);
            let h = u32::from_be_bytes(b.get(20..24)?.try_into().ok()?);
            Some((w, h))
        }
        Kind::Jpeg => {
            let mut i = 2;
            loop {
                // A marker: 0xFF (padding 0xFFs allowed), its code, then (most) a big-endian length that counts itself.
                while *b.get(i)? == 0xFF && *b.get(i + 1)? == 0xFF {
                    i += 1;
                }
                if *b.get(i)? != 0xFF {
                    return None;
                }
                let code = *b.get(i + 1)?;
                match code {
                    // Standalone markers (no length): restart markers, TEM.
                    0xD0..=0xD7 | 0x01 => {
                        i += 2;
                        continue;
                    }
                    // The image's data before any frame header: none.
                    0xD9 | 0xDA => return None,
                    _ => {}
                }
                let len = be16(i + 2)? as usize;
                if len < 2 {
                    return None;
                }
                // A frame header (SOF0–SOF15 but DHT, JPG and DAC): its precision, height, width.
                if matches!(code, 0xC0..=0xCF) && !matches!(code, 0xC4 | 0xC8 | 0xCC) {
                    let h = be16(i + 5)?;
                    let w = be16(i + 7)?;
                    return Some((w, h));
                }
                i += 2 + len;
            }
        }
    }
}

/// A picture's id: its bytes' SHA-256, in lowercase hex.
pub fn id_of(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[derive(Debug)]
pub enum BackgroundError {
    /// Refused for its kind, size or dimensions (the words go back to the page).
    Refused(String),
    Io(io::Error),
}

impl From<io::Error> for BackgroundError {
    fn from(e: io::Error) -> Self {
        BackgroundError::Io(e)
    }
}

/// A picture kept: its id, kind and size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kept {
    pub id: String,
    pub kind: Kind,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
}

/// The pictures under one folder (made when the first is kept).
pub struct BackgroundStore {
    root: PathBuf,
}

impl BackgroundStore {
    pub fn new(root: PathBuf) -> Self {
        BackgroundStore { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Checks a picture the platform made and keeps it (once: the same bytes are the same file).
    pub fn add(&self, bytes: &[u8]) -> Result<Kept, BackgroundError> {
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err(BackgroundError::Refused(format!("a picture is at most {MAX_BYTES} bytes")));
        }
        let kind = kind_of(bytes).ok_or_else(|| BackgroundError::Refused("not a JPEG or a PNG".into()))?;
        let (width, height) =
            size_of(kind, bytes).ok_or_else(|| BackgroundError::Refused("no size in its header".into()))?;
        if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
            return Err(BackgroundError::Refused(format!("{width} × {height}: a side is 1 to {MAX_SIDE} px")));
        }
        let id = id_of(bytes);
        let path = self.root.join(format!("{id}.{}", kind.ext()));
        if !path.is_file() {
            write_atomically(bytes, &path)?;
        }
        Ok(Kept { id, kind, width, height, bytes: bytes.len() })
    }

    /// Where a picture is, and its kind: for an id that is one and a file that's there; none otherwise.
    pub fn path(&self, id: &str) -> Option<(PathBuf, Kind)> {
        if !bg_image_id_ok(id) {
            return None;
        }
        [Kind::Jpeg, Kind::Png].into_iter().find_map(|kind| {
            let p = self.root.join(format!("{id}.{}", kind.ext()));
            p.is_file().then_some((p, kind))
        })
    }

    /// Every picture's id here.
    pub fn ids(&self) -> Vec<String> {
        let mut out: Vec<String> = self.files().into_iter().filter_map(|(_, id)| id).collect();
        out.sort();
        out.dedup();
        out
    }

    /// The folder's files, each with the id it holds (none: a file that isn't a picture's, as a write left it).
    fn files(&self) -> Vec<(PathBuf, Option<String>)> {
        let Ok(entries) = fs::read_dir(&self.root) else { return Vec::new() };
        entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let id = name
                    .split_once('.')
                    .filter(|(id, ext)| bg_image_id_ok(id) && Kind::of_ext(ext).is_some())
                    .map(|(id, _)| id.to_owned());
                (e.path(), id)
            })
            .collect()
    }

    /// Removes every picture no space names (`keep`), and what a write left behind (a temporary file, a `.bak`):
    /// how many files went.
    pub fn prune(&self, keep: &HashSet<String>) -> io::Result<usize> {
        let mut removed = 0;
        for (path, id) in self.files() {
            if id.as_ref().is_some_and(|id| keep.contains(id)) {
                continue;
            }
            match fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A PNG of w × h (its signature and IHDR; the rest isn't read here).
    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        b
    }
    // A JPEG of w × h: SOI, an APP0 segment, a SOF0 frame header.
    fn jpeg(w: u16, h: u16, sof: u8) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        b.extend_from_slice(b"JFIF\0");
        b.extend_from_slice(&[1, 1, 0, 0, 1, 0, 1, 0, 0]);
        b.extend_from_slice(&[0xFF, 0xFF, sof, 0x00, 0x11, 8]);
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        b
    }

    #[test]
    fn kind_and_size_by_the_bytes() {
        assert_eq!(kind_of(&png(2, 3)), Some(Kind::Png));
        assert_eq!(size_of(Kind::Png, &png(1920, 1080)), Some((1920, 1080)));
        assert_eq!(kind_of(&jpeg(4, 5, 0xC0)), Some(Kind::Jpeg));
        assert_eq!(size_of(Kind::Jpeg, &jpeg(3840, 2160, 0xC0)), Some((3840, 2160)), "baseline (and a padding 0xFF)");
        assert_eq!(size_of(Kind::Jpeg, &jpeg(800, 600, 0xC2)), Some((800, 600)), "progressive");
        assert_eq!(
            size_of(Kind::Jpeg, &jpeg(800, 600, 0xC4)),
            None,
            "DHT isn't a frame header (nothing after it here)"
        );
        assert_eq!(kind_of(b"GIF89a"), None);
        assert_eq!(kind_of(b"<svg"), None);
        assert_eq!(kind_of(&[]), None);
        assert_eq!(size_of(Kind::Png, &png(2, 3)[..20]), None, "cut short");
        assert_eq!(size_of(Kind::Jpeg, &[0xFF, 0xD8, 0xFF]), None);
        assert_eq!(size_of(Kind::Jpeg, &[0xFF, 0xD8, 0xFF, 0xDA, 0, 4, 0, 0]), None, "the data before a frame header");
        assert_eq!(size_of(Kind::Jpeg, &[0xFF, 0xD8, 0xFF, 0xE0, 0, 1]), None, "a length under 2");
    }

    #[test]
    fn kept_once_by_its_bytes_checked_again() {
        let dir = tempfile::tempdir().unwrap();
        let store = BackgroundStore::new(dir.path().join("backgrounds"));
        let a = png(1920, 1080);
        let kept = store.add(&a).unwrap();
        assert_eq!(kept, Kept { id: id_of(&a), kind: Kind::Png, width: 1920, height: 1080, bytes: a.len() });
        assert!(bg_image_id_ok(&kept.id));
        let (path, kind) = store.path(&kept.id).unwrap();
        assert_eq!(
            (path.file_name().unwrap().to_string_lossy().into_owned(), kind),
            (format!("{}.png", kept.id), Kind::Png)
        );
        assert_eq!(fs::read(&path).unwrap(), a);
        assert_eq!(store.add(&a).unwrap(), kept, "the same bytes: the same file");
        assert_eq!(store.ids(), vec![kept.id.clone()]);
        let j = jpeg(640, 480, 0xC0);
        let kj = store.add(&j).unwrap();
        assert_eq!(store.path(&kj.id).unwrap().1, Kind::Jpeg);
        for (bad, why) in [
            (b"GIF89a...".to_vec(), "not a JPEG or a PNG"),
            (png(3841, 10), "a side is"),
            (png(0, 10), "a side is"),
            (jpeg(4000, 10, 0xC0), "a side is"),
            (vec![], "at most"),
            (png(10, 10)[..14].to_vec(), "no size"),
        ] {
            match store.add(&bad) {
                Err(BackgroundError::Refused(w)) => assert!(w.contains(why), "{w}"),
                other => panic!("{why}: {other:?}"),
            }
        }
        let mut big = png(10, 10);
        big.resize(MAX_BYTES + 1, 0);
        assert!(matches!(store.add(&big), Err(BackgroundError::Refused(_))), "too many bytes");
        assert_eq!(store.ids().len(), 2, "nothing refused was kept");
    }

    #[test]
    fn served_by_its_id_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = BackgroundStore::new(dir.path().to_path_buf());
        let kept = store.add(&png(8, 8)).unwrap();
        assert!(store.path(&kept.id).is_some());
        for bad in [
            "",
            "..",
            "../x",
            &kept.id.to_uppercase(),
            &format!("{}.png", kept.id),
            &kept.id[..63],
            &format!("{}0", kept.id),
            &format!("../{}", kept.id),
        ] {
            assert!(store.path(bad).is_none(), "{bad:?}");
        }
        assert!(store.path(&"0".repeat(64)).is_none(), "an id that is one, no file");
    }

    #[test]
    fn pruned_to_what_spaces_name_with_what_a_write_left() {
        let dir = tempfile::tempdir().unwrap();
        let store = BackgroundStore::new(dir.path().to_path_buf());
        let a = store.add(&png(8, 8)).unwrap();
        let b = store.add(&png(9, 9)).unwrap();
        fs::write(dir.path().join(format!("{}.png.bak", a.id)), b"old").unwrap();
        fs::write(dir.path().join("x.tmp"), b"partial").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let keep: HashSet<String> = [a.id.clone(), "f".repeat(64)].into_iter().collect();
        assert_eq!(store.prune(&keep).unwrap(), 3, "b, the .bak, the temporary file");
        assert_eq!(store.ids(), vec![a.id.clone()]);
        assert!(store.path(&b.id).is_none(), "the one no space names: gone");
        assert!(dir.path().join("sub").is_dir(), "a folder isn't a file of its own: left");
        assert_eq!(BackgroundStore::new(dir.path().join("none")).prune(&keep).unwrap(), 0, "no folder yet: nothing");
    }
}

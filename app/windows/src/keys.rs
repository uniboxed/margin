//! Key combinations for the hot keys (OS-neutral, tested on the Mac): the extension's strings
//! (`shared/shortcuts.ts`: modifiers `Ctrl`, `Alt`, `Shift`, `Meta` and a DOM `KeyboardEvent.code`, joined by
//! `+`) as RegisterHotKey's modifiers and a key. `Meta` is what the DOM calls it on Windows too: the Windows
//! key (`Win` is taken as well). Which defaults Windows uses (⌘ on the Mac being Ctrl here: Ctrl+T for the
//! palette) is the shell's choice, not this module's.
//!
//! A DOM `code` names a physical key (its place on a US keyboard), as the Mac's `kVK_ANSI_*` do; a Win32
//! virtual key depends on the keyboard layout. So printable keys carry their scan code, and hotkeys.rs turns it
//! into the virtual key of the layout in use (`MapVirtualKeyExW`); the rest have fixed virtual keys.

/// RegisterHotKey's modifier bits.
pub const MOD_ALT: u32 = 0x0001;
pub const MOD_CONTROL: u32 = 0x0002;
pub const MOD_SHIFT: u32 = 0x0004;
pub const MOD_WIN: u32 = 0x0008;
pub const MOD_NOREPEAT: u32 = 0x4000;

/// Where a key is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    /// A layout-independent virtual key (arrows, F-keys, Space, Enter).
    Vk(u32),
    /// A printable key's set-1 scan code, with its US-layout virtual key for when the layout gives none.
    Scan { scan: u32, us_vk: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Combo {
    /// `MOD_ALT | MOD_CONTROL | MOD_SHIFT | MOD_WIN`.
    pub modifiers: u32,
    pub key: Key,
}

/// "Ctrl+Alt+ArrowDown" → the combination; `None` for one this can't hold: no modifier but Shift (a bare key
/// would take typing away), an unknown modifier, a modifier twice, an unknown key.
pub fn parse(text: &str) -> Option<Combo> {
    let parts: Vec<&str> = text.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
    let (code, mods) = parts.split_last()?;
    let key = key_for_code(code)?;
    let mut modifiers = 0;
    for m in mods {
        let bit = match *m {
            "Ctrl" => MOD_CONTROL,
            "Alt" => MOD_ALT,
            "Shift" => MOD_SHIFT,
            "Meta" | "Win" => MOD_WIN,
            _ => return None,
        };
        if modifiers & bit != 0 {
            return None;
        }
        modifiers |= bit;
    }
    (modifiers & (MOD_CONTROL | MOD_ALT | MOD_WIN) != 0).then_some(Combo { modifiers, key })
}

/// The key for a DOM `code` (the codes `shared/shortcuts.ts` accepts, and F13–F24).
pub fn key_for_code(code: &str) -> Option<Key> {
    let fixed = |vk| Some(Key::Vk(vk));
    let scan = |scan, us_vk| Some(Key::Scan { scan, us_vk });
    if let Some(letter) = code.strip_prefix("Key").filter(|l| l.len() == 1) {
        let c = letter.as_bytes()[0];
        if !c.is_ascii_uppercase() {
            return None;
        }
        const SCANS: [u32; 26] = [
            0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, // A–M
            0x31, 0x18, 0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F, 0x11, 0x2D, 0x15, 0x2C, // N–Z
        ];
        return scan(SCANS[(c - b'A') as usize], c as u32);
    }
    if let Some(digit) = code.strip_prefix("Digit").filter(|d| d.len() == 1) {
        let d = digit.as_bytes()[0];
        if !d.is_ascii_digit() {
            return None;
        }
        let s = if d == b'0' { 0x0B } else { 0x02 + (d - b'1') as u32 };
        return scan(s, d as u32);
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        return (1..=24).contains(&n).then_some(Key::Vk(0x70 + n - 1));
    }
    match code {
        "ArrowLeft" => fixed(0x25),
        "ArrowUp" => fixed(0x26),
        "ArrowRight" => fixed(0x27),
        "ArrowDown" => fixed(0x28),
        "Space" => fixed(0x20),
        "Enter" => fixed(0x0D),
        "Backquote" => scan(0x29, 0xC0),
        "Minus" => scan(0x0C, 0xBD),
        "Equal" => scan(0x0D, 0xBB),
        "BracketLeft" => scan(0x1A, 0xDB),
        "BracketRight" => scan(0x1B, 0xDD),
        "Backslash" => scan(0x2B, 0xDC),
        "Semicolon" => scan(0x27, 0xBA),
        "Quote" => scan(0x28, 0xDE),
        "Comma" => scan(0x33, 0xBC),
        "Period" => scan(0x34, 0xBE),
        "Slash" => scan(0x35, 0xBF),
        _ => None,
    }
}

/// How a combination is written back, for the log: "Ctrl+Alt+#28" style, never anything typed.
pub fn describe(c: &Combo) -> String {
    let mut s = String::new();
    for (bit, name) in [(MOD_CONTROL, "Ctrl+"), (MOD_ALT, "Alt+"), (MOD_SHIFT, "Shift+"), (MOD_WIN, "Win+")] {
        if c.modifiers & bit != 0 {
            s.push_str(name);
        }
    }
    match c.key {
        Key::Vk(vk) => s.push_str(&format!("vk{vk:#04x}")),
        Key::Scan { scan, .. } => s.push_str(&format!("sc{scan:#04x}")),
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_extensions_strings() {
        assert_eq!(parse("Ctrl+Alt+ArrowDown"), Some(Combo { modifiers: MOD_CONTROL | MOD_ALT, key: Key::Vk(0x28) }));
        assert_eq!(
            parse("Meta+KeyT"),
            Some(Combo { modifiers: MOD_WIN, key: Key::Scan { scan: 0x14, us_vk: b'T' as u32 } })
        );
        assert_eq!(parse("Ctrl+Shift+Digit0").unwrap().key, Key::Scan { scan: 0x0B, us_vk: b'0' as u32 });
        assert_eq!(parse("Ctrl+Digit1").unwrap().key, Key::Scan { scan: 0x02, us_vk: b'1' as u32 });
        assert_eq!(parse("Alt+KeyS").unwrap().key, Key::Scan { scan: 0x1F, us_vk: b'S' as u32 });
        assert_eq!(parse("Ctrl+F12").unwrap().key, Key::Vk(0x7B));
        assert_eq!(parse("Win+Slash").unwrap().modifiers, MOD_WIN);
    }

    #[test]
    fn refuses_what_it_cant_hold() {
        for text in [
            "KeyT",
            "Shift+KeyT",
            "Ctrl+Ctrl+KeyT",
            "Hyper+KeyT",
            "Ctrl+Keyt",
            "Ctrl+KeyTT",
            "Ctrl+F25",
            "Ctrl+Tab",
            "",
        ] {
            assert_eq!(parse(text), None, "{text}");
        }
    }

    #[test]
    fn every_letter_has_a_distinct_scan_code() {
        let mut seen = std::collections::HashSet::new();
        for c in b'A'..=b'Z' {
            let Some(Key::Scan { scan, .. }) = key_for_code(&format!("Key{}", c as char)) else { panic!() };
            assert!(seen.insert(scan));
        }
        assert_eq!(key_for_code("KeyQ"), Some(Key::Scan { scan: 0x10, us_vk: b'Q' as u32 }));
        assert_eq!(key_for_code("KeyM"), Some(Key::Scan { scan: 0x32, us_vk: b'M' as u32 }));
    }

    #[test]
    fn described_without_text() {
        assert_eq!(describe(&parse("Ctrl+Alt+ArrowDown").unwrap()), "Ctrl+Alt+vk0x28");
    }
}

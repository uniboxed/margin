//! The Mac's sorter for the library's rules (docs/CORE-REFACTOR.md step 4, Tirth's answer after commit 1: the system's):
//! JavaScript's `localeCompare` as JavaScriptCore runs it, by the same calls. JSC's `Intl.Collator` (WebKit
//! IntlCollator.cpp) opens libicucore's collator for its default locale, the person's first preferred language
//! (`CFLocaleCopyPreferredLanguages`), and sets its defaults: tertiary strength (sensitivity "variant"), no case level,
//! case first off (`kf` "false", even for a locale whose data says upper), no numeric ordering, punctuation not
//! ignored, normalization on; then `ucol_strcoll` over the two strings' UTF-16. The same here: 0 bytes of collation
//! data in the app, exact on the Mac by construction (checked against JSC's under 18 preferred languages, step 4 commit
//! 5), one OS call per compare (ties only).

use std::cmp::Ordering;
use std::ffi::{CString, c_char, c_void};

use margin_core::library::js::LocaleCompare;

#[repr(C)]
struct UCollator {
    _private: [u8; 0],
}

// ICU's C API as libicucore exports it (unversioned names); its enums' values (ucol.h).
const UCOL_ALTERNATE_HANDLING: i32 = 1;
const UCOL_CASE_FIRST: i32 = 2;
const UCOL_CASE_LEVEL: i32 = 3;
const UCOL_NORMALIZATION_MODE: i32 = 4;
const UCOL_STRENGTH: i32 = 5;
const UCOL_NUMERIC_COLLATION: i32 = 7;
const UCOL_DEFAULT: i32 = -1;
const UCOL_TERTIARY: i32 = 2;
const UCOL_OFF: i32 = 16;
const UCOL_ON: i32 = 17;

#[cfg_attr(target_os = "macos", link(name = "icucore"))]
unsafe extern "C" {
    fn ucol_open(locale: *const c_char, status: *mut i32) -> *mut UCollator;
    fn ucol_close(collator: *mut UCollator);
    fn ucol_setAttribute(collator: *mut UCollator, attr: i32, value: i32, status: *mut i32);
    fn ucol_strcoll(collator: *const UCollator, a: *const u16, a_len: i32, b: *const u16, b_len: i32) -> i32;
}

type CFTypeRef = *const c_void;

#[cfg_attr(target_os = "macos", link(name = "CoreFoundation", kind = "framework"))]
unsafe extern "C" {
    fn CFLocaleCopyPreferredLanguages() -> CFTypeRef;
    fn CFArrayGetCount(array: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, index: isize) -> CFTypeRef;
    fn CFStringGetCString(string: CFTypeRef, buffer: *mut c_char, size: isize, encoding: u32) -> bool;
    fn CFRelease(cf: CFTypeRef);
}

const UTF8: u32 = 0x0800_0100;

/// The person's first preferred language (`en-US`), as JSC takes its default locale; `en` when there's none.
pub fn preferred_language() -> String {
    // SAFETY: CoreFoundation's documented calls; the array is ours (Copy) and released once; each value an array
    // item (a CFString) read into a buffer of its size.
    unsafe {
        let list = CFLocaleCopyPreferredLanguages();
        if list.is_null() {
            return "en".into();
        }
        let mut out = None;
        if CFArrayGetCount(list) > 0 {
            let first = CFArrayGetValueAtIndex(list, 0);
            let mut buf = [0 as c_char; 128];
            if !first.is_null() && CFStringGetCString(first, buf.as_mut_ptr(), buf.len() as isize, UTF8) {
                out = std::ffi::CStr::from_ptr(buf.as_ptr()).to_str().ok().map(str::to_owned);
            }
        }
        CFRelease(list);
        out.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into())
    }
}

/// libicucore's collator, set as JSC sets it. Not `Send`: one per owner, on its thread.
pub struct SystemCollation {
    collator: *mut UCollator,
}

impl SystemCollation {
    /// For a BCP 47 tag (`en-US`, `da`); one ICU can't open is root's.
    pub fn new(locale: &str) -> SystemCollation {
        let tag = CString::new(locale.replace('-', "_")).unwrap_or_default();
        let mut status = 0i32;
        // SAFETY: a NUL-terminated tag and a status ICU writes; null or a collator we own.
        let mut collator = unsafe { ucol_open(tag.as_ptr(), &mut status) };
        if status > 0 || collator.is_null() {
            status = 0;
            // SAFETY: as above, the root locale.
            collator = unsafe { ucol_open(c"".as_ptr(), &mut status) };
        }
        if !collator.is_null() {
            for (attr, value) in [
                (UCOL_STRENGTH, UCOL_TERTIARY),
                (UCOL_CASE_LEVEL, UCOL_OFF),
                (UCOL_CASE_FIRST, UCOL_OFF),
                (UCOL_NUMERIC_COLLATION, UCOL_OFF),
                (UCOL_ALTERNATE_HANDLING, UCOL_DEFAULT),
                (UCOL_NORMALIZATION_MODE, UCOL_ON),
            ] {
                let mut status = 0i32;
                // SAFETY: our collator; ICU's attribute values.
                unsafe { ucol_setAttribute(collator, attr, value, &mut status) };
            }
        }
        SystemCollation { collator }
    }

    /// The person's (JSC's default locale).
    pub fn preferred() -> SystemCollation {
        SystemCollation::new(&preferred_language())
    }
}

impl Drop for SystemCollation {
    fn drop(&mut self) {
        if !self.collator.is_null() {
            // SAFETY: ours, closed once.
            unsafe { ucol_close(self.collator) };
        }
    }
}

/// A string's UTF-16 on the stack when it's short (an id), else on the heap.
fn units<R>(s: &str, f: impl FnOnce(&[u16]) -> R) -> R {
    let mut stack = [0u16; 128];
    if s.len() <= stack.len() {
        let mut n = 0;
        for u in s.encode_utf16() {
            stack[n] = u;
            n += 1;
        }
        return f(&stack[..n]);
    }
    let heap: Vec<u16> = s.encode_utf16().collect();
    f(&heap)
}

impl LocaleCompare for SystemCollation {
    fn compare(&self, a: &str, b: &str) -> Ordering {
        if a == b {
            return Ordering::Equal;
        }
        if self.collator.is_null() {
            return a.cmp(b);
        }
        let len = |u: &[u16]| i32::try_from(u.len()).unwrap_or(i32::MAX);
        // SAFETY: our collator; each slice's units and length.
        let r = units(a, |ua| {
            units(b, |ub| unsafe { ucol_strcoll(self.collator, ua.as_ptr(), len(ua), ub.as_ptr(), len(ub)) })
        });
        r.cmp(&0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use margin_core::library::js::locale_compare;
    use margin_core::library::vectors::js;

    fn s(v: &serde_json::Value) -> &str {
        v.as_str().unwrap_or("")
    }

    // js.json's localeCompare cases (JSC's answers on this Mac, en-US: commit 0's): the printable characters' order,
    // every pair's sign, the ids' and the accents' pairs; and what the core's tests used ICU4X for (vectors_tests.rs
    // `js_json_collation` and js_tests.rs's locale tests before Tirth's answer: the system's sorter).
    #[test]
    fn js_json_collation() {
        let js = js();
        assert_eq!(js["locale"], "en-US");
        let c = SystemCollation::new("en-US");
        let order: Vec<String> = s(&js["cases"]["asciiOrder"]).chars().map(String::from).collect();
        assert_eq!(order.len(), 95);
        for (i, a) in order.iter().enumerate() {
            for (j, b) in order.iter().enumerate() {
                assert_eq!(c.compare(a, b), i.cmp(&j), "{a:?} vs {b:?}");
            }
        }
        let ascii: Vec<String> = (0x20u8..0x7f).map(|b| char::from(b).to_string()).collect();
        let signs: Vec<char> = s(&js["cases"]["asciiSigns"]).chars().collect();
        for (i, a) in ascii.iter().enumerate() {
            for (j, b) in ascii.iter().enumerate() {
                let want = match signs[i * ascii.len() + j] {
                    '-' => Ordering::Less,
                    '0' => Ordering::Equal,
                    _ => Ordering::Greater,
                };
                assert_eq!(c.compare(a, b), want, "{a:?} vs {b:?}");
            }
        }
        let pairs = js["cases"]["pairs"].as_array().expect("pairs");
        for r in pairs {
            assert_eq!(locale_compare(&c, s(&r[0]), s(&r[1])), r[2].as_i64().unwrap().cmp(&0), "{} vs {}", r[0], r[1]);
        }
        assert!(pairs.len() >= 22);
    }

    #[test]
    fn the_locale_is_taken() {
        // A tailored locale reorders ASCII: Danish puts "aa" (å) after "z". A tag ICU can't open is root's.
        assert_eq!(SystemCollation::new("en-US").compare("aa", "z"), Ordering::Less);
        assert_eq!(SystemCollation::new("da").compare("aa", "z"), Ordering::Greater);
        assert_eq!(SystemCollation::new("not a tag!").compare("aa", "z"), Ordering::Less);
        // Case first off, as JSC sets it: lower before upper even where a locale's data says upper (Danish).
        assert_eq!(SystemCollation::new("da").compare("a", "A"), Ordering::Less);
        assert!(!preferred_language().is_empty());
        let long = "x".repeat(300);
        assert_eq!(SystemCollation::new("en").compare(&long, &format!("{long}y")), Ordering::Less, "past the stack");
        let near = "x".repeat(110);
        assert_eq!(
            SystemCollation::new("en").compare(&format!("{near}a"), &format!("{near}b")),
            Ordering::Less,
            "all of it"
        );
        assert_eq!(SystemCollation::new("en").compare("a", "a\0"), Ordering::Equal, "what collation ignores");
    }
}

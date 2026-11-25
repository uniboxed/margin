//! Windows' sorter for the library's rules (docs/CORE-REFACTOR.md step 4, Tirth's answer after commit 1: the system's
//! sorter, handed to margin-core as its `LocaleCompare`): JavaScript's `localeCompare` over Windows' own ICU, icu.dll
//! (Windows 10 1903 and later: ICU's C API under its unversioned names, the SDK's icu.lib), set as JavaScriptCore sets
//! its collator on the Mac (margin-ffi collation.rs: tertiary strength, no case level, case first off, no numeric
//! ordering, punctuation not ignored, normalization on), for ICU's default locale (the user's). Compile-checked from the
//! Mac only (`--target x86_64-pc-windows-msvc`); unverified on a PC until the Windows shell's library runs on it.

use std::cmp::Ordering;
use std::ffi::{CString, c_char};

use margin_core::library::js::LocaleCompare;

#[repr(C)]
struct UCollator {
    _private: [u8; 0],
}

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

#[link(name = "icu")]
unsafe extern "C" {
    fn ucol_open(locale: *const c_char, status: *mut i32) -> *mut UCollator;
    fn ucol_close(collator: *mut UCollator);
    fn ucol_setAttribute(collator: *mut UCollator, attr: i32, value: i32, status: *mut i32);
    fn ucol_strcoll(collator: *const UCollator, a: *const u16, a_len: i32, b: *const u16, b_len: i32) -> i32;
}

/// icu.dll's collator. Not `Send`: one per owner, on its thread.
pub struct SystemCollation {
    collator: *mut UCollator,
}

impl SystemCollation {
    /// For an ICU locale id (`en_US`; empty: ICU's default, the user's); one ICU can't open is root's.
    pub fn new(locale: &str) -> SystemCollation {
        let tag = CString::new(locale.replace('-', "_")).unwrap_or_default();
        let mut status = 0i32;
        // SAFETY: a NUL-terminated id (empty: ICU's default) and a status ICU writes; null or a collator we own.
        let mut collator =
            unsafe { ucol_open(if locale.is_empty() { std::ptr::null() } else { tag.as_ptr() }, &mut status) };
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

    /// The user's (ICU's default locale).
    pub fn preferred() -> SystemCollation {
        SystemCollation::new("")
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

impl LocaleCompare for SystemCollation {
    fn compare(&self, a: &str, b: &str) -> Ordering {
        if a == b {
            return Ordering::Equal;
        }
        if self.collator.is_null() {
            return a.cmp(b);
        }
        let (ua, ub): (Vec<u16>, Vec<u16>) = (a.encode_utf16().collect(), b.encode_utf16().collect());
        let len = |u: &[u16]| i32::try_from(u.len()).unwrap_or(i32::MAX);
        // SAFETY: our collator; each vector's units and length.
        let r = unsafe { ucol_strcoll(self.collator, ua.as_ptr(), len(&ua), ub.as_ptr(), len(&ub)) };
        r.cmp(&0)
    }
}

//! Margin's lasting data (docs/DATA.md), ported from app/macos/shell/: the data set and its merge (`set`, DataSet.swift),
//! the per-profile files (`store`, DataStore.swift), the `data.*` messages (`sync`, DataSync.swift), the spaces
//! across a browser's profiles (`profiles`, BrowserProfiles.swift) and the imported themes (`themes`,
//! ThemeStore.swift and the OS-neutral part of ShellThemes.swift).
//!
//! The Swift shell logs through `Diagnostics`; margin-core has no logger, so what Swift logs is handed back as
//! [`Note`]s for the shell to write (never a name, an address or content, as in Swift).

pub mod profiles;
pub mod set;
pub mod store;
pub mod sync;
pub mod themes;

use serde_json::Value;

/// A line for the shell's log: what the Swift shell says with `Diagnostics.note` or `.warn`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Note {
    pub warn: bool,
    pub text: String,
}

impl Note {
    #[allow(clippy::self_named_constructors)]
    pub(crate) fn note(text: impl Into<String>) -> Self {
        Self { warn: false, text: text.into() }
    }
    pub(crate) fn warn(text: impl Into<String>) -> Self {
        Self { warn: true, text: text.into() }
    }
}

/// A number as JSON: a whole one as an integer (JSONSerialization writes 100.0 as `100`; serde_json would write
/// `100.0`), anything else as a float.
pub(crate) fn number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        Value::from(n as i64)
    } else {
        Value::from(n)
    }
}

/// UTF-8 JSON with every object's keys sorted, as the Swift shell writes its files (`.sortedKeys`).
pub(crate) fn sorted_json(value: &Value) -> Vec<u8> {
    let mut v = value.clone();
    v.sort_all_objects();
    // Serializing a Value can't fail (its keys are strings, its numbers finite).
    serde_json::to_vec(&v).unwrap_or_default()
}

/// `n` random bytes as lower-case hex. The OS's generator; if it fails (it doesn't, on any OS Margin runs on),
/// the clock's nanoseconds, which still keep two calls apart.
pub(crate) fn random_hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    if getrandom::fill(&mut bytes).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = (t >> ((i % 16) * 8)) as u8 ^ (i as u8).wrapping_mul(31);
        }
    }
    hex::encode(bytes)
}

/// The first `n` characters of `s` (Swift's `prefix(n)` counts Characters, grapheme clusters; this counts
/// Unicode scalars, which can only keep less).
pub(crate) fn prefix(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

#[cfg(test)]
pub(crate) mod testing {
    use serde_json::Value;

    /// Two JSON values the same, numbers compared as numbers and object keys in any order (the vectors' rule).
    pub fn same(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
            (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
            }
            _ => a == b,
        }
    }

    pub fn temp() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("margin-core-data-").tempdir().expect("a temporary folder")
    }
}

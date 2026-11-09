//! Times: seconds since 1970 as f64, as the Swift shell keeps them (`Date().timeIntervalSince1970`). The link's
//! messages carry milliseconds (`Date.now()`); convert at the edge.

/// Seconds since 1970.
pub type Secs = f64;

pub fn now() -> Secs {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Milliseconds since 1970 (the messages' `at`, `Date.now()`).
pub fn now_ms() -> f64 {
    (now() * 1000.0).round()
}

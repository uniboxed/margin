//! Reading untrusted JSON the way the Swift shell does (`num`, `int` in app/platforms/macos/shell/LinkMessage.swift): a number
//! that's finite, an integer that's whole and fits, a string, a bool. Nothing here panics on any input.

use serde_json::{Map, Value};

pub type Object = Map<String, Value>;

/// A finite number.
pub fn num(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|n| n.is_finite())
}

/// A whole number that fits in an i64 (2.0 is 2; 2.5 isn't one).
pub fn int(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    if let Some(i) = v.as_i64() {
        return Some(i);
    }
    let f = v.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15).then_some(f as i64)
}

pub fn string(v: Option<&Value>) -> Option<&str> {
    v?.as_str()
}

pub fn boolean(v: Option<&Value>) -> Option<bool> {
    v?.as_bool()
}

pub fn object(v: Option<&Value>) -> Option<&Object> {
    v?.as_object()
}

pub fn array(v: Option<&Value>) -> Option<&Vec<Value>> {
    v?.as_array()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ints_are_whole() {
        assert_eq!(int(Some(&json!(2.0))), Some(2));
        assert_eq!(int(Some(&json!(2.5))), None);
        assert_eq!(int(Some(&json!("2"))), None);
        assert_eq!(int(None), None);
    }
}

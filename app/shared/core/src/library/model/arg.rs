//! A payload's value as a rule of model.ts receives it from library.ts (`p?.field`, `p?.field ?? null`, a caller's
//! string): shared by every piece of the model's rules (moved here from order.rs, where piece 1 made it).

use std::borrow::Cow;

use serde_json::Value;

use crate::library::js;

/// A value as a rule of M receives it from library.ts: `undefined` (a payload's missing field), a JSON value (any type:
/// a payload's), or a string the caller has (an id, a title). The tests M makes of it are its methods.
#[derive(Clone, Copy, Debug)]
pub enum Arg<'a> {
    Undefined,
    Value(&'a Value),
    Str(&'a str),
}

impl<'a> Arg<'a> {
    /// `p?.field`: a payload's field as it came (missing: undefined).
    pub fn of(v: Option<&'a Value>) -> Arg<'a> {
        v.map_or(Arg::Undefined, Arg::Value)
    }

    /// `p?.field ?? null` (undefined as null).
    pub fn or_null(self) -> Arg<'a> {
        match self {
            Arg::Undefined => Arg::Value(&Value::Null),
            other => other,
        }
    }

    /// The string it is (`typeof v === 'string'`): the only kind `=== id` can be true of.
    pub fn as_str(self) -> Option<&'a str> {
        match self {
            Arg::Str(s) => Some(s),
            Arg::Value(Value::String(s)) => Some(s),
            _ => None,
        }
    }

    /// `!!v`.
    pub fn truthy(self) -> bool {
        match self {
            Arg::Undefined => false,
            Arg::Str(s) => !s.is_empty(),
            Arg::Value(v) => js::truthy(Some(v)),
        }
    }

    /// `v == null`.
    pub fn nullish(self) -> bool {
        matches!(self, Arg::Undefined | Arg::Value(Value::Null))
    }

    /// `v === null` (not undefined).
    pub fn is_null(self) -> bool {
        matches!(self, Arg::Value(Value::Null))
    }

    /// `String(v ?? '')`.
    pub fn text(self) -> Cow<'a, str> {
        match self {
            Arg::Undefined | Arg::Value(Value::Null) => Cow::Borrowed(""),
            Arg::Str(s) => Cow::Borrowed(s),
            Arg::Value(v) => js::to_string(v),
        }
    }

    /// `v ? v : null` for an id: the string when it's a string and not empty, `Err(())` when it's truthy but no string
    /// (an id no record has), `Ok(None)` when it's falsy.
    pub(crate) fn truthy_id(self) -> Result<Option<&'a str>, ()> {
        match (self.truthy(), self.as_str()) {
            (false, _) => Ok(None),
            (true, Some(s)) => Ok(Some(s)),
            (true, None) => Err(()),
        }
    }
}

impl<'a> From<&'a str> for Arg<'a> {
    fn from(s: &'a str) -> Arg<'a> {
        Arg::Str(s)
    }
}

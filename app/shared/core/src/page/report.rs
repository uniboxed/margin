//! The page's layout report read straight into a kept `PageLayout` (docs/CORE-REFACTOR.md step 3 part 7: a drag's every
//! frame sends one): the same answer as `serde_json::from_slice::<Value>` then `PageLayout::from_geometry`, with no
//! `Value` made and nothing allocated once the layout's buffers have grown (its texts and lists written in place).
//!
//! The JSON is read by serde_json's own deserializer, every value through `deserialize_any` (as a `Value` is read: the
//! numbers, the strings' escapes and the nesting limit checked alike), so what one refuses the other does. A key said
//! twice counts as its last (a `Value`'s map keeps the last). A string with an escape in it goes through the
//! deserializer's scratch buffer (allocated; the page's JSON.stringify writes none in a report's ids, modes and colours).

use std::fmt;

use serde::de::{DeserializeSeed, Deserializer, Error as _, MapAccess, SeqAccess, Visitor};

use crate::geometry::Rect;
use crate::protocol::{MAX_PANES, PageLayout, PagePane};

/// `bytes` read into `out` (its buffers reused): true when they're a layout report (`from_geometry`'s `Some`). False:
/// not one, and `out` is left in no particular state.
pub fn read_into(bytes: &[u8], out: &mut PageLayout) -> bool {
    // (Invalid UTF-8 anywhere is refused, as `from_slice::<Value>` refuses it: in a string, or as a syntax error.)
    if std::str::from_utf8(bytes).is_err() {
        return false;
    }
    let mut said = Said::default();
    let mut de = serde_json::Deserializer::from_slice(bytes);
    let read = Top { said: &mut said, out: &mut *out }.deserialize(&mut de).is_ok() && de.end().is_ok();
    read && said.finish(out)
}

/// What the report said, as `from_geometry` weighs it (each key's last value).
#[derive(Default)]
struct Said {
    insets: Option<[Option<f64>; 4]>,
    container: Option<[Option<f64>; 2]>,
    radius: Option<f64>,
    /// The radii said (the first four numbers kept in `out.radii`), and how many numbers.
    radii: usize,
    mode: bool,
    outside: Option<bool>,
    hosted: Option<bool>,
    /// The fills' array's length (its first four in `out.fills`), None: no array.
    fills: Option<usize>,
    split: bool,
    /// The panes' array: its length, and whether every one so far is one (the first [`MAX_PANES`] in `out.panes`).
    panes: Option<(usize, bool)>,
}

impl Said {
    fn finish(&self, out: &mut PageLayout) -> bool {
        let Some([Some(left), Some(top), Some(right), Some(bottom)]) = self.insets else { return false };
        let Some([Some(width), Some(height)]) = self.container else { return false };
        if !(width > 0.0 && height > 0.0) {
            return false;
        }
        let radius = self.radius.unwrap_or(0.0);
        out.left = left;
        out.top = top;
        out.right = right;
        out.bottom = bottom;
        out.radius = radius.max(0.0);
        // (As the Swift: four radii or the radius as given, before it's kept from going below 0.)
        if self.radii != 4 {
            out.radii.clear();
            out.radii.extend_from_slice(&[radius; 4]);
        }
        out.width = width;
        out.height = height;
        if !self.mode {
            out.mode.clear();
            out.mode.push_str("fullscreen");
        }
        out.outside = self.outside == Some(true);
        out.hosted = self.hosted == Some(true);
        if self.fills.is_none_or(|n| n < 4) {
            out.fills.clear();
        }
        let panes = self.panes.is_some_and(|(n, ok)| (2..=MAX_PANES).contains(&n) && ok && unique(&out.panes[..n]));
        if !(self.split && panes) {
            out.split = None;
            out.panes.clear();
        }
        true
    }
}

fn unique(panes: &[PagePane]) -> bool {
    panes.iter().enumerate().all(|(i, p)| panes[..i].iter().all(|q| q.item != p.item))
}

/// A text written into a kept string (its buffer reused).
fn put(s: &mut String, v: &str) {
    s.clear();
    s.push_str(v);
}

/// One JSON value as `from_geometry` reads it.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Scalar {
    Num(f64),
    Bool(bool),
    Other,
}

impl Scalar {
    /// `json::num`: a finite number.
    fn num(self) -> Option<f64> {
        match self {
            Scalar::Num(n) if n.is_finite() => Some(n),
            _ => None,
        }
    }
    /// `json::flag`: a bool, or a number exactly 1 or 0.
    fn flag(self) -> Option<bool> {
        match self {
            Scalar::Bool(b) => Some(b),
            Scalar::Num(1.0) => Some(true),
            Scalar::Num(0.0) => Some(false),
            _ => None,
        }
    }
}

/// A value read and kept only if it's a number or a bool (anything else read whole and dropped, nothing kept).
struct ScalarSeed;

impl<'de> DeserializeSeed<'de> for ScalarSeed {
    type Value = Scalar;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Scalar, D::Error> {
        d.deserialize_any(ScalarVisitor)
    }
}

struct ScalarVisitor;

impl<'de> Visitor<'de> for ScalarVisitor {
    type Value = Scalar;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_bool<E>(self, v: bool) -> Result<Scalar, E> {
        Ok(Scalar::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<Scalar, E> {
        Ok(Scalar::Num(v as f64))
    }
    fn visit_u64<E>(self, v: u64) -> Result<Scalar, E> {
        Ok(Scalar::Num(v as f64))
    }
    fn visit_f64<E>(self, v: f64) -> Result<Scalar, E> {
        Ok(Scalar::Num(v))
    }
    fn visit_str<E>(self, _: &str) -> Result<Scalar, E> {
        Ok(Scalar::Other)
    }
    fn visit_unit<E>(self) -> Result<Scalar, E> {
        Ok(Scalar::Other)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Scalar, A::Error> {
        while a.next_element_seed(Skip)?.is_some() {}
        Ok(Scalar::Other)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Scalar, A::Error> {
        while a.next_key_seed(Skip)?.is_some() {
            a.next_value_seed(Skip)?;
        }
        Ok(Scalar::Other)
    }
}

/// A value read whole (as a `Value` would be: its numbers parsed, its strings checked) and dropped.
struct Skip;

impl<'de> DeserializeSeed<'de> for Skip {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(ScalarVisitor).map(|_| ())
    }
}

/// A string handed to `keep` (whose answer is the value's), anything else read whole and dropped (false).
struct TextSeed<F: FnOnce(&str) -> bool>(F);

fn text<F: FnOnce(&str) -> bool>(keep: F) -> TextSeed<F> {
    TextSeed(keep)
}

impl<'de, F: FnOnce(&str) -> bool> DeserializeSeed<'de> for TextSeed<F> {
    type Value = bool;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<bool, D::Error> {
        struct V<F>(F);
        impl<'de, F: FnOnce(&str) -> bool> Visitor<'de> for V<F> {
            type Value = bool;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_str<E>(self, v: &str) -> Result<bool, E> {
                Ok((self.0)(v))
            }
            fn visit_bool<E>(self, _: bool) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_i64<E>(self, _: i64) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_u64<E>(self, _: u64) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_f64<E>(self, _: f64) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_unit<E>(self) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, a: A) -> Result<bool, A::Error> {
                ScalarVisitor.visit_seq(a).map(|_| false)
            }
            fn visit_map<A: MapAccess<'de>>(self, a: A) -> Result<bool, A::Error> {
                ScalarVisitor.visit_map(a).map(|_| false)
            }
        }
        d.deserialize_any(V(self.0))
    }
}

/// Which of the report's keys (anything else is read and dropped).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Key {
    Insets,
    Container,
    Radius,
    Radii,
    Mode,
    Outside,
    Hosted,
    Fills,
    Split,
    Panes,
    Other,
}

struct KeySeed<F: Fn(&str) -> u8>(F);

impl<'de, F: Fn(&str) -> u8> DeserializeSeed<'de> for KeySeed<F> {
    type Value = u8;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<u8, D::Error> {
        struct V<F>(F);
        impl<'de, F: Fn(&str) -> u8> Visitor<'de> for V<F> {
            type Value = u8;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a key")
            }
            fn visit_str<E>(self, v: &str) -> Result<u8, E> {
                Ok((self.0)(v))
            }
        }
        d.deserialize_str(V(self.0))
    }
}

fn top_key(k: &str) -> u8 {
    (match k {
        "insets" => Key::Insets,
        "container" => Key::Container,
        "radius" => Key::Radius,
        "radii" => Key::Radii,
        "mode" => Key::Mode,
        "pageOutside" => Key::Outside,
        "pageHosted" => Key::Hosted,
        "fills" => Key::Fills,
        "split" => Key::Split,
        "panes" => Key::Panes,
        _ => Key::Other,
    }) as u8
}

const KEYS: [Key; 11] = [
    Key::Insets,
    Key::Container,
    Key::Radius,
    Key::Radii,
    Key::Mode,
    Key::Outside,
    Key::Hosted,
    Key::Fills,
    Key::Split,
    Key::Panes,
    Key::Other,
];

/// The report: an object (anything else isn't one).
struct Top<'a> {
    said: &'a mut Said,
    out: &'a mut PageLayout,
}

impl<'de> DeserializeSeed<'de> for Top<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Top<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a layout report")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<(), A::Error> {
        let Top { said, out } = self;
        while let Some(k) = a.next_key_seed(KeySeed(top_key))? {
            match KEYS[k as usize] {
                Key::Insets => {
                    said.insets = a.next_value_seed(Fields::<4>(["left", "top", "right", "bottom"]))?;
                }
                Key::Container => said.container = a.next_value_seed(Fields::<2>(["width", "height"]))?,
                Key::Radius => said.radius = a.next_value_seed(ScalarSeed)?.num(),
                Key::Radii => said.radii = a.next_value_seed(Numbers(&mut out.radii))?,
                Key::Mode => said.mode = a.next_value_seed(text(|s| (put(&mut out.mode, s), true).1))?,
                Key::Outside => said.outside = a.next_value_seed(ScalarSeed)?.flag(),
                Key::Hosted => said.hosted = a.next_value_seed(ScalarSeed)?.flag(),
                Key::Fills => said.fills = a.next_value_seed(Fills(&mut out.fills))?,
                Key::Split => {
                    let split = &mut out.split;
                    said.split = a.next_value_seed(text(|s| {
                        if !PagePane::id_ok(s) {
                            return false;
                        }
                        match split {
                            Some(was) => put(was, s),
                            None => *split = Some(s.to_owned()),
                        }
                        true
                    }))?;
                }
                Key::Panes => said.panes = a.next_value_seed(Panes(&mut out.panes))?,
                Key::Other => a.next_value_seed(Skip)?,
            }
        }
        Ok(())
    }
    // (Not an object: not a report; read through to say so as `from_slice` would only after the whole of it.)
    fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<(), E> {
        Err(E::custom("not a report"))
    }
    fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<(), E> {
        Err(E::custom("not a report"))
    }
    fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<(), E> {
        Err(E::custom("not a report"))
    }
    fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<(), E> {
        Err(E::custom("not a report"))
    }
    fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<(), E> {
        Err(E::custom("not a report"))
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<(), E> {
        Err(E::custom("not a report"))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, _: A) -> Result<(), A::Error> {
        Err(A::Error::custom("not a report"))
    }
}

/// An object's named numbers (`insets`, `container`), each key's last; None: not an object.
struct Fields<const N: usize>([&'static str; N]);

impl<'de, const N: usize> DeserializeSeed<'de> for Fields<N> {
    type Value = Option<[Option<f64>; N]>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de, const N: usize> Visitor<'de> for Fields<N> {
    type Value = Option<[Option<f64>; N]>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
        let names = self.0;
        let mut out = [None; N];
        while let Some(k) =
            a.next_key_seed(KeySeed(|k| names.iter().position(|n| *n == k).map_or(u8::MAX, |i| i as u8)))?
        {
            match out.get_mut(k as usize) {
                Some(slot) => *slot = a.next_value_seed(ScalarSeed)?.num(),
                None => a.next_value_seed(Skip)?,
            }
        }
        Ok(Some(out))
    }
    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, a: A) -> Result<Self::Value, A::Error> {
        ScalarVisitor.visit_seq(a).map(|_| None)
    }
}

/// An array's numbers (`radii`: the first four kept), how many; 0 for anything else.
struct Numbers<'a>(&'a mut Vec<f64>);

impl<'de> DeserializeSeed<'de> for Numbers<'_> {
    type Value = usize;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<usize, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Numbers<'_> {
    type Value = usize;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<usize, A::Error> {
        self.0.clear();
        let mut n = 0;
        while let Some(v) = a.next_element_seed(ScalarSeed)? {
            if let Some(v) = v.num() {
                if n < 4 {
                    self.0.push(v);
                }
                n += 1;
            }
        }
        Ok(n)
    }
    fn visit_bool<E>(self, _: bool) -> Result<usize, E> {
        Ok(0)
    }
    fn visit_i64<E>(self, _: i64) -> Result<usize, E> {
        Ok(0)
    }
    fn visit_u64<E>(self, _: u64) -> Result<usize, E> {
        Ok(0)
    }
    fn visit_f64<E>(self, _: f64) -> Result<usize, E> {
        Ok(0)
    }
    fn visit_str<E>(self, _: &str) -> Result<usize, E> {
        Ok(0)
    }
    fn visit_unit<E>(self) -> Result<usize, E> {
        Ok(0)
    }
    fn visit_map<A: MapAccess<'de>>(self, a: A) -> Result<usize, A::Error> {
        ScalarVisitor.visit_map(a).map(|_| 0)
    }
}

/// The fills: the array's length (its first four, each a text of at most 80 scalars else "", in `out.fills`), None:
/// not an array.
struct Fills<'a>(&'a mut Vec<String>);

impl<'de> DeserializeSeed<'de> for Fills<'_> {
    type Value = Option<usize>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Option<usize>, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Fills<'_> {
    type Value = Option<usize>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Option<usize>, A::Error> {
        let fills = self.0;
        let mut n = 0;
        loop {
            if n < 4 {
                if fills.len() <= n {
                    fills.push(String::new());
                }
                let slot = &mut fills[n];
                let said = a.next_element_seed(text(|s| {
                    if s.chars().count() > 80 {
                        return false;
                    }
                    put(slot, s);
                    true
                }))?;
                match said {
                    None => break,
                    Some(true) => {}
                    Some(false) => slot.clear(),
                }
            } else if a.next_element_seed(Skip)?.is_none() {
                break;
            }
            n += 1;
        }
        fills.truncate(n.min(4));
        Ok(Some(n))
    }
    fn visit_bool<E>(self, _: bool) -> Result<Option<usize>, E> {
        Ok(None)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Option<usize>, E> {
        Ok(None)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Option<usize>, E> {
        Ok(None)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Option<usize>, E> {
        Ok(None)
    }
    fn visit_str<E>(self, _: &str) -> Result<Option<usize>, E> {
        Ok(None)
    }
    fn visit_unit<E>(self) -> Result<Option<usize>, E> {
        Ok(None)
    }
    fn visit_map<A: MapAccess<'de>>(self, a: A) -> Result<Option<usize>, A::Error> {
        ScalarVisitor.visit_map(a).map(|_| None)
    }
}

/// The panes: the array's length and whether each one (the first [`MAX_PANES`] kept in `out.panes`) is a pane; None: not an
/// array.
struct Panes<'a>(&'a mut Vec<PagePane>);

impl<'de> DeserializeSeed<'de> for Panes<'_> {
    type Value = Option<(usize, bool)>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Panes<'_> {
    type Value = Option<(usize, bool)>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
        let panes = self.0;
        let (mut n, mut ok) = (0, true);
        loop {
            if n < MAX_PANES {
                if panes.len() <= n {
                    panes.push(PagePane { item: String::new(), rect: Rect::ZERO, folded: false });
                }
                match a.next_element_seed(Pane(&mut panes[n]))? {
                    None => break,
                    Some(one) => ok &= one,
                }
            } else if a.next_element_seed(Skip)?.is_none() {
                break;
            }
            n += 1;
        }
        panes.truncate(n.min(MAX_PANES));
        Ok(Some((n, ok)))
    }
    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_map<A: MapAccess<'de>>(self, a: A) -> Result<Self::Value, A::Error> {
        ScalarVisitor.visit_map(a).map(|_| None)
    }
}

/// One pane (`PagePane::from_json`): `{ id, rect: [x, y, width, height], folded? }`, written into `out`; whether it's
/// one.
struct Pane<'a>(&'a mut PagePane);

impl<'de> DeserializeSeed<'de> for Pane<'_> {
    type Value = bool;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<bool, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Pane<'_> {
    type Value = bool;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<bool, A::Error> {
        let pane = self.0;
        let (mut id, mut rect, mut folded) = (false, None, false);
        while let Some(k) = a.next_key_seed(KeySeed(|k| match k {
            "id" => 0,
            "rect" => 1,
            "folded" => 3,
            _ => 2,
        }))? {
            match k {
                0 => {
                    let item = &mut pane.item;
                    id = a.next_value_seed(text(|s| PagePane::id_ok(s) && (put(item, s), true).1))?;
                }
                1 => rect = a.next_value_seed(Box4)?,
                3 => folded = a.next_value_seed(ScalarSeed)?.flag() == Some(true),
                _ => a.next_value_seed(Skip)?,
            }
        }
        let Some([x, y, w, h]) = rect else { return Ok(false) };
        if !(id && w > 0.0 && h > 0.0) {
            return Ok(false);
        }
        pane.rect = Rect::new(x, y, w, h);
        pane.folded = folded;
        Ok(true)
    }
    fn visit_bool<E>(self, _: bool) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_i64<E>(self, _: i64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_u64<E>(self, _: u64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_f64<E>(self, _: f64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_str<E>(self, _: &str) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_unit<E>(self) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, a: A) -> Result<bool, A::Error> {
        ScalarVisitor.visit_seq(a).map(|_| false)
    }
}

/// A pane's box: exactly four elements, each a finite number; None: anything else.
struct Box4;

impl<'de> DeserializeSeed<'de> for Box4 {
    type Value = Option<[f64; 4]>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Box4 {
    type Value = Option<[f64; 4]>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
        let (mut out, mut n, mut ok) = ([0.0; 4], 0, true);
        while let Some(v) = a.next_element_seed(ScalarSeed)? {
            match (v.num(), out.get_mut(n)) {
                (Some(v), Some(slot)) => *slot = v,
                _ => ok = false,
            }
            n += 1;
        }
        Ok((ok && n == 4).then_some(out))
    }
    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_map<A: MapAccess<'de>>(self, a: A) -> Result<Self::Value, A::Error> {
        ScalarVisitor.visit_map(a).map(|_| None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn by_value(bytes: &[u8]) -> Option<PageLayout> {
        match serde_json::from_slice::<Value>(bytes) {
            Ok(Value::Object(g)) => PageLayout::from_geometry(&g),
            _ => None,
        }
    }

    fn by_seed(bytes: &[u8], into: &mut PageLayout) -> Option<PageLayout> {
        read_into(bytes, into).then(|| into.clone())
    }

    /// A small generator of reports and near-reports: every key, every kind of value, twice said, nested, odd numbers
    /// and escapes, broken JSON.
    struct Gen(u64);
    impl Gen {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 11
        }
        fn pick<'a>(&mut self, l: &[&'a str]) -> &'a str {
            l[(self.next() % l.len() as u64) as usize]
        }
        fn chance(&mut self, p: f64) -> bool {
            (self.next() % 10_000) as f64 / 10_000.0 < p
        }
        fn num(&mut self) -> String {
            self.pick(&[
                "0",
                "-0",
                "1",
                "1.0",
                "0.0",
                "-3.5",
                "260",
                "1512",
                "949.25",
                "1e2",
                "1E-2",
                "2.5e+3",
                "1e400",
                "-1e400",
                "0.1",
                "12345678901234567890",
                "-9223372036854775809",
                "4.94e-324",
                "01",
                "1.",
                "-",
                "true",
                "false",
                "null",
                "\"8\"",
                "[1]",
                "{}",
            ])
            .to_string()
        }
        fn text(&mut self) -> String {
            let s = self.pick(&[
                "fullscreen",
                "windowed",
                "",
                "sp-1",
                "t1",
                "t2",
                "t:3.x",
                "a b",
                "é",
                "\\u00e9",
                "\\ud83d\\ude00",
                "\\ud83d",
                "\\\"",
                "rgb(1, 2, 3)",
                "#fff",
                "transparent",
                "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                "\\u0000",
                "\t",
            ]);
            format!("\"{s}\"")
        }
        fn value(&mut self, depth: u32) -> String {
            match self.next() % 10 {
                0..=3 => self.num(),
                4..=5 => self.text(),
                6 if depth < 3 => {
                    let n = self.next() % 6;
                    let items: Vec<String> = (0..n).map(|_| self.value(depth + 1)).collect();
                    format!("[{}]", items.join(","))
                }
                7 if depth < 3 => {
                    let n = self.next() % 4;
                    let items: Vec<String> =
                        (0..n).map(|_| format!("{}:{}", self.text(), self.value(depth + 1))).collect();
                    format!("{{{}}}", items.join(","))
                }
                _ => self.pick(&["true", "false", "null"]).to_string(),
            }
        }
        fn insets(&mut self) -> String {
            let mut keys = vec![];
            for k in ["left", "top", "right", "bottom", "left", "x"] {
                if self.chance(0.97) {
                    let v = if self.chance(0.95) {
                        self.pick(&["260", "8", "0", "-1.5", "10.25"]).to_string()
                    } else {
                        self.value(2)
                    };
                    keys.push(format!("\"{k}\":{v}"));
                }
            }
            format!("{{{}}}", keys.join(","))
        }
        fn pane(&mut self) -> String {
            let mut keys = vec![];
            if self.chance(0.9) {
                let id = if self.chance(0.8) {
                    format!("\"{}\"", self.pick(&["t1", "t2", "t3", "t1", "x.y"]))
                } else {
                    self.value(2)
                };
                keys.push(format!("\"id\":{id}"));
            }
            if self.chance(0.9) {
                let r = if self.chance(0.8) {
                    let n = if self.chance(0.9) { 4 } else { self.next() % 6 };
                    let parts: Vec<String> = (0..n)
                        .map(|_| {
                            if self.chance(0.9) {
                                self.pick(&["0", "8", "620", "933", "-2", "0.5"]).to_string()
                            } else {
                                self.value(2)
                            }
                        })
                        .collect();
                    format!("[{}]", parts.join(","))
                } else {
                    self.value(2)
                };
                keys.push(format!("\"rect\":{r}"));
            }
            if self.chance(0.2) {
                keys.push(format!("\"extra\":{}", self.value(1)));
            }
            if self.chance(0.3) {
                let f = self.pick(&["true", "false", "1", "0", "2", "\"true\"", "null"]).to_string();
                keys.push(format!("\"folded\":{f}"));
            }
            if self.chance(0.1) {
                keys.push("\"id\":\"t4\"".into());
            }
            format!("{{{}}}", keys.join(","))
        }
        /// A clean report with a split (its panes 2 to 4, or now and then up to MAX_PANES + 1, now and then one of them
        /// broken or two alike).
        fn split_report(&mut self) -> String {
            let n = if self.chance(0.1) { 2 + self.next() % (MAX_PANES as u64) } else { 2 + self.next() % 3 };
            let panes: Vec<String> = (0..n)
                .map(|i| {
                    if self.chance(0.05) {
                        return self.pane();
                    }
                    let id = if self.chance(0.03) { "t1".to_string() } else { format!("t{i}") };
                    let x = self.pick(&["0", "626", "1252.5", "-3"]);
                    format!("{{\"id\":\"{id}\",\"rect\":[{x},8,618.25,933]}}")
                })
                .collect();
            let split = if self.chance(0.95) { "\"sp-1\"".to_string() } else { self.text() };
            format!(
                "{{\"insets\":{{\"left\":260,\"top\":8,\"right\":8,\"bottom\":8}},\"radius\":6,\"container\":{{\"width\":1512,\"height\":949}},\"mode\":\"fullscreen\",\"pageHosted\":true,\"fills\":[\"#fff\",\"#fff\",\"rgb(1, 2, 3)\",\"\"],\"split\":{split},\"panes\":[{}]}}",
                panes.join(",")
            )
        }
        fn report(&mut self) -> String {
            if self.chance(0.2) {
                return self.split_report();
            }
            let mut keys = vec![];
            let mut add = |g: &mut Gen, k: &str| {
                let v = match k {
                    "insets" if g.chance(0.97) => g.insets(),
                    "container" if g.chance(0.97) => {
                        format!(
                            "{{\"width\":{},\"height\":{}}}",
                            g.pick(&["1512", "1512", "800.5", "1", "0", "-5"]),
                            g.pick(&["949", "949", "1", "600", "0"])
                        )
                    }
                    "radii" if g.chance(0.8) => {
                        let n = g.next() % 7;
                        let parts: Vec<String> =
                            (0..n)
                                .map(|_| {
                                    if g.chance(0.8) {
                                        g.pick(&["6", "0", "-2", "10.5"]).to_string()
                                    } else {
                                        g.value(2)
                                    }
                                })
                                .collect();
                        format!("[{}]", parts.join(","))
                    }
                    "fills" if g.chance(0.8) => {
                        let n = g.next() % 7;
                        let parts: Vec<String> =
                            (0..n).map(|_| if g.chance(0.8) { g.text() } else { g.value(2) }).collect();
                        format!("[{}]", parts.join(","))
                    }
                    "panes" if g.chance(0.85) => {
                        let n = g.next() % 6;
                        let parts: Vec<String> =
                            (0..n).map(|_| if g.chance(0.9) { g.pane() } else { g.value(2) }).collect();
                        format!("[{}]", parts.join(","))
                    }
                    "split" | "mode" if g.chance(0.8) => g.text(),
                    "pageOutside" | "pageHosted" if g.chance(0.7) => {
                        g.pick(&["true", "false", "1", "0", "1.0", "2", "\"1\""]).to_string()
                    }
                    _ => g.value(1),
                };
                keys.push(format!("\"{k}\":{v}"));
            };
            for k in [
                "insets",
                "container",
                "radius",
                "radii",
                "mode",
                "pageOutside",
                "pageHosted",
                "fills",
                "split",
                "panes",
                "other",
            ] {
                if self.chance(if k == "insets" || k == "container" { 0.97 } else { 0.8 }) {
                    add(self, k);
                }
                if self.chance(0.06) {
                    add(self, k);
                }
            }
            let mut s = format!("{{{}}}", keys.join(","));
            match self.next() % 40 {
                0 => s.push('x'),
                1 => s.push_str("  \n"),
                2 => s = s.replacen('{', "[", 1),
                3 => s = String::from_utf8_lossy(&s.as_bytes()[..s.len() / 2]).into_owned(),
                4 => s = format!("[{s}]"),
                5 => s = "nul".into(),
                _ => {}
            }
            s
        }
    }

    #[test]
    fn a_split_of_the_most_panes_is_read_and_one_more_is_none() {
        // (A split tree, docs/FLEX-SPLIT.md step 3: up to MAX_PANES panes, every one kept in order, reading a page's
        // report again into the same layout as the page does.)
        let report = |n: usize| {
            let panes: Vec<String> =
                (0..n).map(|i| format!("{{\"id\":\"p{i}\",\"rect\":[{},8,60,900]}}", i * 70)).collect();
            format!(
                "{{\"insets\":{{\"left\":260,\"top\":8,\"right\":8,\"bottom\":8}},\"radius\":6,\"container\":{{\"width\":1512,\"height\":949}},\"split\":\"sp-1\",\"panes\":[{}]}}",
                panes.join(",")
            )
        };
        let mut into = PageLayout::default();
        for n in [2, 4, 5, MAX_PANES, MAX_PANES + 1, 3] {
            let r = report(n);
            let want = by_value(r.as_bytes());
            let got = by_seed(r.as_bytes(), &mut into).expect("a layout");
            assert_eq!(format!("{want:?}"), format!("{:?}", Some(&got)), "{n} panes: as from_geometry reads them");
            if n <= MAX_PANES {
                assert_eq!(got.split.as_deref(), Some("sp-1"), "{n} panes: a split");
                assert_eq!(
                    got.panes.iter().map(|p| p.item.clone()).collect::<Vec<_>>(),
                    (0..n).map(|i| format!("p{i}")).collect::<Vec<_>>()
                );
                assert_eq!(got.panes[n - 1].rect, Rect::new((n - 1) as f64 * 70.0, 8.0, 60.0, 900.0));
            } else {
                assert!(got.split.is_none() && got.panes.is_empty(), "{n} panes: no split");
            }
        }
    }

    #[test]
    fn the_same_as_from_geometry_on_generated_reports() {
        let mut g = Gen(7);
        let mut into = PageLayout::default();
        let (mut taken, mut runs, mut splits) = (0, 0, 0);
        for _ in 0..200_000 {
            let r = g.report();
            let want = by_value(r.as_bytes());
            let got = by_seed(r.as_bytes(), &mut into);
            // (Bitwise for the numbers: -0 and NaN alike.)
            assert_eq!(format!("{want:?}"), format!("{got:?}"), "{r}");
            taken += usize::from(want.is_some());
            splits += usize::from(want.as_ref().is_some_and(|l| l.split.is_some()));
            runs += 1;
        }
        assert!(
            taken > runs / 5 && splits > runs / 200,
            "{taken} of {runs} taken, {splits} splits: the generator makes too few"
        );
        // (A report with an invalid UTF-8 byte, a lone surrogate, a number out of range anywhere: refused alike.)
        for bad in [
            &b"{\"insets\":{\"left\":1,\"top\":1,\"right\":1,\"bottom\":1},\"container\":{\"width\":1,\"height\":1},\"x\":\"\xff\"}"[..],
            b"{\"insets\":{\"left\":1,\"top\":1,\"right\":1,\"bottom\":1},\"container\":{\"width\":1,\"height\":1},\"x\":\"\\ud800\"}",
            b"{\"insets\":{\"left\":1,\"top\":1,\"right\":1,\"bottom\":1},\"container\":{\"width\":1,\"height\":1},\"x\":[1e999]}",
            b"{\"insets\":{\"left\":1,\"top\":1,\"right\":1,\"bottom\":1},\"container\":{\"width\":1,\"height\":1}}\xff",
        ] {
            assert_eq!(by_value(bad), None);
            assert_eq!(by_seed(bad, &mut into), None, "{}", String::from_utf8_lossy(bad));
        }
        // (Nested past serde_json's limit, in a key it drops: refused alike.)
        let deep = format!(
            "{{\"insets\":{{\"left\":1,\"top\":1,\"right\":1,\"bottom\":1}},\"container\":{{\"width\":1,\"height\":1}},\"x\":{}1{}}}",
            "[".repeat(200),
            "]".repeat(200)
        );
        assert_eq!(by_value(deep.as_bytes()), None);
        assert_eq!(by_seed(deep.as_bytes(), &mut into), None);
    }
}

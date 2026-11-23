//! Margin's keys (margin-core's `shortcuts`: the commands, their combinations, which are held, the quit guard and the
//! hosted app's keys, a held key's repeat) for the Mac app's Swift (Shortcuts.swift keeps only Carbon's hot keys and
//! a timer). The rare calls (the copy's keys, what's held, a guard held or let go) answer JSON; a press, a release and
//! a repeat's tick are typed calls, nothing allocated. Combinations cross as the Mac's own: Carbon's virtual key code
//! (`kVK_*`) and modifier bits. Nothing here panics on what it's given: a bad request is an empty answer.

use margin_core::shortcuts::{
    self, AppCommand, AppKey, AppShortcuts, Bindings, Combo, Front, Hit, HotKeyRegistrar, KeyRepeat, Modifiers, Os,
    QUIT_KEYS,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;

/// A combination as the Mac has it (`ok` false: not one Margin's keys can be).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MarginKeyCombo {
    pub ok: bool,
    pub key_code: u16,
    pub modifiers: u32,
}

/// What a press or a repeat's tick does: `kind` 0 nothing, 1 one of Margin's keys (`index` into the constants'
/// `commands`, `repeat` true for a held key's repeat), 2 the quit guard (`index` 1: ⌥⌘Q, keep the windows), 3 a
/// hosted app's key (`index` into the constants' `appKeys`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MarginKeyHit {
    pub kind: u8,
    pub index: u8,
    pub repeat: bool,
}

/// Carbon's register and unregister, the Swift side's (`ctx` its own object): register answers false when another
/// app holds the combination.
pub type MarginKeyRegister = extern "C" fn(ctx: *mut c_void, id: u32, key_code: u16, modifiers: u32) -> bool;
pub type MarginKeyUnregister = extern "C" fn(ctx: *mut c_void, id: u32);

/// The holder: margin-core's `AppShortcuts` and the Swift side's registrar.
pub struct MarginKeys {
    shortcuts: AppShortcuts,
    registrar: Registrar,
}

struct Registrar {
    ctx: *mut c_void,
    register: MarginKeyRegister,
    unregister: MarginKeyUnregister,
}

impl HotKeyRegistrar for Registrar {
    fn register(&mut self, combo: &Combo, id: u32) -> bool {
        (self.register)(self.ctx, id, combo.mac_key_code(), combo.modifiers().carbon())
    }
    fn unregister(&mut self, id: u32) {
        (self.unregister)(self.ctx, id)
    }
}

fn answer(value: &Value, out_len: *mut usize) -> *mut u8 {
    if out_len.is_null() {
        return std::ptr::null_mut();
    }
    let boxed = value.to_string().into_bytes().into_boxed_slice();
    // SAFETY: out_len is writable (checked non-null; the caller's contract).
    unsafe { *out_len = boxed.len() };
    Box::into_raw(boxed) as *mut u8
}

/// The bytes of a caller's buffer as text (`None`: null or not UTF-8).
fn text<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    // SAFETY: the caller passes `len` readable bytes at `ptr`.
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr, len) }).ok()
}

fn combo_json(combo: &Combo) -> Value {
    json!([combo.mac_key_code(), combo.modifiers().carbon()])
}

fn bindings_json(bindings: &Bindings) -> Value {
    Value::Array(bindings.iter().map(|(c, a)| json!([c.mac_key_code(), c.modifiers().carbon(), a.name()])).collect())
}

fn taken_json(taken: &[(Combo, AppCommand)]) -> Value {
    json!({ "taken": taken.iter().map(|(c, a)| json!([c.mac_key_code(), c.modifiers().carbon(), a.name()])).collect::<Vec<_>>() })
}

/// `[[keyCode, modifiers, command], …]` → bindings (entries that aren't one left out).
fn parse_bindings(text: &str) -> Bindings {
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(text) else { return Bindings::new() };
    list.iter()
        .filter_map(|e| {
            let key = u16::try_from(e.get(0)?.as_u64()?).ok()?;
            let mods = u32::try_from(e.get(1)?.as_u64()?).ok()?;
            let command = AppCommand::parse(e.get(2)?.as_str()?)?;
            Some((Combo::from_mac(key, mods)?, command))
        })
        .collect()
}

fn hit(h: Option<Hit>) -> MarginKeyHit {
    let index = |i: Option<usize>| u8::try_from(i.unwrap_or(0)).unwrap_or(0);
    match h {
        None => MarginKeyHit::default(),
        Some(Hit::Command(run)) => MarginKeyHit {
            kind: 1,
            index: index(AppCommand::ALL.iter().position(|c| *c == run.command)),
            repeat: run.is_repeat,
        },
        Some(Hit::Quit { keep_windows }) => MarginKeyHit { kind: 2, index: u8::from(keep_windows), repeat: false },
        Some(Hit::AppKey(key)) => {
            MarginKeyHit { kind: 3, index: index(AppKey::ALL.iter().position(|k| *k == key)), repeat: false }
        }
    }
}

/// "Ctrl+Meta+ArrowDown" → the Mac's key code and modifiers.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_parse(ptr: *const u8, len: usize) -> MarginKeyCombo {
    match text(ptr, len).and_then(Combo::parse) {
        Some(c) => MarginKeyCombo { ok: true, key_code: c.mac_key_code(), modifiers: c.modifiers().carbon() },
        None => MarginKeyCombo::default(),
    }
}

/// For the log: "⌃⌘ArrowRight" (a key code not known: its modifiers then `#<code>`).
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_describe(key_code: u16, modifiers: u32, out_len: *mut usize) -> *mut u8 {
    let text = match Combo::from_mac(key_code, modifiers) {
        Some(c) => c.to_string(),
        None => {
            let m = Modifiers::from_carbon(modifiers);
            let mut out = String::new();
            for (bit, s) in
                [(Modifiers::CTRL, "⌃"), (Modifiers::ALT, "⌥"), (Modifiers::SHIFT, "⇧"), (Modifiers::META, "⌘")]
            {
                if m.contains(bit) {
                    out.push_str(s);
                }
            }
            format!("{out}#{key_code}")
        }
    };
    answer(&Value::String(text), out_len)
}

/// The Mac's bindings for the copy's `keys` (`{ command: [combination] }`; anything else, or null: the defaults), as
/// `[[keyCode, modifiers, command], …]`.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_bindings(ptr: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
    let keys: HashMap<String, Vec<String>> =
        text(ptr, len).and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
    answer(&bindings_json(&shortcuts::bindings_from(&keys, Os::MacOs, false)), out_len)
}

/// Of `bindings` (as [`margin_keys_bindings`] answers), the ones held now (`spaces`, `items`: the window's counts, or
/// -1 not said yet).
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_held(
    ptr: *const u8,
    len: usize,
    margin_in_front: bool,
    browser: bool,
    spaces: i32,
    items: i32,
    out_len: *mut usize,
) -> *mut u8 {
    let b = parse_bindings(text(ptr, len).unwrap_or("[]"));
    let count = |n: i32| u32::try_from(n).ok();
    answer(&bindings_json(&shortcuts::held(&b, margin_in_front, browser, count(spaces), count(items))), out_len)
}

/// The hosted gates at once: bit 1 Margin's keys held ([`shortcuts::hosted_active`]), bit 2 the quit guard, bit 4
/// the hosted app's keys. `front_pid` -1: unread.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_gate(
    front_pid: i64,
    own_pid: i64,
    front_hosted: bool,
    window_open: bool,
    on_current_space: bool,
    asks: bool,
    quitting: bool,
) -> u8 {
    let f = Front {
        pid: u32::try_from(front_pid).ok(),
        own: u32::try_from(own_pid).unwrap_or(u32::MAX),
        hosted: front_hosted,
        window_open,
        on_current_space,
    };
    u8::from(shortcuts::hosted_active(f))
        | (u8::from(shortcuts::guards_quit(f, asks, quitting)) << 1)
        | (u8::from(shortcuts::guards_app_keys(f, quitting)) << 2)
}

/// A hosted app that is a browser: `linked` the browsers' bundle ids Margin links with, as a JSON array.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_is_browser_app(
    bundle: *const u8,
    len: usize,
    linked: *const u8,
    linked_len: usize,
) -> bool {
    let Some(bundle) = text(bundle, len) else { return false };
    let linked: HashSet<String> =
        text(linked, linked_len).and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
    shortcuts::is_browser_app(bundle, &linked)
}

/// Chrome or Edge, any channel.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_is_chromium(bundle: *const u8, len: usize) -> bool {
    text(bundle, len).is_some_and(shortcuts::is_chromium_bundle)
}

/// The commands (their order: a hit's `index`), the hosted app's keys and the quit guard's, the repeat's least waits,
/// the guards' ids.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_constants(out_len: *mut usize) -> *mut u8 {
    let mac = |c: Combo| json!({ "keyCode": c.mac_key_code(), "modifiers": c.modifiers().carbon(), "text": c.text() });
    let value = json!({
        "commands": AppCommand::ALL.iter().map(|c| c.name()).collect::<Vec<_>>(),
        "appKeys": AppKey::ALL.iter().map(|k| { let mut v = mac(k.combo()); v["name"] = json!(k.name()); v }).collect::<Vec<_>>(),
        "quit": QUIT_KEYS.iter().filter_map(|(t, keep)| Combo::parse(t).map(|c| { let mut v = mac(c); v["keepWindows"] = json!(keep); v })).collect::<Vec<_>>(),
        "minDelay": AppShortcuts::MIN_DELAY,
        "minInterval": AppShortcuts::MIN_INTERVAL,
        "quitIdBase": AppShortcuts::QUIT_ID_BASE,
        "appKeyIdBase": AppShortcuts::APP_KEY_ID_BASE,
    });
    answer(&value, out_len)
}

/// A holder with the Mac's defaults, not held yet. `ctx`, `register`, `unregister`: the Swift side's registrar,
/// called only from inside these calls, on the caller's thread.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_new(
    ctx: *mut c_void,
    register: MarginKeyRegister,
    unregister: MarginKeyUnregister,
) -> *mut MarginKeys {
    let shortcuts = AppShortcuts::new(shortcuts::default_bindings(Os::MacOs), KeyRepeat::default());
    Box::into_raw(Box::new(MarginKeys { shortcuts, registrar: Registrar { ctx, register, unregister } }))
}

/// # Safety
/// `keys` from [`margin_keys_new`], not freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_keys_free(keys: *mut MarginKeys) {
    if !keys.is_null() {
        // SAFETY: made by Box::into_raw in margin_keys_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(keys) });
    }
}

/// A holder from the caller's pointer.
fn holder<'a>(keys: *mut MarginKeys) -> Option<&'a mut MarginKeys> {
    // SAFETY: from margin_keys_new and not freed (each call's contract); one call at a time (the caller's thread).
    (!keys.is_null()).then(|| unsafe { &mut *keys })
}

/// New bindings (as [`margin_keys_bindings`] answers), held at once if the keys are held now: `{ taken: [...] }`.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_rebind(
    keys: *mut MarginKeys,
    ptr: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    let Some(k) = holder(keys) else { return answer(&json!({ "taken": [] }), out_len) };
    let next = parse_bindings(text(ptr, len).unwrap_or("[]"));
    let taken = k.shortcuts.rebind(&mut k.registrar, next);
    answer(&taken_json(&taken), out_len)
}

/// Margin's keys held or let go: `{ taken: [...] }` (the combinations another app holds, just found so).
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_set_active(keys: *mut MarginKeys, active: bool, out_len: *mut usize) -> *mut u8 {
    let Some(k) = holder(keys) else { return answer(&json!({ "taken": [] }), out_len) };
    let taken = k.shortcuts.set_active(&mut k.registrar, active);
    answer(&taken_json(&taken), out_len)
}

/// The quit guard held or let go: `{ taken: [[keyCode, modifiers], …] }`.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_set_quit_guard(keys: *mut MarginKeys, active: bool, out_len: *mut usize) -> *mut u8 {
    let Some(k) = holder(keys) else { return answer(&json!({ "taken": [] }), out_len) };
    let taken = k.shortcuts.set_quit_guard(&mut k.registrar, active);
    answer(&json!({ "taken": taken.iter().map(combo_json).collect::<Vec<_>>() }), out_len)
}

/// The hosted app's keys held or let go: `{ taken: [[keyCode, modifiers], …] }`.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_set_app_key_guard(keys: *mut MarginKeys, active: bool, out_len: *mut usize) -> *mut u8 {
    let Some(k) = holder(keys) else { return answer(&json!({ "taken": [] }), out_len) };
    let taken = k.shortcuts.set_app_key_guard(&mut k.registrar, active);
    answer(&json!({ "taken": taken.iter().map(combo_json).collect::<Vec<_>>() }), out_len)
}

/// A hot key pressed (`now` seconds; `delay`, `interval`: the Mac's key repeat now, for a key that repeats).
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_press(
    keys: *mut MarginKeys,
    id: u32,
    now: f64,
    delay: f64,
    interval: f64,
) -> MarginKeyHit {
    let Some(k) = holder(keys) else { return MarginKeyHit::default() };
    k.shortcuts.set_key_repeat(KeyRepeat { delay, interval });
    hit(k.shortcuts.press(id, now))
}

/// A hot key let go: its repeat stops.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_release(keys: *mut MarginKeys, id: u32) {
    if let Some(k) = holder(keys) {
        k.shortcuts.release(id);
    }
}

/// When the repeat's tick is next due (seconds), or -1: no key repeating.
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_next_tick(keys: *mut MarginKeys) -> f64 {
    holder(keys).and_then(|k| k.shortcuts.next_tick()).unwrap_or(-1.0)
}

/// The repeat's clock: a repeat if one is due and the repeating combination's modifiers are all among
/// `modifiers_down` (Carbon's bits, as they are now).
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_tick(keys: *mut MarginKeys, now: f64, modifiers_down: u32) -> MarginKeyHit {
    let Some(k) = holder(keys) else { return MarginKeyHit::default() };
    let down = Modifiers::from_carbon(modifiers_down);
    hit(k.shortcuts.tick(now, |m| down.contains(m)).map(Hit::Command))
}

/// What the holder has now: `{ active, quit, appKeys, bindings: [[keyCode, modifiers, command], …], unavailable:
/// [[keyCode, modifiers], …] }` (bindings in their ids' order).
#[unsafe(no_mangle)]
pub extern "C" fn margin_keys_state(keys: *mut MarginKeys, out_len: *mut usize) -> *mut u8 {
    let Some(k) = holder(keys) else { return answer(&json!({}), out_len) };
    let s = &k.shortcuts;
    let value = json!({
        "active": s.is_active(),
        "quit": s.guards_quit(),
        "appKeys": s.guards_app_keys(),
        "bindings": s.bindings().iter().map(|(c, a)| json!([c.mac_key_code(), c.modifiers().carbon(), a.name()])).collect::<Vec<_>>(),
        "unavailable": s.unavailable().iter().map(combo_json).collect::<Vec<_>>(),
    });
    answer(&value, out_len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn take(ptr: *mut u8, len: usize) -> Value {
        // SAFETY: a buffer these calls made, `len` bytes.
        let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) }).unwrap_or(Value::Null);
        // SAFETY: as margin_buffer_free's contract.
        unsafe { crate::margin_buffer_free(ptr, len) };
        v
    }

    static HELD: Mutex<Vec<(u32, u16, u32)>> = Mutex::new(Vec::new());
    extern "C" fn reg(_: *mut c_void, id: u32, key: u16, mods: u32) -> bool {
        let mut h = HELD.lock().unwrap_or_else(|e| e.into_inner());
        h.retain(|e| e.0 != id);
        h.push((id, key, mods));
        true
    }
    extern "C" fn unreg(_: *mut c_void, id: u32) {
        HELD.lock().unwrap_or_else(|e| e.into_inner()).retain(|e| e.0 != id);
    }

    #[test]
    fn the_keys_through_the_ffi() {
        let t = "Ctrl+Meta+ArrowDown";
        assert_eq!(
            margin_keys_parse(t.as_ptr(), t.len()),
            MarginKeyCombo { ok: true, key_code: 125, modifiers: 0x1100 }
        );
        let bad = "Shift+KeyT";
        assert!(!margin_keys_parse(bad.as_ptr(), bad.len()).ok);
        let mut len = 0;
        assert_eq!(take(margin_keys_describe(124, 0x1100, &mut len), len), json!("⌃⌘ArrowRight"));
        assert_eq!(take(margin_keys_describe(200, 0x100, &mut len), len), json!("⌘#200"));
        let defaults = take(margin_keys_bindings(std::ptr::null(), 0, &mut len), len);
        assert_eq!(defaults.as_array().map(Vec::len), Some(31));
        let d = defaults.to_string();
        let held = take(margin_keys_held(d.as_ptr(), d.len(), false, false, 3, 5, &mut len), len);
        let names: Vec<&str> = held.as_array().into_iter().flatten().filter_map(|e| e[2].as_str()).collect();
        assert!(!names.contains(&"toggle-pin") && names.contains(&"space-3") && !names.contains(&"space-4"));
        assert_eq!(margin_keys_gate(20, 1, true, true, true, true, false), 0b111);
        assert_eq!(margin_keys_gate(1, 1, false, true, true, false, false), 0b001, "Margin in front, asking off");
        assert_eq!(margin_keys_gate(-1, 1, false, true, true, true, false), 0);
        let (chrome, linked) = ("com.google.Chrome.canary", r#"["com.apple.Safari"]"#);
        assert!(margin_keys_is_browser_app(chrome.as_ptr(), chrome.len(), linked.as_ptr(), linked.len()));
        let notes = "com.apple.Notes";
        assert!(!margin_keys_is_browser_app(notes.as_ptr(), notes.len(), linked.as_ptr(), linked.len()));
        let c = take(margin_keys_constants(&mut len), len);
        assert_eq!(c["commands"].as_array().map(Vec::len), Some(31));
        assert_eq!(c["appKeys"][0]["name"], json!("⌘W"));
        assert_eq!(c["quit"][1]["keepWindows"], json!(true));

        let keys = margin_keys_new(std::ptr::null_mut(), reg, unreg);
        let taken = take(margin_keys_set_active(keys, true, &mut len), len);
        assert_eq!(taken["taken"], json!([]));
        assert_eq!(HELD.lock().map(|h| h.len()).unwrap_or(0), 31);
        let state = take(margin_keys_state(keys, &mut len), len);
        let palette =
            state["bindings"].as_array().and_then(|b| b.iter().position(|e| e[2] == json!("palette"))).unwrap_or(99);
        let down =
            state["bindings"].as_array().and_then(|b| b.iter().position(|e| e[2] == json!("next-tab"))).unwrap_or(99);
        let id = |i: usize| u32::try_from(i).unwrap_or(0);
        let p = margin_keys_press(keys, id(palette), 0.0, 0.4, 0.05);
        assert_eq!((p.kind, c["commands"][p.index as usize].as_str()), (1, Some("palette")));
        assert_eq!(margin_keys_next_tick(keys), -1.0, "the palette doesn't repeat");
        let n = margin_keys_press(keys, id(down), 10.0, 0.4, 0.05);
        assert!(n.kind == 1 && !n.repeat);
        assert_eq!(margin_keys_next_tick(keys), 10.4);
        let r = margin_keys_tick(keys, 10.4, 0x1900);
        assert!(r.kind == 1 && r.repeat, "its modifiers down: a repeat");
        assert_eq!(margin_keys_tick(keys, 10.42, 0x1900).kind, 0, "not due yet: nothing");
        assert_eq!(margin_keys_tick(keys, 10.5, 0).kind, 0, "the modifiers up: it stops");
        assert_eq!(margin_keys_next_tick(keys), -1.0);
        let q = take(margin_keys_set_quit_guard(keys, true, &mut len), len);
        assert_eq!(q["taken"], json!([]));
        let quit = margin_keys_press(keys, 901, 0.0, 0.4, 0.05);
        assert_eq!((quit.kind, quit.index), (2, 1), "⌥⌘Q: keep the windows");
        let _ = take(margin_keys_set_app_key_guard(keys, true, &mut len), len);
        let w = margin_keys_press(keys, 920, 0.0, 0.4, 0.05);
        assert_eq!((w.kind, w.index), (3, 0), "⌘W");
        let _ = take(margin_keys_set_active(keys, false, &mut len), len);
        let _ = take(margin_keys_set_quit_guard(keys, false, &mut len), len);
        let _ = take(margin_keys_set_app_key_guard(keys, false, &mut len), len);
        assert_eq!(HELD.lock().map(|h| h.len()).unwrap_or(99), 0, "everything let go");
        // SAFETY: from margin_keys_new, freed once.
        unsafe { margin_keys_free(keys) };
    }
}

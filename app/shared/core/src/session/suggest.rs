//! The palette's search (DECISIONS.md "The palette's search: the engine from macOS, its suggestions"): which engine a
//! search goes to and the search suggestions the palette shows as the person types.
//!
//! The engine is the one Safari searches with, as macOS keeps it: Safari writes the engine chosen in its Settings
//! (never the private windows' one) to the system's web search record (`NSPreferredWebServices`'
//! `NSWebServicesProviderWebSearch`: `NSProviderIdentifier`, `NSDefaultDisplayName`), again each time it starts, and
//! macOS posts a notice when it changes; the shell reads it then and says it here (`engine_of_record`). An engine
//! that isn't one of Safari's five (or none said): no suggestions, never another engine's, and the search goes to
//! the address the copy learned before, else Google's (ui.rs `search_url`).
//!
//! Suggestions: the engine's own (each answers the OpenSearch suggestions format, `["typed", ["s1", "s2", …]]`),
//! asked only for what's typed (never an address), only while the person's setting has them on
//! (`searchSuggestions`, on unless set false). One request in flight a window: what's typed meanwhile is asked
//! when it answers (the newest only), so nothing waits on a timer; answers kept for the last queries (`KEEP`), so
//! typing back over them shows them at once. The shell sends the request (no cookies, its own client name) and
//! gives the answer back; it's read here as untrusted bytes.

use std::collections::{BTreeMap, VecDeque};

use serde_json::Value;

use super::ui::{encode, trimmed};

/// One of Safari's engines: its id (shared/search.ts SAFARI_ENGINES's), its name, the words its record has
/// (`record`: the provider identifier's labels, e.g. `com.google.www`), its search address and its suggestions'
/// (`%s` the encoded query).
#[derive(Debug, PartialEq, Eq)]
pub struct Engine {
    pub id: &'static str,
    pub name: &'static str,
    pub record: &'static str,
    pub search: &'static str,
    pub suggest: &'static str,
}

/// Safari's engines (its Settings' Search list), their search addresses as Safari makes them on macOS (shared/search.ts
/// SAFARI_ENGINES, the same: tests/fixtures/search-engines.json), their suggestions as each engine serves them to
/// browsers.
pub const ENGINES: [Engine; 5] = [
    Engine {
        id: "google",
        name: "Google",
        record: "google",
        search: "https://www.google.com/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8",
        suggest: "https://www.google.com/complete/search?client=firefox&q=%s",
    },
    Engine {
        id: "bing",
        name: "Bing",
        record: "bing",
        search: "https://www.bing.com/search?q=%s&form=APMCS1&PC=APMC",
        suggest: "https://api.bing.com/osjson.aspx?query=%s",
    },
    Engine {
        id: "duckduckgo",
        name: "DuckDuckGo",
        record: "duckduckgo",
        search: "https://duckduckgo.com/?q=%s&t=osx&ia=web",
        suggest: "https://duckduckgo.com/ac/?q=%s&type=list",
    },
    Engine {
        id: "ecosia",
        name: "Ecosia",
        record: "ecosia",
        search: "https://www.ecosia.org/search?q=%s&tts=st_asaf_macos",
        suggest: "https://ac.ecosia.org/autocomplete?q=%s&type=list",
    },
    Engine {
        id: "yahoo",
        name: "Yahoo",
        record: "yahoo",
        search: "https://search.yahoo.com/search?ei=utf-8&fr=aaplw&p=%s",
        suggest: "https://search.yahoo.com/sugg/ff?output=fxjson&command=%s",
    },
];

/// The engine of macOS's web search record: by its provider identifier (reverse-DNS, `com.google.www`: one of its
/// labels the engine's word), else by its name (as Safari's list names it, any case); neither one of Safari's: None.
pub fn engine_of_record(identifier: Option<&str>, name: Option<&str>) -> Option<&'static Engine> {
    if let Some(id) = identifier.filter(|i| !i.is_empty() && i.len() <= 200) {
        let labels: Vec<String> = id.split('.').map(str::to_ascii_lowercase).collect();
        if let Some(e) = ENGINES.iter().find(|e| labels.iter().any(|l| l == e.record)) {
            return Some(e);
        }
    }
    let name = trimmed(name.unwrap_or(""));
    ENGINES.iter().find(|e| !name.is_empty() && e.name.eq_ignore_ascii_case(name))
}

/// The most characters a query asked for has (a longer one isn't a search being typed).
pub const MOST_TYPED: usize = 100;
/// The most suggestions read from an answer.
pub const MOST: usize = 8;
/// The most characters a suggestion has (a longer one isn't one).
pub const LONGEST: usize = 200;
/// The answers kept (engine, query): typing back over them shows them at once.
pub const KEEP: usize = 24;
/// The largest answer read (bytes): every engine's is a few hundred.
pub const LARGEST: usize = 64 * 1024;

/// What's typed, as asked for: trimmed, 1 to MOST_TYPED characters, never an address (a scheme's `://`, or one word
/// with a dot and no space: shared/search.ts resolveInput's addresses), nor a line break. None: not asked.
pub fn wanted(typed: &str) -> Option<String> {
    let q = trimmed(typed);
    let n = q.chars().count();
    if n == 0 || n > MOST_TYPED || q.contains("://") || q.chars().any(char::is_control) {
        return None;
    }
    let lower = q.to_lowercase();
    if lower.starts_with("about:") || lower.starts_with("data:") || lower.starts_with("mailto:") {
        return None;
    }
    if !q.contains(char::is_whitespace) && (q.contains('.') || lower.starts_with("localhost")) {
        return None;
    }
    Some(q.to_string())
}

/// The suggestions in an engine's answer (`["typed", ["s1", …], …]`): its strings, each trimmed, none empty, too
/// long or with a control character, none the query itself (any case), no two the same (any case), at most MOST.
/// Not that shape (or larger than LARGEST): None.
pub fn parse(query: &str, body: &[u8]) -> Option<Vec<String>> {
    if body.len() > LARGEST {
        return None;
    }
    let v: Value = serde_json::from_slice(body).ok()?;
    let list = v.as_array()?.get(1)?.as_array()?;
    let typed = query.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for s in list.iter().filter_map(Value::as_str) {
        let s = trimmed(s);
        if s.is_empty() || s.chars().count() > LONGEST || s.chars().any(char::is_control) {
            continue;
        }
        let lower = s.to_lowercase();
        if lower == typed || out.iter().any(|o| o.to_lowercase() == lower) {
            continue;
        }
        out.push(s.to_string());
        if out.len() == MOST {
            break;
        }
    }
    Some(out)
}

/// A request for the shell to send: its number (the answer names it), the window it's for, the query, the address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fetch {
    pub seq: u64,
    pub window: i64,
    pub query: String,
    pub url: String,
}

/// What a window's ask comes to: nothing to show (`Clear`: off, no engine, nothing typed or an address), the
/// suggestions known for it (`Known`), a request to send (`Fetch`), or one in flight already (`Held`: this query
/// asked once it answers).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ask {
    Clear,
    Known(String, Vec<String>),
    Fetch(Fetch),
    Held,
}

/// The suggestions' state: the engine, each window's request in flight and the query typed since, the answers kept.
#[derive(Default)]
pub struct Suggest {
    engine: Option<&'static Engine>,
    seq: u64,
    flying: BTreeMap<i64, Fetch>,
    next: BTreeMap<i64, String>,
    kept: VecDeque<(&'static str, String, Vec<String>)>,
}

impl Suggest {
    /// The engine macOS's record names (None: none, or not Safari's); a change forgets what was asked of the last.
    pub fn set_engine(&mut self, engine: Option<&'static Engine>) -> bool {
        if self.engine == engine {
            return false;
        }
        self.engine = engine;
        self.flying.clear();
        self.next.clear();
        self.kept.clear();
        true
    }

    pub fn engine(&self) -> Option<&'static Engine> {
        self.engine
    }

    fn known(&self, engine: &Engine, query: &str) -> Option<Vec<String>> {
        let q = query.to_lowercase();
        self.kept.iter().find(|(e, k, _)| *e == engine.id && *k == q).map(|(_, _, s)| s.clone())
    }

    /// A window's ask for what's typed now (`on`: the person's setting).
    pub fn ask(&mut self, window: i64, typed: &str, on: bool) -> Ask {
        let (Some(engine), Some(query), true) = (self.engine, wanted(typed), on) else {
            self.next.remove(&window);
            return Ask::Clear;
        };
        if let Some(known) = self.known(engine, &query) {
            self.next.remove(&window);
            return Ask::Known(query, known);
        }
        if self.flying.contains_key(&window) {
            self.next.insert(window, query);
            return Ask::Held;
        }
        Ask::Fetch(self.send(engine, window, query))
    }

    fn send(&mut self, engine: &'static Engine, window: i64, query: String) -> Fetch {
        self.seq += 1;
        let fetch = Fetch { seq: self.seq, window, url: engine.suggest.replace("%s", &encode(&query)), query };
        self.flying.insert(window, fetch.clone());
        fetch
    }

    /// A request's answer (`status` 200 with `body`; anything else: none): the suggestions for its query, to show
    /// (None: not this window's request in flight, or it failed), and the next request (what was typed meanwhile).
    pub fn answered(
        &mut self,
        window: i64,
        seq: u64,
        status: i64,
        body: &[u8],
    ) -> (Option<(String, Vec<String>)>, Option<Fetch>) {
        let Some(engine) = self.engine else { return (None, None) };
        if self.flying.get(&window).map(|f| f.seq) != Some(seq) {
            return (None, None);
        }
        let Some(asked) = self.flying.remove(&window) else { return (None, None) };
        let found = if status == 200 { parse(&asked.query, body) } else { None };
        if let Some(list) = &found {
            let q = asked.query.to_lowercase();
            self.kept.retain(|(e, k, _)| !(*e == engine.id && *k == q));
            self.kept.push_back((engine.id, q, list.clone()));
            while self.kept.len() > KEEP {
                self.kept.pop_front();
            }
        }
        let shown = found.map(|list| (asked.query.clone(), list));
        let next = match self.next.remove(&window) {
            Some(q) if q != asked.query => match self.known(engine, &q) {
                // (Known by now: shown, nothing to ask.)
                Some(list) => return (Some((q, list)), None),
                None => Some(self.send(engine, window, q)),
            },
            _ => None,
        };
        (shown, next)
    }

    /// A window gone: its requests forgotten.
    pub fn forget(&mut self, window: i64) {
        self.flying.remove(&window);
        self.next.remove(&window);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn google() -> &'static Engine {
        &ENGINES[0]
    }

    #[test]
    fn the_same_search_addresses_as_the_extensions() {
        let path =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/search-engines.json");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let listed: Vec<(String, String)> = v["engines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (e["id"].as_str().unwrap().into(), e["search"].as_str().unwrap().into()))
            .collect();
        let ours: Vec<(String, String)> = ENGINES.iter().map(|e| (e.id.into(), e.search.into())).collect();
        assert_eq!(ours, listed);
        assert_eq!(ENGINES[0].search, super::super::ui::GOOGLE);
    }

    #[test]
    fn the_engine_of_the_record() {
        assert_eq!(engine_of_record(Some("com.google.www"), Some("Google")).map(|e| e.id), Some("google"));
        assert_eq!(engine_of_record(Some("com.bing.www"), None).map(|e| e.id), Some("bing"));
        assert_eq!(engine_of_record(Some("com.yahoo.www"), None).map(|e| e.id), Some("yahoo"));
        assert_eq!(engine_of_record(Some("com.duckduckgo"), None).map(|e| e.id), Some("duckduckgo"));
        assert_eq!(engine_of_record(Some("org.ecosia.www"), None).map(|e| e.id), Some("ecosia"));
        // (An identifier not known: by the name.)
        assert_eq!(engine_of_record(Some("x.unknown"), Some(" duckduckgo ")).map(|e| e.id), Some("duckduckgo"));
        assert_eq!(engine_of_record(None, Some("Ecosia")).map(|e| e.id), Some("ecosia"));
        // (Not Safari's, or a word only inside a label: none, never Google.)
        assert_eq!(engine_of_record(Some("com.baidu.www"), Some("Baidu")), None);
        assert_eq!(engine_of_record(Some("com.notgoogle.www"), Some("")), None);
        assert_eq!(engine_of_record(None, None), None);
    }

    #[test]
    fn what_is_asked() {
        assert_eq!(wanted("  weather nyc "), Some("weather nyc".into()));
        assert_eq!(wanted("weather"), Some("weather".into()));
        for no in
            ["", "   ", "github.com", "https://x.y", "a://b", "localhost:3000", "about:blank", "mailto:a@b", "a\nb"]
        {
            assert_eq!(wanted(no), None, "{no:?}");
        }
        // (Words with a dot and a space are a search.)
        assert_eq!(wanted("node.js tutorial"), Some("node.js tutorial".into()));
        assert_eq!(wanted(&"a".repeat(MOST_TYPED)), Some("a".repeat(MOST_TYPED)));
        assert_eq!(wanted(&"a".repeat(MOST_TYPED + 1)), None);
    }

    #[test]
    fn an_answer_read() {
        let body = br#"["weath",["weather","Weather NYC","weather nyc","  ","weath","x\u0007y"],[],{"google:x":1}]"#;
        assert_eq!(parse("weath", body), Some(vec!["weather".to_string(), "Weather NYC".to_string()]));
        assert_eq!(parse("a", br#"["a",["a1","a2","a3","a4","a5","a6","a7","a8","a9"]]"#).unwrap().len(), MOST);
        for bad in [&b"not json"[..], b"{}", b"[\"a\"]", b"[\"a\", {}]", b"null"] {
            assert_eq!(parse("a", bad), None, "{:?}", String::from_utf8_lossy(bad));
        }
        let long = format!(r#"["a",["{}"]]"#, "b".repeat(LONGEST + 1));
        assert_eq!(parse("a", long.as_bytes()), Some(vec![]));
        assert_eq!(parse("a", &vec![b' '; LARGEST + 1]), None);
    }

    #[test]
    fn nothing_without_an_engine_or_when_off() {
        let mut s = Suggest::default();
        assert_eq!(s.ask(1, "weather", true), Ask::Clear);
        s.set_engine(Some(google()));
        assert_eq!(s.ask(1, "weather", false), Ask::Clear);
        assert_eq!(s.ask(1, "github.com", true), Ask::Clear);
    }

    #[test]
    fn one_in_flight_the_newest_asked_next() {
        let mut s = Suggest::default();
        s.set_engine(Some(google()));
        let Ask::Fetch(first) = s.ask(1, "we", true) else { panic!() };
        assert_eq!(first.url, "https://www.google.com/complete/search?client=firefox&q=we");
        assert_eq!(s.ask(1, "wea", true), Ask::Held);
        assert_eq!(s.ask(1, "weat", true), Ask::Held);
        // (Another window's own.)
        assert!(matches!(s.ask(2, "x", true), Ask::Fetch(_)));
        let (shown, next) = s.answered(1, first.seq, 200, br#"["we",["web","weather"]]"#);
        assert_eq!(shown, Some(("we".into(), vec!["web".into(), "weather".into()])));
        let next = next.expect("the newest asked");
        assert_eq!(next.query, "weat");
        // (An old answer, or another's number: nothing.)
        assert_eq!(s.answered(1, first.seq, 200, br#"["we",["x"]]"#), (None, None));
        let (shown, again) = s.answered(1, next.seq, 500, b"");
        assert_eq!((shown, again), (None, None));
        // (Kept: asked again, known at once.)
        assert_eq!(s.ask(1, "WE", true), Ask::Known("WE".into(), vec!["web".into(), "weather".into()]));
    }

    #[test]
    fn typed_back_to_what_answered_asks_nothing_more() {
        let mut s = Suggest::default();
        s.set_engine(Some(google()));
        let Ask::Fetch(f) = s.ask(1, "a", true) else { panic!() };
        assert_eq!(s.ask(1, "ab", true), Ask::Held);
        assert_eq!(s.ask(1, "a", true), Ask::Held);
        let (shown, next) = s.answered(1, f.seq, 200, br#"["a",["a1"]]"#);
        assert_eq!(shown, Some(("a".into(), vec!["a1".into()])));
        assert_eq!(next, None);
        // (Cleared meanwhile: nothing asked after.)
        let Ask::Fetch(f) = s.ask(1, "b", true) else { panic!() };
        assert_eq!(s.ask(1, "bc", true), Ask::Held);
        assert_eq!(s.ask(1, "", true), Ask::Clear);
        assert_eq!(s.answered(1, f.seq, 200, br#"["b",["b1"]]"#).1, None);
    }

    #[test]
    fn another_engine_forgets() {
        let mut s = Suggest::default();
        s.set_engine(Some(google()));
        let Ask::Fetch(f) = s.ask(1, "a", true) else { panic!() };
        assert!(s.set_engine(Some(&ENGINES[2])));
        assert!(!s.set_engine(Some(&ENGINES[2])));
        assert_eq!(s.answered(1, f.seq, 200, br#"["a",["a1"]]"#), (None, None));
        let Ask::Fetch(f) = s.ask(1, "a b", true) else { panic!() };
        assert_eq!(f.url, "https://duckduckgo.com/ac/?q=a%20b&type=list");
        s.forget(1);
        assert!(matches!(s.ask(1, "a b c", true), Ask::Fetch(_)));
    }
}

//! The theme store's client rules, held to the server's own formats: cloud/themes/vectors.json is made by the server's
//! code (tests/cloud-themes-vectors.test.ts checks it's what that code makes), and read here.

use super::*;
use serde_json::Value;

const VECTORS: &str = include_str!("../../../../../cloud/themes/vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("vectors.json")
}

fn s<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    path.iter().fold(v, |v, k| &v[*k]).as_str().unwrap_or_else(|| panic!("vectors: {path:?}"))
}

fn test_key(v: &Value) -> InstallKey {
    InstallKey::from_seed(&BASE64.decode(s(v, &["seed"])).unwrap()).unwrap()
}

fn config_of(v: &Value) -> StoreConfig {
    config(Some(("https://themes.example", s(v, &["index", "publicKey"])))).expect("config")
}

#[test]
fn the_key_and_what_it_signs_are_the_servers() {
    let v = vectors();
    let key = test_key(&v);
    assert_eq!(key.public_key(), s(&v, &["publicKey"]));
    assert_eq!(key.id(), s(&v, &["keyId"]));
    let r = &v["request"];
    let body = BASE64.decode(s(r, &["body"])).unwrap();
    let text = signed_text(
        s(r, &["method"]),
        s(r, &["path"]),
        s(r, &["time"]),
        &hex::encode(Sha256::digest(&body)),
        s(r, &["meta"]),
    );
    assert_eq!(text, s(r, &["text"]));
    assert_eq!(
        key.sign(&text),
        s(r, &["signature"]),
        "Ed25519 is deterministic: the server's signature, byte for byte"
    );
    // An upload signed as the server checks it.
    let req = upload_request(&config_of(&v), &key, body.clone(), "Ana", s(r, &["time"]).parse().unwrap());
    let h = |name: &str| req.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()).unwrap();
    assert_eq!(req.url, "https://themes.example/v1/themes");
    assert_eq!(h("X-Margin-Key"), key.id());
    assert_eq!(h("X-Margin-Meta"), s(r, &["meta"]));
    assert_eq!(h("X-Margin-Signature"), s(r, &["signature"]));
}

#[test]
fn the_proof_of_work_is_the_servers() {
    let v = vectors();
    let p = &v["pow"];
    let bits = p["bits"].as_u64().unwrap() as u32;
    let stop = AtomicBool::new(false);
    let nonce = solve(s(p, &["challenge"]), s(p, &["publicKey"]), bits, 1, &stop).unwrap();
    assert_eq!(nonce, s(p, &["nonce"]), "one thread finds the smallest, as the server's test did");
    assert!(work_ok(s(p, &["challenge"]), s(p, &["publicKey"]), &nonce, bits));
    assert!(
        !work_ok(s(p, &["challenge"]), s(p, &["publicKey"]), &(nonce.parse::<u64>().unwrap() - 1).to_string(), bits)
            || nonce == "0"
    );
    // Many threads find one that works too.
    let many = solve(s(p, &["challenge"]), s(p, &["publicKey"]), bits, 8, &stop).unwrap();
    assert!(work_ok(s(p, &["challenge"]), s(p, &["publicKey"]), &many, bits));
    // Stopped: none.
    assert_eq!(solve(s(p, &["challenge"]), s(p, &["publicKey"]), 60, 2, &AtomicBool::new(true)), None);
    // The challenge read, and too much work refused.
    let body = json!({ "challenge": s(p, &["challenge"]), "bits": bits }).to_string();
    assert_eq!(read_challenge(body.as_bytes()).unwrap(), (s(p, &["challenge"]).to_string(), bits));
    let greedy = json!({ "challenge": s(p, &["challenge"]), "bits": MAX_POW_BITS + 1 }).to_string();
    assert!(read_challenge(greedy.as_bytes()).unwrap_err().contains("more work"));
    assert!(read_challenge(br#"{"challenge":"a b.c.d.e","bits":8}"#).is_err());
    assert!(read_challenge(b"nope").is_err());
}

#[test]
fn the_index_checked_with_the_stores_key_then_read() {
    let v = vectors();
    let key: [u8; 32] = B64URL.decode(s(&v, &["index", "publicKey"])).unwrap().try_into().unwrap();
    let body = s(&v, &["index", "body"]).as_bytes();
    let entries = read_index(body, &key).unwrap();
    let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, ["dusk", "paper"], "the bad entries left out: a built-in's id, a bad sha, a repeat");
    assert_eq!(entries[0].author_key, "0123abcd");
    assert_eq!(entries[0].size, 1234);
    // Another key's, or the text changed by one letter: refused whole.
    let other = InstallKey::from_seed(&[9u8; 32]).unwrap().public_raw();
    assert!(read_index(body, &other).unwrap_err().contains("isn’t signed by the store"));
    let changed = String::from_utf8(body.to_vec()).unwrap().replacen("dusk", "dask", 1);
    assert!(read_index(changed.as_bytes(), &key).is_err());
    assert!(read_index(b"{}", &key).is_err());
    assert!(read_index(&vec![b' '; MAX_INDEX_BYTES + 1], &key).unwrap_err().contains("too large"));
}

#[test]
fn what_each_store_theme_is_to_this_install() {
    let e = |id: &str, version: &str, updated: f64| StoreEntry {
        id: id.into(),
        name: id.into(),
        description: String::new(),
        version: version.into(),
        author: "A".into(),
        author_key: "00000000".into(),
        sha256: "0".repeat(64),
        size: 10,
        updated,
    };
    let have = |id: &str, store: Option<&str>| {
        let mut o = json!({ "id": id, "version": "9.9.9" }).as_object().cloned().unwrap();
        if let Some(v) = store {
            o.insert("store".into(), json!({ "version": v, "sha256": "0".repeat(64) }));
        }
        o
    };
    let installed =
        vec![have("same", Some("1.2.0")), have("old", Some("1.9.0")), have("mine", None), have("newer", Some("2.0.0"))];
    assert_eq!(state_of(&e("new", "1.0.0", 0.0), &installed).0, "install");
    assert_eq!(state_of(&e("same", "1.2.0", 0.0), &installed), ("installed", Some("1.2.0".into())));
    assert_eq!(state_of(&e("old", "1.10.0", 0.0), &installed), ("update", Some("1.9.0".into())), "1.10 is after 1.9");
    assert_eq!(
        state_of(&e("mine", "5.0.0", 0.0), &installed).0,
        "yours",
        "a copy or a linked theme is never replaced from the store"
    );
    assert_eq!(state_of(&e("newer", "1.0.0", 0.0), &installed).0, "installed");
    let rows = catalog(&[e("a", "1.0.0", 1.0), e("b", "1.0.0", 3.0), e("c", "1.0.0", 2.0)], &installed);
    let order: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(order, ["b", "c", "a"], "newest first");
    assert_eq!(version_parts("1.2.3"), Some((1, 2, 3)));
    for bad in ["1.2", "1.2.3.4", "01234.1.1", "a.b.c", "1..2", ""] {
        assert_eq!(version_parts(bad), None, "{bad}");
    }
}

#[test]
fn a_shared_theme_is_the_servers_zip_byte_for_byte() {
    let v = vectors();
    let (zip, author) = share_zip(s(&v, &["share", "message"])).unwrap();
    assert_eq!(
        BASE64.encode(&zip),
        s(&v, &["share", "zip"]),
        "the same bytes as the server's test made (and read back)"
    );
    assert_eq!(author, "Ana Lima");
    let without = json!({ "id": "x", "manifest": "{\"id\":\"x\",\"name\":\"X\",\"version\":\"1.0.0\"}", "html": "", "css": "", "files": {} });
    assert!(share_zip(&without.to_string()).unwrap_err().contains("author"));
    assert!(share_zip("{}").is_err());
    assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
}

#[test]
fn a_package_is_the_indexs() {
    let bytes = b"zip bytes".to_vec();
    let mut entry = StoreEntry {
        id: "x".into(),
        name: "X".into(),
        description: String::new(),
        version: "1.0.0".into(),
        author: "A".into(),
        author_key: "00000000".into(),
        sha256: hex::encode(Sha256::digest(&bytes)),
        size: bytes.len() as u64,
        updated: 0.0,
    };
    assert!(package_ok(&bytes, &entry));
    assert!(!package_ok(b"zip bytez", &entry));
    entry.size += 1;
    assert!(!package_ok(&bytes, &entry));
}

#[test]
fn where_the_store_is() {
    let k = InstallKey::from_seed(&[7u8; 32]).unwrap().public_key();
    assert!(config(Some(("https://themes.example/", &k))).is_some());
    assert_eq!(config(Some(("https://themes.example/", &k))).unwrap().base, "https://themes.example");
    assert!(config(Some(("http://127.0.0.1:8787", &k))).is_some(), "a local test server");
    for bad in [
        "http://themes.example",
        "https://themes.example/v1",
        "https://u:p@themes.example",
        "ftp://x",
        "https://x.example?q",
        "nope",
    ] {
        assert!(config(Some((bad, &k))).is_none(), "{bad}");
    }
    assert!(config(Some(("https://themes.example", "short"))).is_none());
    assert_eq!(config(None), STORE.and_then(|s| config(Some(s))));
}

#[test]
fn the_key_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("theme-store");
    let a = InstallKey::load_or_make(&root).unwrap();
    let b = InstallKey::load_or_make(&root).unwrap();
    assert_eq!(a.id(), b.id(), "made once, then read");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(root.join("key")).unwrap().permissions().mode() & 0o777, 0o600);
    }
    fs::write(root.join("key"), "not a key").unwrap();
    assert!(
        InstallKey::load_or_make(&root).is_err(),
        "never replaced: a new key would lose the themes this one shared"
    );
    assert_eq!(fs::read_to_string(root.join("key")).unwrap(), "not a key");
}

#[test]
fn what_an_answer_means() {
    assert_eq!(outcome("upload", 201, br#"{"id":"x","status":"review"}"#)["data"]["status"], "review");
    assert_eq!(outcome("upload", 401, br#"{"error":"unknown-key","message":"m"}"#)["register"], true);
    assert_eq!(
        outcome("register", 401, br#"{"error":"unknown-key","message":"m"}"#)["register"],
        Value::Null,
        "registering never loops"
    );
    let refused = outcome(
        "upload",
        409,
        "{\"error\":\"not-yours\",\"message\":\"The theme id \\u202e is another author's.\"}".as_bytes(),
    );
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["error"], "not-yours");
    assert_eq!(refused["message"], "The theme id  is another author's.", "bidi marks out of the server's words");
    assert_eq!(
        outcome("index", 503, b"<html>").get("message").and_then(Value::as_str),
        Some("The theme store isn’t working right now: try again later.")
    );
    assert_eq!(outcome("package", 200, b"PK..")["ok"], true);
    let long = json!({ "message": "x".repeat(1000) }).to_string();
    assert_eq!(outcome("report", 400, long.as_bytes())["message"].as_str().unwrap().chars().count(), 300);
}

/// How long the work takes here (`cargo test --release -p margin-core --lib pow_timing -- --ignored --nocapture`).
#[test]
#[ignore]
fn pow_timing() {
    let stop = AtomicBool::new(false);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    for i in 0..3 {
        let t = std::time::Instant::now();
        let n = solve(
            &format!("1795600600000.28.AAAAAAAAAAAAAAAAAAAAA{i}.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
            "pk",
            28,
            threads,
            &stop,
        )
        .unwrap();
        eprintln!("28 bits, {threads} threads: nonce {n} in {:?}", t.elapsed());
    }
}

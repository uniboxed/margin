//! The WebSocket protocol (RFC 6455) on the app's end of the link, done by hand (app/macos/shell/LinkSocket.swift):
//! the HTTP upgrade ([`parse`], [`is_upgrade`], [`switching`], [`refusal`]), the app's frames ([`encode`],
//! [`close_frame`]: never masked) and the copy's ([`FrameReader`]: always masked), and the constant-time check of
//! a secret ([`same_secret`]). Only what the background's WebSocket uses: text, ping, pong and close, no
//! extensions (permessage-deflate offered is simply not taken). Bytes in, bytes and messages out: the TCP
//! connection is the caller's ([`crate::socket::SocketLink`] joins these to the link).
//!
//! As the Swift, one rule each: a request is a `GET` with `HTTP/1.1`, its head at most 16 KB until its blank
//! line; header names are taken lower-case, the last of a name kept; a client's frame must be masked and have no
//! reserved bits; a message is at most 64 MB, its frames put together (a ping or a close may come between them);
//! a binary message or a pong is nothing to do. What the Swift doesn't check isn't checked here either (a control
//! frame over 125 bytes or in pieces).
//!
//! The one difference: the request's target is split at `?` by hand, where the Swift's `URLComponents` parses it.
//! Both decode `%xx` (and leave `+` as it is); a target that doesn't decode (a bad `%`, or not UTF-8) is taken as
//! no path and no query, as `URLComponents` returning none is; an absolute target (`http://…/`) has a path that
//! isn't `/` here (refused: not the link's path).

use std::collections::BTreeMap;

use base64::Engine;

/// `Handshake.Request`: the request's path, its query (decoded) and its headers (lower-case names).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Request {
    pub path: String,
    pub query: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
}

impl Request {
    /// A header by its lower-case name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

/// `Handshake.Parsed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Parsed {
    /// Not all here yet.
    Incomplete,
    /// Not a request the app takes (answered 400).
    Bad,
    /// The request, and what came after it (frames already sent).
    Request(Request, Vec<u8>),
}

/// `Handshake.maxBytes`: a request's head is at most this long until its blank line comes.
pub const MAX_HANDSHAKE: usize = 16 * 1024;

/// RFC 6455's GUID, added to the client's key for `Sec-WebSocket-Accept`.
const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// `Handshake.parse`: the request in `data`, once its head has all come.
pub fn parse(data: &[u8]) -> Parsed {
    let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") else {
        return if data.len() > MAX_HANDSHAKE { Parsed::Bad } else { Parsed::Incomplete };
    };
    let Ok(head) = std::str::from_utf8(&data[..end]) else { return Parsed::Bad };
    let mut lines = head.split("\r\n");
    // (Swift's split(separator:) leaves out empty pieces: two spaces are one.)
    let first: Vec<&str> = lines.next().unwrap_or("").split(' ').filter(|s| !s.is_empty()).collect();
    if first.len() != 3 || first[0] != "GET" || !first[2].starts_with("HTTP/1.1") {
        return Parsed::Bad;
    }
    let mut headers = BTreeMap::new();
    for line in lines {
        let Some(colon) = line.find(':') else { return Parsed::Bad };
        headers.insert(line[..colon].trim().to_lowercase(), line[colon + 1..].trim().to_owned());
    }
    let (path, query) = target(first[1]).unwrap_or_default();
    Parsed::Request(Request { path, query, headers }, data[end + 4..].to_vec())
}

/// A request target's path and query items, decoded; `None` if it doesn't decode.
fn target(t: &str) -> Option<(String, BTreeMap<String, String>)> {
    let t = t.split('#').next().unwrap_or("");
    let (path, query) = match t.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (t, None),
    };
    let mut items = BTreeMap::new();
    for item in query.unwrap_or("").split('&').filter(|i| !i.is_empty()) {
        let (name, value) = item.split_once('=').unwrap_or((item, ""));
        items.insert(decode(name)?, decode(value)?);
    }
    Some((decode(path)?, items))
}

/// `%xx` decoded (as `URLComponents` does: `+` stays `+`); `None` for a bad escape or bytes that aren't UTF-8.
fn decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `Handshake.isUpgrade`: whether it asks for a WebSocket at all (what it asks of the app is the link's to judge).
pub fn is_upgrade(r: &Request) -> bool {
    r.header("upgrade").is_some_and(|u| u.to_lowercase() == "websocket")
        && r.header("connection").is_some_and(|c| c.to_lowercase().contains("upgrade"))
        && r.header("sec-websocket-version") == Some("13")
        && r.header("sec-websocket-key").is_some_and(|k| !k.is_empty())
}

/// `Handshake.accept`: `Sec-WebSocket-Accept` for a client's key.
pub fn accept(key: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(sha1(format!("{key}{GUID}").as_bytes()))
}

/// `Handshake.switching`: the answer that opens the WebSocket.
pub fn switching(key: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        accept(key)
    )
    .into_bytes()
}

/// `Handshake.refusal`: a request turned away before any WebSocket (`403 Forbidden`, `400 Bad Request`).
pub fn refusal(status: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
}

/// `sameSecret`: two secrets compared in the same time whatever they hold.
pub fn same_secret(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    let mut differ = u8::from(x.len() != y.len());
    for i in 0..x.len().max(y.len()) {
        differ |= x.get(i).copied().unwrap_or(0) ^ y.get(i).copied().unwrap_or(0);
    }
    differ == 0
}

/// `Frame.Op`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Continuation = 0,
    Text = 1,
    Binary = 2,
    Close = 8,
    Ping = 9,
    Pong = 10,
}

impl Op {
    fn from_bits(b: u8) -> Option<Self> {
        Some(match b {
            0 => Self::Continuation,
            1 => Self::Text,
            2 => Self::Binary,
            8 => Self::Close,
            9 => Self::Ping,
            10 => Self::Pong,
            _ => return None,
        })
    }
}

/// One frame from the copy, unmasked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub op: Op,
    pub fin: bool,
    pub payload: Vec<u8>,
}

/// `Frame.encode`: one of the app's frames, whole (`fin`), never masked (only a client's are).
pub fn encode(op: Op, payload: &[u8]) -> Vec<u8> {
    let n = payload.len();
    let mut out = Vec::with_capacity(n + 10);
    out.push(0x80 | op as u8);
    if n < 126 {
        out.push(n as u8);
    } else if n < 65536 {
        out.push(126);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(127);
        out.extend_from_slice(&(n as u64).to_be_bytes());
    }
    out.extend_from_slice(payload);
    out
}

/// `Frame.close`: a close frame with its code and (the first 120 bytes of) its reason.
pub fn close_frame(code: u16, why: &str) -> Vec<u8> {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend(why.as_bytes().iter().take(120));
    encode(Op::Close, &payload)
}

/// `FrameReader.Failure`: what ends the connection (closed 1002, its name as the reason).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Unmasked,
    Reserved,
    BadOp,
    TooBig,
    BadText,
    BadClose,
}

impl std::fmt::Display for Failure {
    /// As Swift prints the case: the close's reason and the log's words.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unmasked => "unmasked",
            Self::Reserved => "reserved",
            Self::BadOp => "badOp",
            Self::TooBig => "tooBig",
            Self::BadText => "badText",
            Self::BadClose => "badClose",
        })
    }
}

/// `FrameReader.Message`: a whole message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message {
    Text(String),
    Ping(Vec<u8>),
    /// The close frame's code (1005 when it carried none) and its reason (UTF-8, at most 123 bytes).
    Close {
        code: u16,
        reason: String,
    },
    /// A pong, a binary message: nothing to do.
    Nothing,
}

/// `FrameReader.maxMessage`: the largest message taken (the first snapshot holds every site icon).
pub const MAX_MESSAGE: usize = crate::protocol::MAX_INCOMING;

/// `FrameReader`: frames from the copy as its bytes come, then whole messages.
#[derive(Clone, Debug, Default)]
pub struct FrameReader {
    buffer: Vec<u8>,
    start: usize,
    parts: Vec<u8>,
    in_message: bool,
    binary: bool,
}

impl FrameReader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn append(&mut self, data: &[u8]) {
        if self.start > 0 && self.start == self.buffer.len() {
            self.buffer.clear();
            self.start = 0;
        } else if self.start > 65536 && self.start * 2 > self.buffer.len() {
            self.buffer.drain(..self.start);
            self.start = 0;
        }
        self.buffer.extend_from_slice(data);
    }

    /// The next frame, or `None` until it has all come.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, Failure> {
        let buf = &self.buffer;
        let start = self.start;
        let available = buf.len() - start;
        if available < 2 {
            return Ok(None);
        }
        let (b0, b1) = (buf[start], buf[start + 1]);
        if b0 & 0x70 != 0 {
            return Err(Failure::Reserved);
        }
        let op = Op::from_bits(b0 & 0x0f).ok_or(Failure::BadOp)?;
        if b1 & 0x80 == 0 {
            return Err(Failure::Unmasked);
        }
        let mut at = start + 2;
        let mut length = usize::from(b1 & 0x7f);
        if length == 126 {
            if available < 4 {
                return Ok(None);
            }
            length = usize::from(u16::from_be_bytes([buf[at], buf[at + 1]]));
            at += 2;
        } else if length == 127 {
            if available < 10 {
                return Ok(None);
            }
            let mut n = [0u8; 8];
            n.copy_from_slice(&buf[at..at + 8]);
            let n = u64::from_be_bytes(n);
            if n > MAX_MESSAGE as u64 {
                return Err(Failure::TooBig);
            }
            length = n as usize;
            at += 8;
        }
        if length > MAX_MESSAGE {
            return Err(Failure::TooBig);
        }
        if buf.len() - at < 4 + length {
            return Ok(None);
        }
        let mask = [buf[at], buf[at + 1], buf[at + 2], buf[at + 3]];
        at += 4;
        let payload: Vec<u8> = buf[at..at + length].iter().enumerate().map(|(i, b)| b ^ mask[i & 3]).collect();
        self.start = at + length;
        Ok(Some(Frame { op, fin: b0 & 0x80 != 0, payload }))
    }

    /// The next whole message (text put together from its frames), or `None` until it has come.
    pub fn next_message(&mut self) -> Result<Option<Message>, Failure> {
        while let Some(frame) = self.next_frame()? {
            match frame.op {
                Op::Ping => return Ok(Some(Message::Ping(frame.payload))),
                Op::Close => return close_message(&frame.payload).map(Some),
                Op::Pong => return Ok(Some(Message::Nothing)),
                Op::Text | Op::Binary | Op::Continuation => {
                    if frame.op == Op::Continuation {
                        if !self.in_message {
                            return Err(Failure::BadOp);
                        }
                    } else {
                        if self.in_message {
                            return Err(Failure::BadOp);
                        }
                        self.in_message = true;
                        self.parts.clear();
                        self.binary = frame.op == Op::Binary;
                    }
                    if self.parts.len() + frame.payload.len() > MAX_MESSAGE {
                        return Err(Failure::TooBig);
                    }
                    self.parts.extend_from_slice(&frame.payload);
                    if !frame.fin {
                        continue;
                    }
                    self.in_message = false;
                    let parts = std::mem::take(&mut self.parts);
                    if self.binary {
                        return Ok(Some(Message::Nothing));
                    }
                    return String::from_utf8(parts).map(|t| Some(Message::Text(t))).map_err(|_| Failure::BadText);
                }
            }
        }
        Ok(None)
    }
}

/// `FrameReader.close`: a close frame's payload (RFC 6455 5.5.1): empty, no status code (1005); else two bytes of
/// code, then the reason. The reason is clipped to 123 bytes (a control frame's most) and taken only as UTF-8;
/// control characters become spaces, for the log.
pub fn close_message(payload: &[u8]) -> Result<Message, Failure> {
    if payload.is_empty() {
        return Ok(Message::Close { code: 1005, reason: String::new() });
    }
    if payload.len() < 2 {
        return Err(Failure::BadClose);
    }
    let code = u16::from_be_bytes([payload[0], payload[1]]);
    let raw = &payload[2..payload.len().min(2 + 123)];
    // (Clipped in the middle of a character: up to 3 bytes less.)
    let most = if raw.len() < payload.len() - 2 { raw.len().min(3) } else { 0 };
    let Some(text) = (0..=most).find_map(|cut| std::str::from_utf8(&raw[..raw.len() - cut]).ok()) else {
        return Ok(Message::Close { code, reason: "(a reason that isn't UTF-8)".into() });
    };
    let reason = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    Ok(Message::Close { code, reason })
}

/// `FrameReader.describeClose`: how a close reads in the log: "1000 no word from the app for 12 s",
/// "1001 going away", "1005, no status code", "1006, no close frame".
pub fn describe_close(code: u16, reason: &str) -> String {
    if !reason.is_empty() {
        return format!("{code} {reason}");
    }
    match code {
        1000 => "1000 normal".into(),
        1001 => "1001 going away".into(),
        1002 => "1002 protocol error".into(),
        1005 => "1005, no status code".into(),
        1006 => "1006, no close frame".into(),
        1008 => "1008 policy".into(),
        1011 => "1011 unexpected condition".into(),
        _ => code.to_string(),
    }
}

/// SHA-1 (FIPS 180-4), for `Sec-WebSocket-Accept` only (the Swift's `Insecure.SHA1`): nothing secret rests on it.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let mut message = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bits.to_be_bytes());
    for block in message.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// A frame as an extension's WebSocket sends it: masked (the tests', here and in the link's).
#[cfg(test)]
pub(crate) fn client_frame(op: u8, payload: &[u8], fin: bool) -> Vec<u8> {
    let mask = [0x37u8, 0xfa, 0x21, 0x3d];
    let n = payload.len();
    let mut out = vec![u8::from(fin) << 7 | op];
    if n < 126 {
        out.push(0x80 | n as u8);
    } else if n < 65536 {
        out.push(0x80 | 126);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(n as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i & 3]));
    out
}

/// The app's frames, read back: each one's op and payload, or `None` if they don't parse (the tests').
#[cfg(test)]
pub(crate) fn server_frames(mut bytes: &[u8]) -> Option<Vec<(u8, Vec<u8>)>> {
    let mut out = Vec::new();
    while !bytes.is_empty() {
        let (b0, b1) = (*bytes.first()?, *bytes.get(1)?);
        if b1 & 0x80 != 0 {
            return None;
        }
        let (len, at) = match b1 & 0x7f {
            126 => (usize::from(u16::from_be_bytes([*bytes.get(2)?, *bytes.get(3)?])), 4),
            127 => {
                let mut n = [0u8; 8];
                n.copy_from_slice(bytes.get(2..10)?);
                (u64::from_be_bytes(n) as usize, 10)
            }
            n => (usize::from(n), 2),
        };
        out.push((b0 & 0x0f, bytes.get(at..at + len)?.to_vec()));
        bytes = &bytes[at + len..];
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST: &str = "GET /?t=ab%2Bc&x=1 HTTP/1.1\r\nHost: 127.0.0.1:5\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: safari-web-extension://ABC\r\n\r\n";

    fn text(s: &str) -> Message {
        Message::Text(s.into())
    }

    fn close(code: u16, reason: &str) -> Message {
        Message::Close { code, reason: reason.into() }
    }

    #[test]
    fn the_handshake() {
        assert_eq!(parse(&REQUEST.as_bytes()[..40]), Parsed::Incomplete, "in pieces: waits");
        let mut data = REQUEST.as_bytes().to_vec();
        data.extend_from_slice(&[0x81, 0x80]);
        let Parsed::Request(r, rest) = parse(&data) else { panic!("parses") };
        assert_eq!(r.path, "/");
        assert_eq!(r.query.get("t").map(String::as_str), Some("ab+c"), "the query decoded");
        assert_eq!(r.query.get("x").map(String::as_str), Some("1"));
        assert_eq!(r.header("origin"), Some("safari-web-extension://ABC"), "headers by lower-case name");
        assert_eq!(rest, vec![0x81, 0x80], "what came after it kept");
        assert!(is_upgrade(&r), "a WebSocket upgrade");
        let Parsed::Request(plain, _) = parse(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n") else { panic!("plain GET parses") };
        assert!(!is_upgrade(&plain), "plain GET: no upgrade");
        assert_eq!(parse(b"POST / HTTP/1.1\r\n\r\n"), Parsed::Bad, "not GET: bad");
        assert_eq!(parse(&vec![0x41; MAX_HANDSHAKE + 1]), Parsed::Bad, "too long a request: bad");
        assert_eq!(parse(&vec![0x41; MAX_HANDSHAKE]), Parsed::Incomplete);
        assert_eq!(parse(b"GET / HTTP/1.1\r\nno colon\r\n\r\n"), Parsed::Bad, "a header line without a colon");
        assert_eq!(parse(b"GET / HTTP/1.0\r\n\r\n"), Parsed::Bad, "not HTTP/1.1");
        assert_eq!(parse(b"GET \xff HTTP/1.1\r\n\r\n"), Parsed::Bad, "not UTF-8");
    }

    #[test]
    fn a_target_that_doesnt_decode_has_no_path_or_query() {
        let Parsed::Request(r, _) = parse(b"GET /?t=%zz HTTP/1.1\r\n\r\n") else { panic!("parses") };
        assert_eq!((r.path.as_str(), r.query.len()), ("", 0));
        let Parsed::Request(r, _) = parse(b"GET /path?t&u=%E2%9C%93#frag HTTP/1.1\r\n\r\n") else { panic!("parses") };
        assert_eq!(r.path, "/path");
        assert_eq!(r.query.get("t").map(String::as_str), Some(""), "an item with no value");
        assert_eq!(r.query.get("u").map(String::as_str), Some("✓"));
    }

    #[test]
    fn the_accept_key_and_the_answers() {
        assert_eq!(accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "RFC 6455's example");
        assert_eq!(
            String::from_utf8(switching("dGhlIHNhbXBsZSBub25jZQ==")).unwrap_or_default(),
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"
        );
        assert_eq!(
            refusal("403 Forbidden"),
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        // SHA-1's own vectors (FIPS 180-1): the empty message, "abc", and one over a block.
        assert_eq!(hex::encode(sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(hex::encode(sha1(b"abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            hex::encode(sha1(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
    }

    #[test]
    fn secrets() {
        assert!(same_secret("abc123", "abc123"), "same secrets");
        assert!(!same_secret("abc123", "abc124") && !same_secret("abc", "abc1") && !same_secret("", "a"));
        assert!(same_secret("", ""));
    }

    #[test]
    fn frames() {
        let mut reader = FrameReader::new();
        let mut got = Vec::new();
        for byte in client_frame(1, br#"{"k":"hello"}"#, true) {
            reader.append(&[byte]);
            while let Ok(Some(m)) = reader.next_message() {
                got.push(m);
            }
        }
        assert_eq!(got, vec![text(r#"{"k":"hello"}"#)], "a text frame, a byte at a time");
        let mut two = client_frame(1, &[0x61; 300], true);
        two.extend(client_frame(1, &[0x62; 70_000], true));
        reader.append(&two);
        assert_eq!(reader.next_message(), Ok(Some(text(&"a".repeat(300)))), "a 16-bit length");
        assert_eq!(reader.next_message(), Ok(Some(text(&"b".repeat(70_000)))), "a 64-bit length");
        assert_eq!(reader.next_message(), Ok(None), "then nothing");
        let mut pieces = client_frame(1, b"hel", false);
        pieces.extend(client_frame(9, &[1, 2], true));
        pieces.extend(client_frame(0, b"lo", true));
        pieces.extend(client_frame(8, &[3, 232], true));
        reader.append(&pieces);
        assert_eq!(reader.next_message(), Ok(Some(Message::Ping(vec![1, 2]))), "a ping between a message's frames");
        assert_eq!(reader.next_message(), Ok(Some(text("hello"))), "the message from its frames");
        assert_eq!(reader.next_message(), Ok(Some(close(1000, ""))), "close: its code and no reason");
    }

    #[test]
    fn close_frames() {
        let mut closes = FrameReader::new();
        let mut bytes = client_frame(8, &[3, 233, b'x'], true);
        bytes.extend(client_frame(8, &[], true));
        let mut own = vec![3, 232];
        own.extend_from_slice(b"no word from the app for 12 s");
        bytes.extend(client_frame(8, &own, true));
        closes.append(&bytes);
        assert_eq!(closes.next_message(), Ok(Some(close(1001, "x"))), "a close frame of 1001 'x': both");
        assert_eq!(closes.next_message(), Ok(Some(close(1005, ""))), "an empty close frame: 1005, no status code");
        assert_eq!(
            closes.next_message(),
            Ok(Some(close(1000, "no word from the app for 12 s"))),
            "a copy's own reason"
        );
        assert_eq!(describe_close(1001, "x"), "1001 x");
        assert_eq!(describe_close(1001, ""), "1001 going away");
        assert_eq!(describe_close(1005, ""), "1005, no status code");
        assert_eq!(describe_close(1000, "no word from the app for 12 s"), "1000 no word from the app for 12 s");
        assert_eq!(describe_close(4000, ""), "4000");
        let mut one = FrameReader::new();
        one.append(&client_frame(8, &[3], true));
        assert_eq!(one.next_message(), Err(Failure::BadClose), "a close frame of one byte: refused");
        assert_eq!(close_message(&[3, 232, 0xc3, 0x28]), Ok(close(1000, "(a reason that isn't UTF-8)")));
        let mut long = vec![3, 232];
        long.extend("a".repeat(122).as_bytes());
        long.extend("é".as_bytes());
        long.extend(b"bbb");
        assert_eq!(close_message(&long), Ok(close(1000, &"a".repeat(122))), "clipped, never half a character");
        assert_eq!(close_message(&[3, 232, b'a', b'\n', b'b']), Ok(close(1000, "a b")), "control characters: spaces");
    }

    #[test]
    fn what_a_client_mustnt_send() {
        let mut unmasked = FrameReader::new();
        unmasked.append(&[0x81, 0x02, 0x68, 0x69]);
        assert_eq!(unmasked.next_message(), Err(Failure::Unmasked), "an unmasked frame (not a client's): refused");
        let mut bad_text = FrameReader::new();
        bad_text.append(&client_frame(1, &[0xc3, 0x28], true));
        assert_eq!(bad_text.next_message(), Err(Failure::BadText), "text that isn't UTF-8: refused");
        let mut reserved = FrameReader::new();
        reserved.append(&[0xc1, 0x80, 0, 0, 0, 0]);
        assert_eq!(reserved.next_message(), Err(Failure::Reserved));
        let mut op = FrameReader::new();
        op.append(&[0x83, 0x80, 0, 0, 0, 0]);
        assert_eq!(op.next_message(), Err(Failure::BadOp));
        let mut lone = FrameReader::new();
        lone.append(&client_frame(0, b"x", true));
        assert_eq!(lone.next_message(), Err(Failure::BadOp), "a continuation of nothing");
        let mut twice = FrameReader::new();
        let mut b = client_frame(1, b"a", false);
        b.extend(client_frame(1, b"b", true));
        twice.append(&b);
        assert_eq!(twice.next_message(), Err(Failure::BadOp), "a new message inside one");
        let mut big = FrameReader::new();
        let mut head = vec![0x81, 0x80 | 127];
        head.extend_from_slice(&((MAX_MESSAGE as u64) + 1).to_be_bytes());
        big.append(&head);
        assert_eq!(big.next_message(), Err(Failure::TooBig), "over 64 MB: refused before it comes");
        let mut binary = FrameReader::new();
        binary.append(&client_frame(2, &[1, 2, 3], true));
        binary.append(&client_frame(10, b"p", true));
        assert_eq!(binary.next_message(), Ok(Some(Message::Nothing)), "a binary message: nothing");
        assert_eq!(binary.next_message(), Ok(Some(Message::Nothing)), "a pong: nothing");
        assert_eq!(Failure::TooBig.to_string(), "tooBig");
    }

    #[test]
    fn the_apps_frames() {
        assert_eq!(encode(Op::Text, b"hi"), vec![0x81, 2, 0x68, 0x69], "short");
        let big = encode(Op::Text, &[0; 70_000]);
        assert_eq!(&big[..10], &[0x81, 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70], "a 64-bit length");
        assert_eq!(big.len(), 70_010);
        assert_eq!(&encode(Op::Text, &[0; 300])[..4], &[0x81, 126, 1, 44], "a 16-bit length");
        assert_eq!(close_frame(1001, "x"), vec![0x88, 3, 3, 233, 0x78], "close frame: its code");
        assert_eq!(close_frame(1000, &"y".repeat(200)).len(), 2 + 2 + 120, "its reason cut at 120 bytes");
        assert_eq!(server_frames(&encode(Op::Pong, b"p")), Some(vec![(10, b"p".to_vec())]));
    }

    #[test]
    fn the_reader_keeps_its_buffer_small() {
        let mut reader = FrameReader::new();
        for _ in 0..200 {
            reader.append(&client_frame(1, &[0x61; 1000], true));
            assert!(matches!(reader.next_message(), Ok(Some(Message::Text(_)))));
        }
        assert!(reader.buffer.len() < 4096, "read frames dropped");
    }
}

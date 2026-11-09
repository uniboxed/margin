//! Native messaging's framing (Chrome and Edge, `runtime.connectNative`): each message is a 4-byte length, then that
//! many bytes of UTF-8 JSON. The length is in native byte order, which is little-endian on every platform Chrome
//! and Edge ship on (x86-64, ARM64), so it's written and read as little-endian here (the e2e harness's
//! tests/e2e/harness/native-host.mts does the same). The same framing carries the link's messages on the named pipe
//! between the relay (margin.exe started by the browser) and the app, so the pipe needs no framing of its own.
//!
//! The caps: a message to the browser is at most 1 MB ([`MAX_TO_BROWSER`]: Chrome closes the port on a bigger one
//! from the host, PROTOCOL.md "Sizes"); one from it at most 64 MB ([`MAX_FROM_BROWSER`]: Chrome's own limit to a
//! host, and the app's for any link message). A length over the cap is refused as soon as its 4 bytes are here,
//! before anything of the message is kept.

use crate::protocol::{MAX_APP_MESSAGE, MAX_INCOMING};

/// The largest frame to the browser (or to the relay, on its way there): the app's 1 MB message cap.
pub const MAX_TO_BROWSER: usize = MAX_APP_MESSAGE;
/// The largest frame from the browser (or from the relay): 64 MB.
pub const MAX_FROM_BROWSER: usize = MAX_INCOMING;
/// The length's bytes before each message.
pub const HEADER: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameError {
    /// A message over the cap. Decoding, the stream can't go on (nothing after it can be trusted to be a frame):
    /// close the port or pipe.
    TooBig { len: usize, max: usize },
    /// A frame whose bytes aren't UTF-8. The frame is passed over and the stream goes on.
    NotUtf8,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooBig { len, max } => write!(f, "a message of {len} bytes is over the limit of {max}"),
            Self::NotUtf8 => write!(f, "a message that isn't UTF-8"),
        }
    }
}

impl std::error::Error for FrameError {}

/// One message as a frame, if it's at most `max` bytes.
pub fn encode(json: &str, max: usize) -> Result<Vec<u8>, FrameError> {
    let len = json.len();
    let Ok(head) = u32::try_from(len) else { return Err(FrameError::TooBig { len, max }) };
    if len > max {
        return Err(FrameError::TooBig { len, max });
    }
    let mut out = Vec::with_capacity(HEADER + len);
    out.extend_from_slice(&head.to_le_bytes());
    out.extend_from_slice(json.as_bytes());
    Ok(out)
}

/// One message to the browser (at most 1 MB).
pub fn encode_to_browser(json: &str) -> Result<Vec<u8>, FrameError> {
    encode(json, MAX_TO_BROWSER)
}

/// Frames as the bytes come: any part of one at a time (a partial read), or several in one read.
#[derive(Clone, Debug)]
pub struct Decoder {
    max: usize,
    buf: Vec<u8>,
    /// Where the next frame starts in `buf`.
    start: usize,
    failed: Option<FrameError>,
}

impl Decoder {
    /// Taking frames of at most `max` bytes.
    pub fn new(max: usize) -> Self {
        Self { max, buf: Vec::new(), start: 0, failed: None }
    }

    /// Taking what the browser (or the relay) sends: frames of at most 64 MB.
    pub fn from_browser() -> Self {
        Self::new(MAX_FROM_BROWSER)
    }

    /// Bytes read. After a [`FrameError::TooBig`] they're dropped.
    pub fn push(&mut self, bytes: &[u8]) {
        if self.failed.is_some() {
            return;
        }
        if self.start > 0 {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    /// The next whole message, `Ok(None)` until one is here. After a [`FrameError::TooBig`] every call says it
    /// again.
    pub fn next_message(&mut self) -> Result<Option<String>, FrameError> {
        if let Some(e) = &self.failed {
            return Err(e.clone());
        }
        let rest = &self.buf[self.start..];
        let Some(head) = rest.get(..HEADER) else { return Ok(None) };
        let mut len_bytes = [0u8; HEADER];
        len_bytes.copy_from_slice(head);
        let len = u32::from_le_bytes(len_bytes) as usize;
        if len > self.max {
            let e = FrameError::TooBig { len, max: self.max };
            self.failed = Some(e.clone());
            self.buf = Vec::new();
            self.start = 0;
            return Err(e);
        }
        let Some(body) = HEADER.checked_add(len).and_then(|end| rest.get(HEADER..end)) else { return Ok(None) };
        let text = std::str::from_utf8(body).map(str::to_owned);
        self.start += HEADER + len;
        if self.start == self.buf.len() {
            self.buf.clear();
            self.start = 0;
        }
        text.map(Some).map_err(|_| FrameError::NotUtf8)
    }

    /// The bytes held, not yet a whole frame.
    pub fn buffered(&self) -> usize {
        self.buf.len() - self.start
    }

    /// Whether the stream was refused (a frame over the cap).
    pub fn failed(&self) -> bool {
        self.failed.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(json: &str) -> Vec<u8> {
        encode(json, usize::MAX).unwrap_or_default()
    }

    fn all(d: &mut Decoder) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(Some(m)) = d.next_message() {
            out.push(m);
        }
        out
    }

    #[test]
    fn a_frame_is_its_length_little_endian_then_the_json() {
        assert_eq!(frame(r#"{"k":"tick"}"#)[..4], [12, 0, 0, 0]);
        assert_eq!(&frame("hi")[4..], b"hi");
        let big = "x".repeat(70_000);
        assert_eq!(frame(&big)[..4], [0x70, 0x11, 0x01, 0x00]);
        assert_eq!(frame("")[..], [0, 0, 0, 0]);
    }

    #[test]
    fn to_the_browser_at_most_1_mb() {
        let at = "x".repeat(MAX_TO_BROWSER);
        assert_eq!(encode_to_browser(&at).map(|f| f.len()), Ok(MAX_TO_BROWSER + 4));
        let over = "x".repeat(MAX_TO_BROWSER + 1);
        assert_eq!(encode_to_browser(&over), Err(FrameError::TooBig { len: MAX_TO_BROWSER + 1, max: MAX_TO_BROWSER }));
        assert_eq!(MAX_TO_BROWSER, 1_000_000);
        assert_eq!(MAX_FROM_BROWSER, 64 * 1024 * 1024);
    }

    #[test]
    fn a_byte_at_a_time() {
        let mut d = Decoder::from_browser();
        let mut got = Vec::new();
        for b in frame(r#"{"k":"hello"}"#) {
            d.push(&[b]);
            got.extend(all(&mut d));
        }
        assert_eq!(got, vec![r#"{"k":"hello"}"#.to_owned()]);
        assert_eq!(d.buffered(), 0);
    }

    #[test]
    fn several_in_one_read_and_one_split_across_reads() {
        let mut bytes = frame("a");
        bytes.extend(frame(&"b".repeat(300)));
        bytes.extend(frame(""));
        let tail = frame("tail");
        bytes.extend(&tail[..6]); // the header and two bytes of the fourth
        let mut d = Decoder::from_browser();
        d.push(&bytes);
        assert_eq!(all(&mut d), vec!["a".to_owned(), "b".repeat(300), String::new()]);
        assert_eq!(d.next_message(), Ok(None));
        assert_eq!(d.buffered(), 6);
        d.push(&tail[6..]);
        assert_eq!(d.next_message(), Ok(Some("tail".into())));
        assert_eq!(d.next_message(), Ok(None));
    }

    #[test]
    fn a_header_split_across_reads() {
        let f = frame("héllo");
        let mut d = Decoder::from_browser();
        d.push(&f[..2]);
        assert_eq!(d.next_message(), Ok(None));
        d.push(&f[2..5]);
        assert_eq!(d.next_message(), Ok(None));
        d.push(&f[5..]);
        assert_eq!(d.next_message(), Ok(Some("héllo".into())));
    }

    #[test]
    fn an_oversized_length_is_refused_at_once() {
        let mut d = Decoder::new(10);
        d.push(&11u32.to_le_bytes());
        assert_eq!(d.next_message(), Err(FrameError::TooBig { len: 11, max: 10 }), "before its bytes come");
        d.push(b"0123456789a");
        assert_eq!(d.next_message(), Err(FrameError::TooBig { len: 11, max: 10 }), "and from then on");
        assert!(d.failed());
        assert_eq!(d.buffered(), 0, "nothing more kept");
        let mut ok = Decoder::new(10);
        ok.push(&frame("0123456789"));
        assert_eq!(ok.next_message(), Ok(Some("0123456789".into())), "at the cap: taken");
    }

    #[test]
    fn the_64_mb_cap_from_the_browser() {
        let mut d = Decoder::from_browser();
        d.push(&u32::MAX.to_le_bytes());
        assert!(matches!(d.next_message(), Err(FrameError::TooBig { .. })));
        let mut d = Decoder::from_browser();
        d.push(&((MAX_FROM_BROWSER + 1) as u32).to_le_bytes());
        assert!(matches!(d.next_message(), Err(FrameError::TooBig { .. })));
        let mut d = Decoder::from_browser();
        d.push(&(MAX_FROM_BROWSER as u32).to_le_bytes());
        assert_eq!(d.next_message(), Ok(None), "at the cap: waited for");
    }

    #[test]
    fn a_frame_that_isnt_utf8_is_passed_over() {
        let mut bytes = 2u32.to_le_bytes().to_vec();
        bytes.extend([0xc3, 0x28]);
        bytes.extend(frame("next"));
        let mut d = Decoder::from_browser();
        d.push(&bytes);
        assert_eq!(d.next_message(), Err(FrameError::NotUtf8));
        assert_eq!(d.next_message(), Ok(Some("next".into())));
        assert!(!d.failed());
    }

    #[test]
    fn a_link_message_through_the_frames() {
        let text = crate::protocol::AppMessage::Tick.encode(1.0).unwrap_or_default();
        let mut d = Decoder::from_browser();
        d.push(&encode_to_browser(&text).unwrap_or_default());
        assert_eq!(d.next_message(), Ok(Some(r#"{"k":"tick","at":1}"#.into())));
    }
}

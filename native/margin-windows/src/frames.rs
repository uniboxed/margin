//! Native messaging's framing (OS-neutral, tested on the Mac): each message is a 4-byte little-endian length
//! followed by that many bytes of UTF-8 JSON. Chrome's stdio uses it, and so does the named pipe between the
//! relay and the app. Small and self-contained on purpose: margin-core's `framing` will replace it.

use std::io::{self, Read, Write};

/// The most Chrome sends a host in one message (Chrome's documented limit: 64 MiB).
pub const FROM_CHROME_MAX: usize = 64 * 1024 * 1024;
/// The most a host may send Chrome in one message: Chrome closes the port on anything bigger (1 MiB).
pub const TO_CHROME_MAX: usize = 1024 * 1024;
/// The most either end of the pipe takes in one message (the app's link takes at most 64 MiB in).
pub const PIPE_MAX: usize = 64 * 1024 * 1024;

/// One frame: the length, then the body.
pub fn encode(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    out
}

/// Writes one frame (in one `write_all`, so a frame is never interleaved with another writer's) and flushes.
pub fn write_frame<W: Write>(w: &mut W, body: &[u8], max: usize) -> io::Result<()> {
    if body.len() > max || body.len() > u32::MAX as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("a frame of {} bytes (at most {max})", body.len()),
        ));
    }
    w.write_all(&encode(body))?;
    w.flush()
}

/// Reads one frame. `Ok(None)`: the stream ended cleanly before a frame began. A stream that ends inside a
/// frame is `UnexpectedEof`; a length over `max` is `InvalidData` (nothing more is read: the stream is lost).
pub fn read_frame<R: Read>(r: &mut R, max: usize) -> io::Result<Option<Vec<u8>>> {
    let mut head = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match r.read(&mut head[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the stream ended inside a frame's length"));
            }
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    let size = u32::from_le_bytes(head) as usize;
    if size > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("a frame of {size} bytes (at most {max})")));
    }
    let mut body = vec![0u8; size];
    r.read_exact(&mut body)?;
    Ok(Some(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trip() {
        let mut out = Vec::new();
        write_frame(&mut out, br#"{"k":"hello"}"#, 100).unwrap();
        write_frame(&mut out, b"", 100).unwrap();
        assert_eq!(&out[..4], &[13, 0, 0, 0]);
        let mut r = Cursor::new(out);
        assert_eq!(read_frame(&mut r, 100).unwrap().unwrap(), br#"{"k":"hello"}"#);
        assert_eq!(read_frame(&mut r, 100).unwrap().unwrap(), b"");
        assert!(read_frame(&mut r, 100).unwrap().is_none());
    }

    #[test]
    fn little_endian_length() {
        assert_eq!(&encode(&[7u8; 0x0102])[..4], &[0x02, 0x01, 0, 0]);
    }

    #[test]
    fn too_big_is_refused_both_ways() {
        assert_eq!(write_frame(&mut Vec::new(), &[0; 11], 10).unwrap_err().kind(), io::ErrorKind::InvalidInput);
        let mut r = Cursor::new(encode(&[0; 11]));
        assert_eq!(read_frame(&mut r, 10).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn a_cut_frame_is_an_error() {
        let mut frame = encode(b"12345");
        frame.truncate(6);
        assert_eq!(read_frame(&mut Cursor::new(frame), 10).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(read_frame(&mut Cursor::new(vec![1, 0]), 10).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    }

    /// A reader that gives one byte at a time, as a pipe may.
    struct Trickle(Cursor<Vec<u8>>);
    impl Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = buf.len().min(1);
            self.0.read(&mut buf[..n])
        }
    }

    #[test]
    fn short_reads_are_put_together() {
        let mut r = Trickle(Cursor::new(encode(b"abcdef")));
        assert_eq!(read_frame(&mut r, 10).unwrap().unwrap(), b"abcdef");
        assert!(read_frame(&mut r, 10).unwrap().is_none());
    }
}

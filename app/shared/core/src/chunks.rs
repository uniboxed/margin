//! Something too big for one link message (a theme package, PLAN.md §14), sent in pieces and put back together
//! (app/macos/shell/Chunks.swift; docs/PROTOCOL.md "Chunks"). The whole is UTF-8 JSON; it's cut into pieces of at most
//! [`CHUNK_BYTES`], each sent as base64 with the whole's size and SHA-256 (`transfer`), so pieces of two sends never
//! mix and a whole that came wrong is never used.

use crate::protocol::{CHUNK_BYTES, Chunk, MAX_PARTS, MAX_THEME_BYTES};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest, Sha256};

/// `Chunks.sha256`: 64 lower-case hex characters.
pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// `Chunks.split`: the pieces of `whole` for `id`, of at most `size` bytes each; `None` if it's bigger than `limit`,
/// `size` is 0, or it would take more than 64 pieces. An empty whole is one empty piece.
pub fn split_with(whole: &[u8], id: &str, size: usize, limit: usize) -> Option<Vec<Chunk>> {
    if whole.len() > limit || size == 0 {
        return None;
    }
    let transfer = sha256_hex(whole);
    let parts = whole.len().div_ceil(size).max(1);
    if parts > MAX_PARTS {
        return None;
    }
    let pieces: Vec<&[u8]> = if whole.is_empty() { vec![whole] } else { whole.chunks(size).collect() };
    Some(
        pieces
            .into_iter()
            .enumerate()
            .map(|(part, piece)| Chunk {
                id: id.to_owned(),
                transfer: transfer.clone(),
                part,
                parts,
                size: whole.len(),
                data: STANDARD.encode(piece),
            })
            .collect(),
    )
}

/// [`split_with`] in pieces of 512 KB, up to 8 MB.
pub fn split(whole: &[u8], id: &str) -> Option<Vec<Chunk>> {
    split_with(whole, id, CHUNK_BYTES, MAX_THEME_BYTES)
}

/// `ChunkAssembler.Outcome`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Waiting {
        have: usize,
        of: usize,
    },
    Complete {
        id: String,
        data: Vec<u8>,
    },
    /// Not taken: the reason (a bad piece, too big, the whole didn't add up).
    Refused(String),
}

/// `ChunkAssembler`: pieces as they come, one whole at a time. A piece of another transfer starts over (the older
/// whole is dropped: something newer is on its way).
#[derive(Clone, Debug)]
pub struct ChunkAssembler {
    limit: usize,
    transfer: Option<String>,
    id: String,
    size: usize,
    parts: Vec<Option<Vec<u8>>>,
}

impl Default for ChunkAssembler {
    fn default() -> Self {
        Self::new(MAX_THEME_BYTES)
    }
}

impl ChunkAssembler {
    pub fn new(limit: usize) -> Self {
        Self { limit, transfer: None, id: String::new(), size: 0, parts: Vec::new() }
    }

    pub fn limit(&self) -> usize {
        self.limit
    }

    pub fn in_progress(&self) -> bool {
        self.transfer.is_some()
    }

    pub fn reset(&mut self) {
        self.transfer = None;
        self.parts.clear();
    }

    pub fn add(&mut self, chunk: &Chunk) -> Outcome {
        if chunk.size > self.limit {
            self.reset();
            return Outcome::Refused(format!("{} bytes is over the limit of {}", chunk.size, self.limit));
        }
        // (Not in the Swift, where a chunk always comes through Chunk(_:), which checks these: a chunk made by
        // hand with them wrong is refused here rather than trusted.)
        if !(1..=MAX_PARTS).contains(&chunk.parts) || chunk.part >= chunk.parts {
            self.reset();
            return Outcome::Refused(format!("part {} of {} isn't a piece", chunk.part, chunk.parts));
        }
        if self.transfer.as_deref() != Some(chunk.transfer.as_str())
            || chunk.parts != self.parts.len()
            || chunk.size != self.size
            || chunk.id != self.id
        {
            self.transfer = Some(chunk.transfer.clone());
            self.id = chunk.id.clone();
            self.size = chunk.size;
            self.parts = vec![None; chunk.parts];
        }
        let Ok(piece) = STANDARD.decode(&chunk.data) else {
            self.reset();
            return Outcome::Refused(format!("part {} isn't base64", chunk.part));
        };
        if let Some(slot) = self.parts.get_mut(chunk.part) {
            *slot = Some(piece);
        }
        let have = self.parts.iter().filter(|p| p.is_some()).count();
        if have < self.parts.len() {
            return Outcome::Waiting { have, of: self.parts.len() };
        }
        let whole: Vec<u8> = self.parts.iter().flatten().flatten().copied().collect();
        let expected = self.transfer.take();
        self.reset();
        if whole.len() != self.size {
            return Outcome::Refused(format!("{} bytes came, {} were said", whole.len(), self.size));
        }
        if expected.as_deref() != Some(sha256_hex(&whole).as_str()) {
            return Outcome::Refused("the pieces don't add up (SHA-256)".into());
        }
        Outcome::Complete { id: chunk.id.clone(), data: whole }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AppMessage, MAX_APP_MESSAGE};

    fn whole() -> Vec<u8> {
        (0..1_300_000u32).map(|i| (i % 251) as u8).collect()
    }

    // ---- tests.swift chunks() ----

    #[test]
    fn split_in_pieces_of_512_kb() {
        let whole = whole();
        let parts = split(&whole, "arcadia").unwrap_or_default();
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|c| c.parts == 3 && c.size == whole.len() && c.transfer == sha256_hex(&whole)));
        assert!(parts.iter().enumerate().all(|(i, c)| c.part == i));
        assert_eq!(STANDARD.decode(&parts[0].data).map(|d| d.len()).ok(), Some(CHUNK_BYTES));
        assert_eq!(STANDARD.decode(&parts[2].data).map(|d| d.len()).ok(), Some(1_300_000 - 2 * CHUNK_BYTES));
        let biggest = parts
            .iter()
            .map(|c| {
                AppMessage::Theme { epoch: "e".into(), chunk: c.clone() }.encode(1.0).map_or(usize::MAX, |t| t.len())
            })
            .max();
        assert!(biggest.is_some_and(|b| b < MAX_APP_MESSAGE), "each piece's message under 1 MB");
    }

    #[test]
    fn sha256_is_lower_case_hex() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(sha256_hex(b"").len(), 64);
    }

    #[test]
    fn whole_again() {
        let whole = whole();
        let parts = split(&whole, "arcadia").unwrap_or_default();
        let mut a = ChunkAssembler::default();
        assert_eq!(a.add(&parts[0]), Outcome::Waiting { have: 1, of: 3 });
        assert!(a.in_progress());
        assert_eq!(a.add(&parts[1]), Outcome::Waiting { have: 2, of: 3 });
        assert_eq!(a.add(&parts[2]), Outcome::Complete { id: "arcadia".into(), data: whole.clone() });
        assert!(!a.in_progress(), "then nothing in progress");
    }

    #[test]
    fn pieces_out_of_order() {
        let whole = whole();
        let parts = split(&whole, "arcadia").unwrap_or_default();
        let mut b = ChunkAssembler::default();
        b.add(&parts[2]);
        b.add(&parts[0]);
        assert_eq!(b.add(&parts[1]), Outcome::Complete { id: "arcadia".into(), data: whole });
    }

    #[test]
    fn the_same_piece_twice_counts_once() {
        let parts = split(&whole(), "arcadia").unwrap_or_default();
        let mut a = ChunkAssembler::default();
        a.add(&parts[0]);
        assert_eq!(a.add(&parts[0]), Outcome::Waiting { have: 1, of: 3 });
    }

    #[test]
    fn a_piece_of_another_send_starts_over() {
        let parts = split(&whole(), "arcadia").unwrap_or_default();
        let mut c = ChunkAssembler::default();
        c.add(&parts[0]);
        let small = br#"{"id":"x"}"#;
        let other = split(small, "x").unwrap_or_default();
        assert_eq!(c.add(&other[0]), Outcome::Complete { id: "x".into(), data: small.to_vec() });
        // And the older send's next piece starts over again, its first piece gone.
        let mut d = ChunkAssembler::default();
        d.add(&parts[0]);
        d.add(&other[0]);
        assert_eq!(d.add(&parts[1]), Outcome::Waiting { have: 1, of: 3 });
    }

    #[test]
    fn pieces_that_dont_add_up_are_refused() {
        let whole = whole();
        let parts = split(&whole, "arcadia").unwrap_or_default();
        let mut d = ChunkAssembler::default();
        let bad = Chunk { data: STANDARD.encode([1u8; 10]), ..parts[1].clone() };
        d.add(&parts[0]);
        d.add(&bad);
        assert!(matches!(d.add(&parts[2]), Outcome::Refused(why) if why.contains("bytes came")));
        // The right size, the wrong bytes: the hash says.
        let mut e = ChunkAssembler::default();
        let mut wrong = STANDARD.decode(&parts[1].data).unwrap_or_default();
        wrong[0] ^= 1;
        e.add(&parts[0]);
        e.add(&Chunk { data: STANDARD.encode(&wrong), ..parts[1].clone() });
        assert_eq!(e.add(&parts[2]), Outcome::Refused("the pieces don't add up (SHA-256)".into()));
        assert!(!e.in_progress());
    }

    #[test]
    fn not_base64_is_refused() {
        let mut e = ChunkAssembler::default();
        let c = Chunk {
            id: "a".into(),
            transfer: sha256_hex(b"abc"),
            part: 0,
            parts: 1,
            size: 3,
            data: "not base64!".into(),
        };
        assert!(matches!(e.add(&c), Outcome::Refused(_)));
        assert!(!e.in_progress());
    }

    #[test]
    fn over_the_limit_is_refused() {
        let parts = split(&whole(), "arcadia").unwrap_or_default();
        let mut f = ChunkAssembler::new(100);
        assert!(matches!(f.add(&parts[0]), Outcome::Refused(why) if why == "1300000 bytes is over the limit of 100"));
        // At the 8 MB cap, taken; over it, refused.
        let mut g = ChunkAssembler::default();
        let at = Chunk {
            id: "a".into(),
            transfer: "0".repeat(64),
            part: 0,
            parts: 64,
            size: MAX_THEME_BYTES,
            data: String::new(),
        };
        assert_eq!(g.add(&at), Outcome::Waiting { have: 1, of: 64 });
        assert!(matches!(g.add(&Chunk { size: MAX_THEME_BYTES + 1, ..at }), Outcome::Refused(_)));
    }

    #[test]
    fn a_piece_made_wrong_by_hand_is_refused() {
        let mut a = ChunkAssembler::default();
        let c = Chunk { id: "a".into(), transfer: "0".repeat(64), part: 3, parts: 3, size: 1, data: String::new() };
        assert!(matches!(a.add(&c), Outcome::Refused(_)));
        assert!(matches!(a.add(&Chunk { part: 0, parts: 0, ..c.clone() }), Outcome::Refused(_)));
        assert!(matches!(a.add(&Chunk { part: 0, parts: 65, ..c }), Outcome::Refused(_)));
    }

    #[test]
    fn split_limits() {
        assert_eq!(split(&vec![0u8; MAX_THEME_BYTES + 1], "a"), None, "too big to split: nothing");
        assert_eq!(split(&vec![0u8; MAX_THEME_BYTES], "a").map(|p| p.len()), Some(16));
        assert_eq!(split_with(b"abc", "a", 0, 10), None, "pieces of no size");
        assert_eq!(split_with(&[0u8; 65], "a", 1, 100), None, "more than 64 pieces");
        assert_eq!(split_with(&[0u8; 64], "a", 1, 100).map(|p| p.len()), Some(64));
        let empty = split(b"", "a").unwrap_or_default();
        assert_eq!(empty.len(), 1, "empty: one piece");
        let mut g = ChunkAssembler::default();
        assert_eq!(g.add(&empty[0]), Outcome::Complete { id: "a".into(), data: Vec::new() }, "an empty whole");
    }

    #[test]
    fn a_piece_through_its_message_and_back() {
        let whole = br#"{"id":"t","manifest":"{}","html":"","css":""}"#;
        let parts = split_with(whole, "t", 7, 1000).unwrap_or_default();
        let mut a = ChunkAssembler::default();
        let mut last = None;
        for c in parts.iter().rev() {
            let text = AppMessage::Theme { epoch: "e".into(), chunk: c.clone() }.encode(1.0).unwrap_or_default();
            let Some(crate::protocol::LinkMessage::Theme { chunk, .. }) = crate::protocol::LinkMessage::decode(&text)
            else {
                panic!("a theme message")
            };
            last = Some(a.add(&chunk));
        }
        assert_eq!(last, Some(Outcome::Complete { id: "t".into(), data: whole.to_vec() }));
    }
}

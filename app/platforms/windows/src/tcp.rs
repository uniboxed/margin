//! The link's listener: the copies' WebSockets come here (docs/PROTOCOL.md, Transport), as to Margin.app's
//! (ExtensionLink.swift `listen`). What's said on them is margin-core's (`socket::SocketLink`, through the shell);
//! this only holds the TCP connections. std::net, so OS-neutral and tested on the Mac with real sockets.
//!
//! - **127.0.0.1 only**, port 0 (any free one; the shell hands the port out in each `link`). Nagle off on each
//!   connection (`set_nodelay`): the small messages go at once.
//! - The listener's thread accepts; each connection has a thread that reads (its bytes to the UI thread through
//!   queue.rs, `Bytes`, then exactly one `Ended`) and one that writes what the shell gives it, in order. Nothing
//!   here ever blocks the UI thread: `write` and `end` only queue.
//! - **Made again when the Mac's would be:** a bind that fails (`no listener: …`) is tried again after 1 s;
//!   accepting that keeps failing for 5 s (the Mac's `waiting`: `listener waiting: …`) makes the listener again on a
//!   new port (`listener still waiting after 5 s: made again`). Each time the port is said again (`None` while
//!   there's none): copies holding the old one are refused and ask again. A connection reset or aborted before it
//!   was accepted is nothing.
//! - `end`: what was queued before it is written, then the connection shut down (a refusal's 403, a close frame);
//!   the peer's end (or 2 s) then ends its read.
//! - Dropped (the app quitting): no more accepted, the queued writes (the `bye`s) given up to 0.3 s, then every
//!   connection shut down.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::queue::UiSender;

pub type ConnId = u64;

/// A listener that can't accept this long is made again on a new port (`SocketLink.Timing.listenWait`).
pub const LISTEN_WAIT: Duration = Duration::from_secs(5);
/// A bind that failed is tried again after this (`retryListen`).
pub const RETRY: Duration = Duration::from_secs(1);
/// The writes still queued when the app quits are given this long (`stop`'s 0.3 s).
pub const DRAIN: Duration = Duration::from_millis(300);
/// After `end`, the peer's end is waited for this long.
const LINGER: Duration = Duration::from_secs(2);
const READ_BUFFER: usize = 64 * 1024;

/// What the listener tells the UI thread.
#[derive(Debug, PartialEq, Eq)]
pub enum TcpEvent {
    /// The port it listens on now, or none (being made again).
    Listening {
        port: Option<u16>,
    },
    /// A connection accepted.
    Opened {
        id: ConnId,
    },
    /// Bytes on it, as they came.
    Bytes {
        id: ConnId,
        bytes: Vec<u8>,
    },
    /// It ended (exactly once per `Opened`): `error`, how it failed if it did.
    Ended {
        id: ConnId,
        error: Option<String>,
    },
    Log {
        warn: bool,
        text: String,
    },
}

enum Out {
    Bytes(Vec<u8>),
    End,
}

struct Conn {
    out: Sender<Out>,
    /// For shutting it down from elsewhere (the writer and reader have their own clones).
    stream: TcpStream,
    ending: Arc<AtomicBool>,
}

struct Shared {
    events: UiSender<TcpEvent>,
    conns: Mutex<HashMap<ConnId, Conn>>,
    stopping: AtomicBool,
    port: Mutex<Option<u16>>,
    next: AtomicU64,
    /// Writer threads still running.
    writers: AtomicUsize,
}

impl Shared {
    fn log(&self, warn: bool, text: String) {
        self.events.send(TcpEvent::Log { warn, text });
    }
    fn set_port(&self, port: Option<u16>) {
        if let Ok(mut p) = self.port.lock() {
            *p = port;
        }
        self.events.send(TcpEvent::Listening { port });
    }
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }
}

/// The listener. Dropping it stops it.
pub struct TcpServer {
    shared: Arc<Shared>,
}

impl TcpServer {
    /// Starts listening (on its own thread: the port comes as `Listening`).
    pub fn start(events: UiSender<TcpEvent>) -> Result<Self, String> {
        let shared = Arc::new(Shared {
            events,
            conns: Mutex::new(HashMap::new()),
            stopping: AtomicBool::new(false),
            port: Mutex::new(None),
            next: AtomicU64::new(1),
            writers: AtomicUsize::new(0),
        });
        let s = shared.clone();
        std::thread::Builder::new()
            .name("margin-link-listener".into())
            .spawn(move || listen_loop(&s))
            .map_err(|e| format!("no thread for the link's listener: {e}"))?;
        Ok(Self { shared })
    }

    /// The port now, if it listens.
    pub fn port(&self) -> Option<u16> {
        self.shared.port.lock().ok().and_then(|p| *p)
    }

    /// Queues bytes for that connection (never blocks). False: no such connection.
    pub fn write(&self, id: ConnId, bytes: Vec<u8>) -> bool {
        let conns = match self.shared.conns.lock() {
            Ok(c) => c,
            Err(_) => return false,
        };
        conns.get(&id).is_some_and(|c| c.out.send(Out::Bytes(bytes)).is_ok())
    }

    /// Closes that connection once what was queued before has been written; its `Ended` follows.
    pub fn end(&self, id: ConnId) {
        if let Ok(conns) = self.shared.conns.lock()
            && let Some(c) = conns.get(&id)
        {
            c.ending.store(true, Ordering::SeqCst);
            let _ = c.out.send(Out::End);
        }
    }
}

impl Drop for TcpServer {
    fn drop(&mut self) {
        let shared = &self.shared;
        shared.stopping.store(true, Ordering::SeqCst);
        // The listener's accept woken (it sees `stopping` and goes).
        if let Some(port) = shared.port.lock().ok().and_then(|p| *p) {
            let _ =
                TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_millis(200));
        }
        // The writers end once their queue is written (their senders dropped here).
        let streams: Vec<TcpStream> = match shared.conns.lock() {
            Ok(mut conns) => conns.drain().map(|(_, c)| c.stream).collect(),
            Err(_) => Vec::new(),
        };
        let until = Instant::now() + DRAIN;
        while shared.writers.load(Ordering::SeqCst) > 0 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        for s in streams {
            let _ = s.shutdown(Shutdown::Both);
        }
    }
}

/// Sleeps `d`, waking early when the server stops. False: it stopped.
fn wait(shared: &Shared, d: Duration) -> bool {
    let until = Instant::now() + d;
    while Instant::now() < until {
        if shared.stopping() {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !shared.stopping()
}

fn listen_loop(shared: &Arc<Shared>) {
    while !shared.stopping() {
        let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) {
            Ok(l) => l,
            Err(e) => {
                shared.log(true, format!("no listener: {e}"));
                if !wait(shared, RETRY) {
                    break;
                }
                continue;
            }
        };
        let port = match listener.local_addr() {
            Ok(a) => a.port(),
            Err(e) => {
                shared.log(true, format!("no listener: its port couldn't be read ({e})"));
                if !wait(shared, RETRY) {
                    break;
                }
                continue;
            }
        };
        shared.set_port(Some(port));
        let mut waiting_since: Option<Instant> = None;
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    if shared.stopping() {
                        return;
                    }
                    waiting_since = None;
                    serve(shared, stream);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        ErrorKind::Interrupted | ErrorKind::ConnectionAborted | ErrorKind::ConnectionReset
                    ) => {}
                Err(e) => {
                    if shared.stopping() {
                        return;
                    }
                    let since = *waiting_since.get_or_insert_with(|| {
                        shared.log(true, format!("listener waiting: {e}"));
                        Instant::now()
                    });
                    if since.elapsed() >= LISTEN_WAIT {
                        shared
                            .log(true, format!("listener still waiting after {} s: made again", LISTEN_WAIT.as_secs()));
                        break;
                    }
                    if !wait(shared, Duration::from_millis(100)) {
                        return;
                    }
                }
            }
        }
        shared.set_port(None);
    }
}

/// One accepted connection: its reader and its writer.
fn serve(shared: &Arc<Shared>, stream: TcpStream) {
    if let Err(e) = stream.set_nodelay(true) {
        shared.log(true, format!("a connection's Nagle couldn't be turned off: {e}"));
    }
    let (Ok(reader), Ok(writer)) = (stream.try_clone(), stream.try_clone()) else {
        shared.log(true, "a connection couldn't be shared between its threads: closed".into());
        let _ = stream.shutdown(Shutdown::Both);
        return;
    };
    let id = shared.next.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel::<Out>();
    let ending = Arc::new(AtomicBool::new(false));
    if let Ok(mut conns) = shared.conns.lock() {
        conns.insert(id, Conn { out: tx, stream, ending: ending.clone() });
    }
    shared.events.send(TcpEvent::Opened { id });

    let failed: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    shared.writers.fetch_add(1, Ordering::SeqCst);
    let s = shared.clone();
    let write_failed = failed.clone();
    let spawned = std::thread::Builder::new().name(format!("margin-link-{id}-out")).spawn(move || {
        let mut writer = writer;
        for out in rx {
            match out {
                Out::Bytes(b) => {
                    if let Err(e) = writer.write_all(&b) {
                        if let Ok(mut f) = write_failed.lock() {
                            f.get_or_insert(e.to_string());
                        }
                        let _ = writer.shutdown(Shutdown::Both);
                        break;
                    }
                }
                Out::End => {
                    let _ = writer.flush();
                    let _ = writer.set_read_timeout(Some(LINGER));
                    let _ = writer.shutdown(Shutdown::Write);
                    break;
                }
            }
        }
        s.writers.fetch_sub(1, Ordering::SeqCst);
    });
    if spawned.is_err() {
        shared.writers.fetch_sub(1, Ordering::SeqCst);
        shared.log(true, "no thread to write a connection with: closed".into());
        let _ = reader.shutdown(Shutdown::Both);
    }

    let s = shared.clone();
    let spawned = std::thread::Builder::new().name(format!("margin-link-{id}-in")).spawn(move || {
        let mut reader = reader;
        let mut buf = vec![0u8; READ_BUFFER];
        let error = loop {
            match reader.read(&mut buf) {
                Ok(0) => break None,
                Ok(n) => {
                    s.events.send(TcpEvent::Bytes { id, bytes: buf[..n].to_vec() });
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                // Ended here and the peer didn't answer within the linger: done.
                Err(e)
                    if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
                        && ending.load(Ordering::SeqCst) =>
                {
                    break None;
                }
                Err(e) => break Some(e.to_string()),
            }
        };
        let _ = reader.shutdown(Shutdown::Both);
        let error = error.or_else(|| failed.lock().ok().and_then(|f| f.clone()));
        if let Ok(mut conns) = s.conns.lock() {
            conns.remove(&id);
        }
        s.events.send(TcpEvent::Ended { id, error });
    });
    if spawned.is_err() {
        shared.log(true, "no thread to read a connection with: closed".into());
        if let Ok(mut conns) = shared.conns.lock()
            && let Some(c) = conns.remove(&id)
        {
            let _ = c.stream.shutdown(Shutdown::Both);
        }
        shared.events.send(TcpEvent::Ended { id, error: Some("no thread to read it".into()) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::{UiReceiver, ui_channel};

    fn server() -> (TcpServer, UiReceiver<TcpEvent>) {
        let (tx, rx) = ui_channel::<TcpEvent>(Arc::new(|| {}));
        (TcpServer::start(tx).expect("started"), rx)
    }

    /// Events until one matches (at most 5 s), all of them.
    fn until(rx: &UiReceiver<TcpEvent>, seen: &mut Vec<TcpEvent>, test: impl Fn(&TcpEvent) -> bool) -> bool {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            let got = rx.drain();
            let hit = got.iter().any(&test);
            seen.extend(got);
            if hit {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    fn port(rx: &UiReceiver<TcpEvent>, seen: &mut Vec<TcpEvent>) -> u16 {
        assert!(until(rx, seen, |e| matches!(e, TcpEvent::Listening { port: Some(_) })), "{seen:?}");
        seen.iter()
            .find_map(|e| if let TcpEvent::Listening { port: Some(p) } = e { Some(*p) } else { None })
            .unwrap_or(0)
    }

    #[test]
    fn listens_on_loopback_and_carries_bytes_both_ways() {
        let (server, rx) = server();
        let mut seen = Vec::new();
        let port = port(&rx, &mut seen);
        assert_eq!(server.port(), Some(port));
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connects");
        assert!(until(&rx, &mut seen, |e| matches!(e, TcpEvent::Opened { .. })));
        let id = seen.iter().find_map(|e| if let TcpEvent::Opened { id } = e { Some(*id) } else { None }).unwrap_or(0);
        client.write_all(b"GET / HTTP/1.1\r\n\r\n").expect("writes");
        let mut got = Vec::new();
        assert!(until(&rx, &mut seen, |e| matches!(e, TcpEvent::Bytes { .. })));
        for e in &seen {
            if let TcpEvent::Bytes { bytes, .. } = e {
                got.extend_from_slice(bytes);
            }
        }
        while got.len() < 18 && until(&rx, &mut seen, |e| matches!(e, TcpEvent::Bytes { .. })) {
            got.clear();
            for e in &seen {
                if let TcpEvent::Bytes { bytes, .. } = e {
                    got.extend_from_slice(bytes);
                }
            }
        }
        assert_eq!(got, b"GET / HTTP/1.1\r\n\r\n");
        assert!(server.write(id, b"hello".to_vec()));
        server.end(id);
        let mut back = Vec::new();
        client.set_read_timeout(Some(Duration::from_secs(5))).ok();
        client.read_to_end(&mut back).expect("read to its end");
        assert_eq!(back, b"hello", "what was queued before the end, then the end");
        drop(client);
        assert!(until(&rx, &mut seen, |e| matches!(e, TcpEvent::Ended { id: i, .. } if *i == id)), "{seen:?}");
        assert!(!server.write(id, b"late".to_vec()), "gone");
    }

    #[test]
    fn a_client_closing_ends_it_once() {
        let (_server, rx) = server();
        let mut seen = Vec::new();
        let port = port(&rx, &mut seen);
        let client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connects");
        assert!(until(&rx, &mut seen, |e| matches!(e, TcpEvent::Opened { .. })));
        drop(client);
        assert!(until(&rx, &mut seen, |e| matches!(e, TcpEvent::Ended { error: None, .. })), "{seen:?}");
        std::thread::sleep(Duration::from_millis(50));
        seen.extend(rx.drain());
        assert_eq!(seen.iter().filter(|e| matches!(e, TcpEvent::Ended { .. })).count(), 1);
    }

    #[test]
    fn dropped_it_stops_listening_and_the_queued_writes_go_first() {
        let (server, rx) = server();
        let mut seen = Vec::new();
        let port = port(&rx, &mut seen);
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connects");
        assert!(until(&rx, &mut seen, |e| matches!(e, TcpEvent::Opened { .. })));
        let id = seen.iter().find_map(|e| if let TcpEvent::Opened { id } = e { Some(*id) } else { None }).unwrap_or(0);
        server.write(id, b"bye".to_vec());
        drop(server);
        let mut back = Vec::new();
        client.set_read_timeout(Some(Duration::from_secs(5))).ok();
        let _ = client.read_to_end(&mut back);
        assert_eq!(back, b"bye");
        let refused = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_millis(100))
                .is_err()
        });
        assert!(refused, "no longer listening");
    }
}

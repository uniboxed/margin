//! The app's named pipe, where Margin's connector (`margin-connector.exe`, app/shared/connector/, started by Chrome
//! or Edge through native messaging) finds the app, and the connector's end of it. Windows only.
//!
//! The pipe is for finding the app only (margin-core `relay`: the connector's JSON lines, its hello, the browser's
//! messages answered, the `link` handed out): the link itself is the copy's WebSocket to 127.0.0.1 (tcp.rs), as on
//! the Mac, whose connector reaches Margin.app over a Unix socket the same way.
//!
//! `\\.\pipe\Margin-<SID>`, one per user (paths.rs): a protected DACL that lets only this user in,
//! `PIPE_REJECT_REMOTE_CLIENTS`, and `FILE_FLAG_FIRST_PIPE_INSTANCE` for the first instance, so the app fails
//! to start its pipe (and says so) if another process already made a pipe of that name. One instance is
//! always kept listening: the next is made before a connected one is handed off.
//!
//! Each side checks the other: the app checks each client is `margin-connector.exe` beside `margin.exe`
//! (`GetNamedPipeClientProcessId` → `QueryFullProcessImageNameW`, as Margin.app checks its connector's signature),
//! the connector checks the server is `margin.exe` beside itself (`connect`, `GetNamedPipeServerProcessId`). The
//! connector opens the pipe with `SECURITY_IDENTIFICATION`, so a server that isn't Margin can't act as this user
//! with the connector's token.
//!
//! I/O is overlapped. A synchronous pipe handle serializes all I/O on it, so a read waiting for the other end
//! would block every write on the same handle; with overlapped handles the reader and the writer threads of a
//! connection run independently. Each wait also watches a stop event, so a connection closes promptly.
//! The bytes go both ways as they are (the connector's JSON lines, split by margin-core). The connections'
//! events reach the UI thread through queue.rs.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use windows::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED,
    HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_SHARE_NONE, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, WriteFile,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    WaitNamedPipeW,
};
use windows::Win32::System::Threading::{CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects};
use windows::core::HSTRING;

use crate::queue::UiSender;
use crate::security::SecurityDescriptor;
use crate::win::{Handle, error_text};

const BUFFER: u32 = 64 * 1024;

fn event() -> io::Result<Handle> {
    // SAFETY: an unnamed manual-reset event, initially clear; owned by the Handle.
    let h = unsafe { CreateEventW(None, true, false, None) }.map_err(io::Error::other)?;
    // SAFETY: CreateEventW gave a handle we own.
    unsafe { Handle::new(h) }.ok_or_else(|| io::Error::other("no event"))
}

fn is(e: &windows::core::Error, code: windows::Win32::Foundation::WIN32_ERROR) -> bool {
    e.code() == code.to_hresult()
}

/// One end of a pipe, opened for overlapped I/O. One thread may read while another writes.
pub struct Pipe {
    handle: Handle,
    /// Set by `stop`: every wait on this pipe returns, its I/O cancelled.
    stop: Handle,
    read_event: Mutex<Handle>,
    write_event: Mutex<Handle>,
}

impl Pipe {
    fn new(handle: Handle) -> io::Result<Self> {
        Ok(Self { handle, stop: event()?, read_event: Mutex::new(event()?), write_event: Mutex::new(event()?) })
    }

    pub fn raw(&self) -> HANDLE {
        self.handle.raw()
    }

    /// Ends every wait on this pipe, now and later: the threads using it see `Interrupted`.
    pub fn stop(&self) {
        // SAFETY: our own event handle.
        let _ = unsafe { SetEvent(self.stop.raw()) };
    }

    /// Runs one overlapped operation to its end: done, failed, timed out or stopped. A pending operation is
    /// always cancelled and waited for before this returns, so `OVERLAPPED` and the buffer outlive it.
    fn run(
        &self,
        event: &Handle,
        timeout_ms: u32,
        start: impl FnOnce(*mut OVERLAPPED) -> windows::core::Result<()>,
    ) -> io::Result<u32> {
        let mut ov = OVERLAPPED { hEvent: event.raw(), ..Default::default() };
        let p: *mut OVERLAPPED = &mut ov;
        match start(p) {
            Ok(()) => {}
            Err(e) if is(&e, ERROR_IO_PENDING) => {}
            Err(e) if is(&e, ERROR_BROKEN_PIPE) || is(&e, ERROR_NO_DATA) => return Ok(0),
            Err(e) => return Err(io::Error::other(error_text(e))),
        }
        // SAFETY: both handles are open for the wait's length.
        let woke = unsafe { WaitForMultipleObjects(&[event.raw(), self.stop.raw()], false, timeout_ms) };
        let mut n = 0u32;
        if woke != WAIT_OBJECT_0 {
            // Stopped or timed out: cancel, then wait for the cancellation to land (it may also have completed).
            // SAFETY: `ov` is the operation started above, still alive; waiting with bWait=TRUE makes sure
            // Windows is done with it and the buffer before they go.
            unsafe {
                let _ = CancelIoEx(self.raw(), Some(p));
                let _ = GetOverlappedResult(self.raw(), p, &mut n, true);
            }
            let kind = if woke == WAIT_TIMEOUT { io::ErrorKind::TimedOut } else { io::ErrorKind::Interrupted };
            return Err(io::Error::new(kind, "the pipe was stopped or timed out"));
        }
        // SAFETY: the operation has completed (its event is set); this only reads its result.
        match unsafe { GetOverlappedResult(self.raw(), p, &mut n, false) } {
            Ok(()) => Ok(n),
            Err(e) if is(&e, ERROR_BROKEN_PIPE) || is(&e, ERROR_NO_DATA) => Ok(0),
            Err(e) => Err(io::Error::other(error_text(e))),
        }
    }

    /// Reads what's there (at least one byte), waiting at most `timeout_ms`. `Ok(0)`: the other end closed.
    pub fn read_some(&self, buf: &mut [u8], timeout_ms: u32) -> io::Result<usize> {
        let event = self.read_event.lock().map_err(|_| io::Error::other("poisoned"))?;
        let len = buf.len().min(u32::MAX as usize);
        let buf = &mut buf[..len];
        // SAFETY: `buf` and the OVERLAPPED stay alive until `run` has seen the operation end.
        self.run(&event, timeout_ms, |ov| unsafe { ReadFile(self.raw(), Some(buf), None, Some(ov)) })
            .map(|n| n as usize)
    }

    /// Writes some of `buf`, waiting at most `timeout_ms`.
    pub fn write_some(&self, buf: &[u8], timeout_ms: u32) -> io::Result<usize> {
        let event = self.write_event.lock().map_err(|_| io::Error::other("poisoned"))?;
        let len = buf.len().min(u32::MAX as usize);
        let buf = &buf[..len];
        // SAFETY: as in read_some.
        let n = self.run(&event, timeout_ms, |ov| unsafe { WriteFile(self.raw(), Some(buf), None, Some(ov)) })?;
        if n == 0 && !buf.is_empty() {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the other end closed"));
        }
        Ok(n as usize)
    }

    /// A `Read` whose every read waits at most `timeout_ms` (INFINITE: until data, a close or `stop`).
    pub fn reader(&self, timeout_ms: u32) -> PipeIo<'_> {
        PipeIo { pipe: self, timeout_ms }
    }

    pub fn writer(&self) -> PipeIo<'_> {
        PipeIo { pipe: self, timeout_ms: INFINITE }
    }

    /// The process at the other end, when this is the server's end.
    pub fn client_pid(&self) -> Option<u32> {
        let mut pid = 0;
        // SAFETY: an out-parameter; the handle is a connected server end.
        unsafe { GetNamedPipeClientProcessId(self.raw(), &mut pid) }.ok().map(|_| pid)
    }

    /// The process at the other end, when this is a client's end.
    pub fn server_pid(&self) -> Option<u32> {
        let mut pid = 0;
        // SAFETY: an out-parameter; the handle is a connected client end.
        unsafe { GetNamedPipeServerProcessId(self.raw(), &mut pid) }.ok().map(|_| pid)
    }
}

pub struct PipeIo<'a> {
    pipe: &'a Pipe,
    timeout_ms: u32,
}

impl Read for PipeIo<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        self.pipe.read_some(buf, self.timeout_ms)
    }
}

impl Write for PipeIo<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.pipe.write_some(buf, self.timeout_ms)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Whether a process is that executable (its image path, compared as paths.rs does).
fn is_margin(pid: u32, expected: &str) -> bool {
    crate::process::image_path(pid).is_some_and(|p| crate::paths::same_file_path(&p, expected))
}

// The connector's side.

pub enum ConnectError {
    /// No pipe of that name: the app isn't running (or hasn't made it yet).
    NotThere,
    /// Every instance is busy (the app is between two connections): try again shortly.
    Busy,
    Other(String),
}

/// Opens the app's pipe and checks its server is `expected_image` (the connector: `margin.exe` beside it).
pub fn connect(name: &str, expected_image: &str) -> Result<Pipe, ConnectError> {
    let wide = HSTRING::from(name);
    // SAFETY: a null-terminated name; no security attributes; the handle it returns is owned by the Handle.
    // SECURITY_IDENTIFICATION: the server may learn who the connector is, never act as it.
    let opened = unsafe {
        CreateFileW(
            &wide,
            0x8000_0000 | 0x4000_0000, // GENERIC_READ | GENERIC_WRITE
            FILE_SHARE_NONE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            None,
        )
    };
    let h = match opened {
        Ok(h) => h,
        Err(e) if is(&e, ERROR_FILE_NOT_FOUND) => return Err(ConnectError::NotThere),
        Err(e) if is(&e, ERROR_PIPE_BUSY) => {
            // SAFETY: a null-terminated name; waits at most 1 s for an instance.
            let _ = unsafe { WaitNamedPipeW(&wide, 1000) };
            return Err(ConnectError::Busy);
        }
        Err(e) => return Err(ConnectError::Other(error_text(e))),
    };
    // SAFETY: CreateFileW gave a handle we own.
    let handle = unsafe { Handle::new(h) }.ok_or(ConnectError::Other("no handle".into()))?;
    let pipe = Pipe::new(handle).map_err(|e| ConnectError::Other(e.to_string()))?;
    match pipe.server_pid() {
        Some(pid) if is_margin(pid, expected_image) => Ok(pipe),
        Some(pid) => Err(ConnectError::Other(format!("the pipe's server (pid {pid}) isn't Margin"))),
        None => Err(ConnectError::Other("the pipe's server is unknown".into())),
    }
}

// The app's side.

pub type ConnId = u64;

/// What the pipe tells the UI thread.
#[derive(Debug)]
pub enum PipeEvent {
    /// Margin's connector connected (its process checked): its own pid.
    Connected { id: ConnId, client_pid: u32 },
    /// Bytes from it, as they came.
    Bytes { id: ConnId, bytes: Vec<u8> },
    /// That connector is gone (or `close` was called).
    Closed { id: ConnId, why: String },
    /// A client that isn't Margin's connector: closed at once (`relay: refused pid N: why`, as the Mac says it).
    Refused { why: String },
    /// The server couldn't make its next instance; it tries again every second.
    Trouble { why: String },
}

struct Conn {
    pipe: Arc<Pipe>,
    out: mpsc::Sender<Vec<u8>>,
}

struct Shared {
    name: String,
    expected: String,
    sd: SecurityDescriptor,
    events: UiSender<PipeEvent>,
    conns: Mutex<HashMap<ConnId, Conn>>,
    listening: Mutex<Option<Arc<Pipe>>>,
    stopping: Handle,
    next: AtomicU64,
}

/// The pipe's server. Dropping it closes every connection.
pub struct PipeServer {
    shared: Arc<Shared>,
    accept: Option<JoinHandle<()>>,
}

fn create_instance(name: &str, sd: &SecurityDescriptor, first: bool) -> Result<Handle, String> {
    let sa = sd.attributes();
    let mut flags = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
    if first {
        flags |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    // SAFETY: a null-terminated name; `sa` points at `sd`'s descriptor, alive for the call.
    let h = unsafe {
        CreateNamedPipeW(
            &HSTRING::from(name),
            flags,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            BUFFER,
            BUFFER,
            0,
            Some(&sa),
        )
    };
    // SAFETY: CreateNamedPipeW gave a handle we own, or an invalid one (refused by Handle::new).
    unsafe { Handle::new(h) }.ok_or_else(|| error_text(windows::core::Error::from_thread()))
}

impl PipeServer {
    /// Starts listening on this user's pipe. An error here means Chrome and Edge can't find the app (another
    /// process holds the pipe's name, or Windows refused): the shell logs it.
    pub fn start(sid: &str, events: UiSender<PipeEvent>) -> Result<Self, String> {
        let name = crate::paths::pipe_name(sid);
        let sd = SecurityDescriptor::from_sddl(&crate::paths::pipe_sddl(sid))?;
        let exe = crate::win::exe_path().ok_or("no path for margin.exe")?;
        let expected = crate::paths::connector_path(&exe).to_string_lossy().into_owned();
        let first = create_instance(&name, &sd, true).map_err(|e| format!("the pipe couldn't be made: {e}"))?;
        let first = Arc::new(Pipe::new(first).map_err(|e| e.to_string())?);
        let stopping = event().map_err(|e| e.to_string())?;
        let shared = Arc::new(Shared {
            name,
            expected,
            sd,
            events,
            conns: Mutex::new(HashMap::new()),
            listening: Mutex::new(None),
            stopping,
            next: AtomicU64::new(1),
        });
        let s = shared.clone();
        let accept = std::thread::Builder::new()
            .name("margin-pipe".into())
            .spawn(move || accept_loop(s, first))
            .map_err(|e| e.to_string())?;
        Ok(Self { shared, accept: Some(accept) })
    }

    /// Queues bytes for that connector (never blocks). False: no such connection.
    pub fn send(&self, id: ConnId, body: Vec<u8>) -> bool {
        let conns = match self.shared.conns.lock() {
            Ok(c) => c,
            Err(_) => return false,
        };
        conns.get(&id).is_some_and(|c| c.out.send(body).is_ok())
    }

    /// Closes that connection: its `Closed` follows.
    pub fn close(&self, id: ConnId) {
        let conn = self.shared.conns.lock().ok().and_then(|mut c| c.remove(&id));
        if let Some(c) = conn {
            c.pipe.stop();
        }
    }

    pub fn connections(&self) -> Vec<ConnId> {
        self.shared.conns.lock().map(|c| c.keys().copied().collect()).unwrap_or_default()
    }
}

impl Drop for PipeServer {
    fn drop(&mut self) {
        // SAFETY: our own event handle.
        let _ = unsafe { SetEvent(self.shared.stopping.raw()) };
        if let Some(p) = self.shared.listening.lock().ok().and_then(|l| l.clone()) {
            p.stop();
        }
        if let Ok(mut conns) = self.shared.conns.lock() {
            for (_, c) in conns.drain() {
                c.pipe.stop();
            }
        }
        if let Some(t) = self.accept.take() {
            let _ = t.join();
        }
    }
}

fn stopping(shared: &Shared) -> bool {
    use windows::Win32::System::Threading::WaitForSingleObject;
    // SAFETY: our own event handle; a zero-timeout poll.
    unsafe { WaitForSingleObject(shared.stopping.raw(), 0) == WAIT_OBJECT_0 }
}

fn accept_loop(shared: Arc<Shared>, first: Arc<Pipe>) {
    let mut current = Some(first);
    while !stopping(&shared) {
        let pipe = match current.take() {
            Some(p) => p,
            None => match create_instance(&shared.name, &shared.sd, false)
                .and_then(|h| Pipe::new(h).map_err(|e| e.to_string()))
            {
                Ok(p) => Arc::new(p),
                Err(why) => {
                    shared.events.send(PipeEvent::Trouble { why: format!("no pipe instance to listen on: {why}") });
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    continue;
                }
            },
        };
        if let Ok(mut l) = shared.listening.lock() {
            *l = Some(pipe.clone());
        }
        if stopping(&shared) {
            break;
        }
        let event = match pipe.read_event.lock() {
            Ok(e) => e,
            Err(_) => break,
        };
        // SAFETY: the OVERLAPPED stays alive until `run` has seen the operation end.
        let connected = pipe.run(&event, INFINITE, |ov| match unsafe { ConnectNamedPipe(pipe.raw(), Some(ov)) } {
            Err(e) if is(&e, ERROR_PIPE_CONNECTED) => Ok(()),
            other => other,
        });
        drop(event);
        match connected {
            Ok(_) => {
                // The next instance first, so the pipe's name is never without one of ours (a squatter could
                // take a free name), even if this connection's thread closes its own at once.
                match create_instance(&shared.name, &shared.sd, false)
                    .and_then(|h| Pipe::new(h).map_err(|e| e.to_string()))
                {
                    Ok(next) => current = Some(Arc::new(next)),
                    Err(why) => {
                        shared.events.send(PipeEvent::Trouble { why: format!("no next pipe instance: {why}") });
                    }
                }
                let id = shared.next.fetch_add(1, Ordering::Relaxed);
                let s = shared.clone();
                let p = pipe.clone();
                let spawned =
                    std::thread::Builder::new().name(format!("margin-pipe-{id}")).spawn(move || serve(s, id, p));
                if spawned.is_err() {
                    shared.events.send(PipeEvent::Trouble { why: "no thread for a connection".into() });
                    pipe.stop();
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => break,
            Err(e) => {
                shared.events.send(PipeEvent::Trouble { why: format!("waiting for a connector: {e}") });
                // The same instance listens again (a new one would leave the name free for a moment).
                // SAFETY: a server end of ours; disconnecting one that isn't connected fails harmlessly.
                let _ = unsafe { DisconnectNamedPipe(pipe.raw()) };
                current = Some(pipe);
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }
    }
    if let Ok(mut l) = shared.listening.lock() {
        *l = None;
    }
}

fn serve(shared: Arc<Shared>, id: ConnId, pipe: Arc<Pipe>) {
    let refuse = |why: String| {
        shared.events.send(PipeEvent::Refused { why });
        // SAFETY: a connected server end of ours.
        let _ = unsafe { DisconnectNamedPipe(pipe.raw()) };
        pipe.stop();
    };
    let Some(client_pid) = pipe.client_pid() else {
        return refuse("relay: a connection whose process couldn't be told: closed".into());
    };
    if !is_margin(client_pid, &shared.expected) {
        return refuse(format!("relay: refused pid {client_pid}: not Margin's connector"));
    }
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    match shared.conns.lock() {
        Ok(mut c) => {
            c.insert(id, Conn { pipe: pipe.clone(), out: tx });
        }
        Err(_) => return refuse("relay: the server is stopping".into()),
    }
    shared.events.send(PipeEvent::Connected { id, client_pid });
    let writer_pipe = pipe.clone();
    let writer = std::thread::Builder::new().name(format!("margin-pipe-{id}-out")).spawn(move || {
        for body in rx {
            if writer_pipe.writer().write_all(&body).is_err() {
                writer_pipe.stop();
                break;
            }
        }
    });
    let why = if writer.is_err() {
        "no thread to write with".to_string()
    } else {
        let mut buf = vec![0u8; BUFFER as usize];
        loop {
            match pipe.read_some(&mut buf, INFINITE) {
                Ok(0) => break "the connector closed the pipe".to_string(),
                Ok(n) => {
                    shared.events.send(PipeEvent::Bytes { id, bytes: buf[..n].to_vec() });
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => break "closed".to_string(),
                Err(e) => break format!("the pipe broke: {e}"),
            }
        }
    };
    if let Ok(mut c) = shared.conns.lock() {
        c.remove(&id);
    }
    pipe.stop();
    shared.events.send(PipeEvent::Closed { id, why });
}

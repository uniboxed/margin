//! The session's executor (docs/CORE-REFACTOR.md step 3, "What every part shares"): the Swift flows' awaits as Rust
//! `async fn`s, run in the order Swift's main actor ran them, with no runtime, no thread and no timer.
//!
//! - **One serial queue** for what HostedSession enqueued (`enqueue`/`idle`): a task's turn comes when the one before
//!   it is over, and it's then polled after what was ready already (as `Task { await previous?.value; … }` resumed).
//!   **Detached tasks** for Swift's `Task {}`s. Ready tasks run first in, first out; a task spawned is first polled
//!   after the one that spawned it suspends (a main-actor `Task` starts after the code that made it).
//! - **Suspension points** are the Swift's awaits: a command (an engine operation, a copy's request, a library edit,
//!   a Swift job's turn) and a sleep. A task that starts a command ends the run: the call's answer hands the command
//!   out (`start`), the caller starts it at once and says so (`release`, the next tick), and nothing else runs in
//!   between, so its synchronous prefix runs where Swift's `await` ran it. A command answered "in the same turn" (a
//!   library edit, which Swift made synchronously) resumes its task before anything that became ready meanwhile.
//! - **Sleeps are deadlines**: the earliest one goes out with every answer, the caller keeps one timer and ticks.
//!   Time is the caller's clock, never read here; a tick's `due` moves the executor's time forward, and a sleep counts
//!   from the later of the clock and that time (a test's frozen clock still sleeps in order, as real time would).
//! - **Re-entrance**: polling never holds a borrow of the executor's state (the task is taken out first), so a port
//!   call that re-enters the session only changes state and queues tasks: the outer run polls them.
//!
//! The wakers are `Waker::noop`: a task is made ready by what it waits on (its command's answer, its deadline), never
//! by a waker, and a spurious poll of a task finds its leaves still pending.

use std::cell::{Cell, RefCell};
use std::cmp::Ordering;
use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

use serde_json::Value;

use super::Command;

type Task = Pin<Box<dyn Future<Output = ()>>>;

pub(crate) type TaskId = u64;

struct Slot {
    /// None while it's being polled.
    fut: Option<Task>,
    /// In the ready queue now.
    ready: bool,
}

/// A command waited for: its task, and its answer once it came (with the order it came in).
struct Wait {
    task: TaskId,
    answer: Option<(u64, Value)>,
    same_turn: bool,
}

/// A deadline's time, ordered as f64's total order (the keys of the sleeps' map).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Time(pub(crate) f64);
impl Eq for Time {}
impl PartialOrd for Time {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Time {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}

#[derive(Default)]
pub(crate) struct Exec {
    tasks: RefCell<BTreeMap<TaskId, Slot>>,
    ready: RefCell<VecDeque<TaskId>>,
    /// The serial queue's tasks waiting for their turn, and the one whose turn it is.
    queue: RefCell<VecDeque<TaskId>>,
    in_turn: Cell<Option<TaskId>>,
    current: Cell<Option<TaskId>>,
    polling: Cell<bool>,
    /// Commands handed out, not started yet: nothing runs until the caller says they are (`release`).
    held: Cell<bool>,
    next_task: Cell<u64>,
    /// Commands' and sleeps' ids (one counter: a command's id is what the caller answers).
    next_id: Cell<u64>,
    /// The order things happened in (an answer, a deadline): `first_of`'s rule.
    next_stamp: Cell<u64>,
    started: RefCell<Vec<(u64, Command)>>,
    waits: RefCell<BTreeMap<u64, Wait>>,
    sleeps: RefCell<BTreeMap<(Time, u64), TaskId>>,
    fired: RefCell<BTreeMap<u64, u64>>,
    /// The latest tick's `due`.
    time: Cell<f64>,
}

impl Exec {
    fn id(&self) -> u64 {
        let id = self.next_id.get() + 1;
        self.next_id.set(id);
        id
    }

    fn stamp(&self) -> u64 {
        let s = self.next_stamp.get() + 1;
        self.next_stamp.set(s);
        s
    }

    fn add(&self, fut: Task) -> TaskId {
        let id = self.next_task.get() + 1;
        self.next_task.set(id);
        self.tasks.borrow_mut().insert(id, Slot { fut: Some(fut), ready: false });
        id
    }

    fn wake(&self, id: TaskId, front: bool) {
        let fresh = match self.tasks.borrow_mut().get_mut(&id) {
            Some(slot) => !std::mem::replace(&mut slot.ready, true),
            None => return,
        };
        let mut ready = self.ready.borrow_mut();
        if front {
            ready.retain(|t| *t != id);
            ready.push_front(id);
        } else if fresh {
            ready.push_back(id);
        }
    }

    /// A detached task (Swift's `Task {}`): polled after what's ready now, the task that spawned it first.
    #[allow(dead_code)] // (the first flows with detached tasks come with parts 4 and 6)
    pub(crate) fn spawn(&self, fut: impl Future<Output = ()> + 'static) {
        let id = self.add(Box::pin(fut));
        self.wake(id, false);
    }

    /// A flow Swift called and awaits (an engine's ask, a Swift flow's call): polled before what's ready, as the
    /// Swift call ran its first part at once.
    pub(crate) fn spawn_now(&self, fut: impl Future<Output = ()> + 'static) {
        let id = self.add(Box::pin(fut));
        self.wake(id, true);
    }

    /// A task of the serial queue (HostedSession's `enqueue`): its turn after every one enqueued before it.
    pub(crate) fn enqueue(&self, fut: impl Future<Output = ()> + 'static) {
        let id = self.add(Box::pin(fut));
        if self.in_turn.get().is_none() {
            self.in_turn.set(Some(id));
            self.wake(id, false);
        } else {
            self.queue.borrow_mut().push_back(id);
        }
    }

    fn next_turn(&self) {
        let next = self.queue.borrow_mut().pop_front();
        self.in_turn.set(next);
        if let Some(id) = next {
            self.wake(id, false);
        }
    }

    /// Tasks ready to run, and nothing handed out waits to be started.
    pub(crate) fn has_ready(&self) -> bool {
        !self.held.get() && !self.ready.borrow().is_empty()
    }

    /// Nothing enqueued is left to do (HostedSession's `idle`: detached tasks aren't waited for).
    pub(crate) fn idle(&self) -> bool {
        self.in_turn.get().is_none()
    }

    /// Polls what's ready, in order, until nothing is or a task started a command. Nothing while a poll is under way
    /// (a re-entrant call: the outer run goes on) or while commands handed out aren't started yet.
    pub(crate) fn run(&self) {
        if self.polling.get() || self.held.get() {
            return;
        }
        self.polling.set(true);
        while self.started.borrow().is_empty() {
            let Some(id) = self.ready.borrow_mut().pop_front() else { break };
            let fut = match self.tasks.borrow_mut().get_mut(&id) {
                Some(slot) => {
                    slot.ready = false;
                    slot.fut.take()
                }
                None => None,
            };
            let Some(mut fut) = fut else { continue };
            let outer = self.current.replace(Some(id));
            let done = fut.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_ready();
            self.current.set(outer);
            if done {
                self.tasks.borrow_mut().remove(&id);
                drop(fut);
                if self.in_turn.get() == Some(id) {
                    self.next_turn();
                }
            } else if let Some(slot) = self.tasks.borrow_mut().get_mut(&id) {
                slot.fut = Some(fut);
            }
        }
        self.polling.set(false);
        if !self.started.borrow().is_empty() {
            self.held.set(true);
        }
    }

    /// The commands the last run handed out, in order (each one's id and what it is).
    pub(crate) fn take_started(&self) -> Vec<(u64, Command)> {
        std::mem::take(&mut *self.started.borrow_mut())
    }

    /// The commands handed out are started: the run may go on.
    pub(crate) fn release(&self) {
        self.held.set(false);
    }

    /// A command's answer. False: no task waits for it (given up, as a lost race's: its answer is let go).
    pub(crate) fn answer(&self, id: u64, answer: Value) -> bool {
        let stamp = self.stamp();
        let woke = match self.waits.borrow_mut().get_mut(&id) {
            Some(w) if w.answer.is_none() => {
                w.answer = Some((stamp, answer));
                Some((w.task, w.same_turn))
            }
            _ => None,
        };
        match woke {
            Some((task, front)) => {
                self.wake(task, front);
                true
            }
            None => false,
        }
    }

    /// The deadlines up to `due` are over (in their order, then the order they were made in).
    pub(crate) fn tick(&self, due: f64) {
        if due.is_finite() && due > self.time.get() {
            self.time.set(due);
        }
        let now = Time(self.time.get());
        loop {
            let first = self.sleeps.borrow().first_key_value().map(|(k, t)| (*k, *t));
            let Some(((at, key), task)) = first else { break };
            if at > now {
                break;
            }
            self.sleeps.borrow_mut().remove(&(at, key));
            let stamp = self.stamp();
            self.fired.borrow_mut().insert(key, stamp);
            self.wake(task, false);
        }
    }

    /// The earliest deadline.
    pub(crate) fn deadline(&self) -> Option<f64> {
        self.sleeps.borrow().first_key_value().map(|((at, _), _)| at.0)
    }

    /// Every task let go (the session's end: the futures hold the session, the session holds them).
    pub(crate) fn clear(&self) {
        let tasks = std::mem::take(&mut *self.tasks.borrow_mut());
        drop(tasks);
        self.ready.borrow_mut().clear();
        self.queue.borrow_mut().clear();
        self.in_turn.set(None);
    }

    /// A command, waited for: `same_turn` for one the caller answers before anything else runs (a library edit).
    pub(crate) fn command(&self, command: Command, same_turn: bool) -> Answer<'_> {
        Answer { exec: self, command: Some(command), id: None, same_turn, done: false }
    }

    /// A sleep of `seconds` from the later of `now` (the caller's clock) and the executor's time.
    pub(crate) fn sleep(&self, now: f64, seconds: f64) -> Sleep<'_> {
        let from = if now.is_finite() { now.max(self.time.get()) } else { self.time.get() };
        Sleep { exec: self, at: Time(from + seconds), key: None, done: false }
    }
}

/// A leaf the executor wakes, and when what it waited for happened (`first_of`).
#[allow(dead_code)] // (the first races come with parts 4 and 5: a picture against its time)
pub(crate) trait Event: Future + Unpin {
    fn happened(&self) -> Option<u64>;
}

/// A command's answer, waited for.
pub(crate) struct Answer<'a> {
    exec: &'a Exec,
    command: Option<Command>,
    id: Option<u64>,
    same_turn: bool,
    done: bool,
}

impl Future for Answer<'_> {
    type Output = Value;
    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Value> {
        let this = self.get_mut();
        let exec = this.exec;
        let Some(id) = this.id else {
            let id = exec.id();
            this.id = Some(id);
            let task = exec.current.get().unwrap_or(0);
            exec.waits.borrow_mut().insert(id, Wait { task, answer: None, same_turn: this.same_turn });
            if let Some(c) = this.command.take() {
                exec.started.borrow_mut().push((id, c));
            }
            return Poll::Pending;
        };
        let answered = {
            let mut waits = exec.waits.borrow_mut();
            match waits.get(&id) {
                Some(w) if w.answer.is_some() => waits.remove(&id).and_then(|w| w.answer),
                _ => None,
            }
        };
        match answered {
            Some((_, v)) => {
                this.done = true;
                Poll::Ready(v)
            }
            None => Poll::Pending,
        }
    }
}

impl Event for Answer<'_> {
    fn happened(&self) -> Option<u64> {
        let id = self.id?;
        self.exec.waits.borrow().get(&id).and_then(|w| w.answer.as_ref().map(|(s, _)| *s))
    }
}

impl Drop for Answer<'_> {
    fn drop(&mut self) {
        if let (Some(id), false) = (self.id, self.done) {
            self.exec.waits.borrow_mut().remove(&id);
        }
    }
}

/// A sleep, until its deadline is ticked.
pub(crate) struct Sleep<'a> {
    exec: &'a Exec,
    at: Time,
    key: Option<u64>,
    done: bool,
}

impl Future for Sleep<'_> {
    type Output = ();
    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        let exec = this.exec;
        let Some(key) = this.key else {
            let key = exec.id();
            this.key = Some(key);
            let task = exec.current.get().unwrap_or(0);
            exec.sleeps.borrow_mut().insert((this.at, key), task);
            return Poll::Pending;
        };
        if exec.fired.borrow_mut().remove(&key).is_some() {
            this.done = true;
            return Poll::Ready(());
        }
        Poll::Pending
    }
}

impl Event for Sleep<'_> {
    fn happened(&self) -> Option<u64> {
        self.exec.fired.borrow().get(&self.key?).copied()
    }
}

impl Drop for Sleep<'_> {
    fn drop(&mut self) {
        if let (Some(key), false) = (self.key, self.done) {
            self.exec.sleeps.borrow_mut().remove(&(self.at, key));
            self.exec.fired.borrow_mut().remove(&key);
        }
    }
}

/// Which of two came first.
#[allow(dead_code)]
#[derive(Debug, PartialEq)]
pub(crate) enum Either<A, B> {
    A(A),
    B(B),
}

/// The first of two answers, given once (HostedSession's `FirstOf`: a request raced against its time limit). The
/// other is let go: a command's later answer is ignored, a sleep's deadline dropped. When both came before the task
/// was polled, the one that came first.
#[allow(dead_code)]
pub(crate) fn first_of<A: Event, B: Event>(a: A, b: B) -> FirstOf<A, B> {
    FirstOf { a: Some(a), b: Some(b) }
}

#[allow(dead_code)]
pub(crate) struct FirstOf<A, B> {
    a: Option<A>,
    b: Option<B>,
}

impl<A: Event, B: Event> Future for FirstOf<A, B> {
    type Output = Either<A::Output, B::Output>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let (Some(a), Some(b)) = (this.a.as_mut(), this.b.as_mut()) else { return Poll::Pending };
        let b_first = match (a.happened(), b.happened()) {
            (Some(x), Some(y)) => y < x,
            (None, Some(_)) => true,
            _ => false,
        };
        let out = if b_first {
            match Pin::new(b).poll(cx) {
                Poll::Ready(v) => Some(Either::B(v)),
                Poll::Pending => None,
            }
        } else {
            match Pin::new(&mut *a).poll(cx) {
                Poll::Ready(v) => Some(Either::A(v)),
                Poll::Pending => match Pin::new(b).poll(cx) {
                    Poll::Ready(v) => Some(Either::B(v)),
                    Poll::Pending => None,
                },
            }
        };
        match out {
            Some(v) => {
                this.a = None;
                this.b = None;
                Poll::Ready(v)
            }
            None => Poll::Pending,
        }
    }
}

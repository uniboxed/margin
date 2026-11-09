//! Handing work from other threads to the UI thread (OS-neutral, tested on the Mac). A thread `send`s into a
//! channel and wakes the UI thread (on Windows, a `PostMessageW` to Margin's message window: msgwin.rs
//! `waker`); the UI thread `drain`s the channel when it's woken. Wakes are coalesced: one posted message
//! stands for every item sent until the UI thread drains, so a busy pipe can't flood the message queue.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};

/// What wakes the UI thread. Called from any thread.
pub type Wake = Arc<dyn Fn() + Send + Sync>;

pub struct UiSender<T> {
    tx: Sender<T>,
    pending: Arc<AtomicBool>,
    wake: Wake,
}

impl<T> Clone for UiSender<T> {
    fn clone(&self) -> Self {
        Self { tx: self.tx.clone(), pending: self.pending.clone(), wake: self.wake.clone() }
    }
}

impl<T> UiSender<T> {
    /// Queues `item` and wakes the UI thread unless a wake is already on its way. False: the UI side is gone.
    pub fn send(&self, item: T) -> bool {
        if self.tx.send(item).is_err() {
            return false;
        }
        if !self.pending.swap(true, Ordering::AcqRel) {
            (self.wake)();
        }
        true
    }
}

pub struct UiReceiver<T> {
    rx: Receiver<T>,
    pending: Arc<AtomicBool>,
}

impl<T> UiReceiver<T> {
    /// Everything sent so far. Call it when woken; what's sent while it runs wakes the UI thread again.
    pub fn drain(&self) -> Vec<T> {
        self.pending.store(false, Ordering::Release);
        self.rx.try_iter().collect()
    }
}

pub fn ui_channel<T>(wake: Wake) -> (UiSender<T>, UiReceiver<T>) {
    let (tx, rx) = mpsc::channel();
    let pending = Arc::new(AtomicBool::new(false));
    (UiSender { tx, pending: pending.clone(), wake }, UiReceiver { rx, pending })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn wakes_once_until_drained() {
        let wakes = Arc::new(AtomicUsize::new(0));
        let w = wakes.clone();
        let (tx, rx) = ui_channel::<u32>(Arc::new(move || {
            w.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(tx.send(1));
        assert!(tx.send(2));
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
        assert_eq!(rx.drain(), vec![1, 2]);
        tx.clone().send(3);
        assert_eq!(wakes.load(Ordering::SeqCst), 2);
        assert_eq!(rx.drain(), vec![3]);
        assert!(rx.drain().is_empty());
    }

    #[test]
    fn from_other_threads() {
        let (tx, rx) = ui_channel::<u32>(Arc::new(|| {}));
        let handles: Vec<_> = (0..4)
            .map(|i| {
                let tx = tx.clone();
                std::thread::spawn(move || {
                    for j in 0..100 {
                        tx.send(i * 100 + j);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(rx.drain().len(), 400);
    }

    #[test]
    fn a_gone_receiver_says_so() {
        let (tx, rx) = ui_channel::<u32>(Arc::new(|| {}));
        drop(rx);
        assert!(!tx.send(1));
    }
}

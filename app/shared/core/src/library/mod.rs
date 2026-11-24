//! The library's edit rules (docs/CORE-REFACTOR.md step 4): app/shared/library/library.ts over extension/state/model.ts,
//! transliterated function by function. The store itself is data/library.rs (`LibraryStore`).
//!
//! - [`js`]: the JavaScript semantics the rules rely on.
//! - [`state`]: the typed state (`stateOf`), its records and targets.
//! - [`values`]: the state back to stored values (`valuesOf`) and the changes between two (`diff`).
//! - [`snapshot`]: what the UI draws, as its text.
//! - [`model`]: model.ts's rules on the typed state.
//! - [`actions`]: the 57 actions and `perform` over them.
//! - [`import`]: each profile's set into the library once.
//! - [`object`]: the library object ([`Library`]): the store, the state kept per revision, perform, the import once,
//!   the host's env and observers, the session as the requests' sink; and library.js's entry ([`object::call`]).

pub mod actions;
pub mod import;
pub mod js;
pub mod model;
pub mod object;
pub mod snapshot;
pub mod state;
pub mod values;

pub use object::{Library, LibraryHost, Performed, RequestSink};
// The shared vectors (tests/fixtures/library/), for every part's tests and the platforms' (margin-ffi's, with the
// system's sorter: the `vectors` feature, a dev-dependency's only).
#[cfg(any(test, feature = "vectors"))]
pub mod vectors;

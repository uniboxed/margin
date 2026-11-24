//! The library's edit rules (docs/CORE-REFACTOR.md step 4): app/shared/library/library.ts over extension/state/model.ts,
//! transliterated function by function. The store itself is data/library.rs (`LibraryStore`).
//!
//! - [`js`]: the JavaScript semantics the rules rely on.
//! - [`state`]: the typed state (`stateOf`), its records and targets.
//! - [`values`]: the state back to stored values (`valuesOf`) and the changes between two (`diff`).
//! - [`snapshot`]: what the UI draws, as its text.
//! - [`model`]: model.ts's rules on the typed state.
//! - [`import`]: each profile's set into the library once.

pub mod import;
pub mod js;
pub mod model;
pub mod snapshot;
pub mod state;
pub mod values;
// The shared vectors (tests/fixtures/library/), for every part's tests.
#[cfg(test)]
pub mod vectors;

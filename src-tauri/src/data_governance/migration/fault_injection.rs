//! # Migration fault-injection failpoints (测试专用)
//!
//! Deterministic, test-only failpoint registry used by the migration
//! coordinator fault-injection tests.
//!
//! ## Safety boundary (production builds)
//!
//! This module is compiled **exclusively under `cfg(test)`** — see the module
//! declaration in `coordinator.rs`. In production builds:
//!
//! - this file is not compiled at all;
//! - the corresponding `MigrationCoordinator::failpoint` hook is an
//!   `#[inline(always)]` no-op stub;
//! - there is **no activation path whatsoever** (no environment variables, no
//!   config keys, no feature flags enabled by default).
//!
//! ## Design
//!
//! - Failpoints are keyed by `(scope, point)` where `scope` is the canonical
//!   app data directory. Tests run in parallel inside one process, so scoping
//!   by data dir keeps independent `TempDir`-based tests isolated.
//! - Arming returns a [`FailpointGuard`] that disarms on drop, so a panicking
//!   test cannot leak an armed failpoint into other tests.
//! - Firing is a **deterministic error injection**
//!   (`MigrationError::Database`), never `process::abort`/SIGKILL, so the test
//!   runner is never harmed. Hard-kill (SIGKILL) semantics would require a
//!   dedicated child-process harness and are intentionally out of scope here;
//!   the boundary this registry covers is "the coordinator observes an error
//!   at a precise pipeline stage".

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::data_governance::migration::MigrationError;

#[derive(Debug, Default)]
struct FailpointState {
    /// How many more times this failpoint should fire before becoming inert.
    remaining: u32,
    /// Total number of times this failpoint actually fired.
    hits: u32,
}

static REGISTRY: OnceLock<Mutex<HashMap<String, FailpointState>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, FailpointState>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Canonical scope key for an app data directory.
///
/// Must match the canonicalization used when arming and when firing, so tests
/// using macOS `/var` -> `/private/var` symlinked temp dirs behave.
pub(super) fn scope_key(app_data_dir: &Path) -> String {
    std::fs::canonicalize(app_data_dir)
        .unwrap_or_else(|_| app_data_dir.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn full_key(scope: &str, point: &str) -> String {
    format!("{scope}::{point}")
}

/// RAII guard for an armed failpoint. Disarms on drop.
pub(super) struct FailpointGuard {
    key: String,
}

impl FailpointGuard {
    /// Number of times the failpoint fired so far.
    pub(super) fn hits(&self) -> u32 {
        registry()
            .lock()
            .expect("failpoint registry poisoned")
            .get(&self.key)
            .map(|s| s.hits)
            .unwrap_or(0)
    }
}

impl Drop for FailpointGuard {
    fn drop(&mut self) {
        registry()
            .lock()
            .expect("failpoint registry poisoned")
            .remove(&self.key);
    }
}

/// Arm `point` for the coordinator operating on `app_data_dir`.
///
/// The failpoint fires (returns an injected error) for the next `times`
/// traversals of the hook, then becomes inert until re-armed.
pub(super) fn arm(app_data_dir: &Path, point: &str, times: u32) -> FailpointGuard {
    let key = full_key(&scope_key(app_data_dir), point);
    registry()
        .lock()
        .expect("failpoint registry poisoned")
        .insert(
            key.clone(),
            FailpointState {
                remaining: times,
                hits: 0,
            },
        );
    FailpointGuard { key }
}

/// Hook entry point called by `MigrationCoordinator::failpoint`.
///
/// Returns `Err` with a deterministic, recognizable message when armed.
pub(super) fn fire(scope: &str, point: &str) -> Result<(), MigrationError> {
    let key = full_key(scope, point);
    let mut map = registry().lock().expect("failpoint registry poisoned");
    if let Some(state) = map.get_mut(&key) {
        if state.remaining > 0 {
            state.remaining -= 1;
            state.hits += 1;
            return Err(MigrationError::Database(format!(
                "[failpoint] injected deterministic failure at '{point}'"
            )));
        }
    }
    Ok(())
}

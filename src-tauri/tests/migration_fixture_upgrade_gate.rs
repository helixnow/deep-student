//! Migration fixture upgrade gate (CI-installed integration test).
//!
//! This file is a template that lives in `scripts/migration-ci/`. CI copies it
//! to `src-tauri/tests/migration_fixture_upgrade_gate.rs` at runtime (see
//! `scripts/migration-ci/run-fixture-upgrades.sh`) so that cargo's test
//! autodiscovery picks it up. It is intentionally NOT committed under
//! `src-tauri/tests/` to keep the repository's Rust surface unchanged.
//!
//! It drives the *production* migration entrypoint
//! (`data_governance::migration::MigrationCoordinator::run_all`) against real
//! historical app-data fixture directories, in one of three modes:
//!
//! - `upgrade`: every fixture must migrate to the latest schema versions.
//! - `fault`:   fixture databases are corrupted first; the coordinator must
//!              surface a failure (no silent success on corrupted data).
//! - `scale`:   same as `upgrade` plus a per-case wall-clock budget
//!              (`MIGRATION_GATE_MAX_SECONDS`, default 300).
//!
//! Environment contract:
//! - `MIGRATION_FIXTURE_ROOT` (required): directory whose immediate
//!   subdirectories are fixture cases (each an app-data dir layout:
//!   `databases/vfs.db`, `chat_v2.db`, `mistakes.db`, `llm_usage.db`).
//! - `MIGRATION_GATE_MODE` (optional): `upgrade` (default) | `fault` | `scale`.
//! - `MIGRATION_GATE_REPORT` (optional): path to write a machine-readable
//!   JSON-lines report (one object per case).
//! - `MIGRATION_GATE_MAX_SECONDS` (optional): scale-mode per-case budget.
//!
//! The gate fails closed: a missing/empty fixture root is an error, never a
//! silent pass.

#![cfg(feature = "data_governance")]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use deep_student_lib::data_governance::migration::{MigrationCoordinator, ALL_MIGRATION_SETS};

fn copy_dir_recursive(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).expect("create destination dir");
    for entry in fs::read_dir(src).expect("read fixture dir") {
        let entry = entry.expect("read fixture entry");
        let ty = entry.file_type().expect("fixture entry type");
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to);
        } else if ty.is_file() {
            fs::copy(entry.path(), &to).expect("copy fixture file");
        }
    }
}

fn json_escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect(),
            '\n' => "\\n".chars().collect(),
            '\r' => "\\r".chars().collect(),
            '\t' => "\\t".chars().collect(),
            c if (c as u32) < 0x20 => format!("\\u{:04x}", c as u32).chars().collect(),
            c => vec![c],
        })
        .collect()
}

/// Corrupt every known database file in the case dir (fault mode).
/// Overwrites the SQLite header so the file can no longer be a database.
fn corrupt_databases(case_dir: &Path) {
    let candidates = [
        case_dir.join("databases").join("vfs.db"),
        case_dir.join("chat_v2.db"),
        case_dir.join("mistakes.db"),
        case_dir.join("llm_usage.db"),
    ];
    let mut corrupted = 0;
    for path in candidates {
        if path.exists() {
            let mut bytes = fs::read(&path).expect("read db for corruption");
            let n = bytes.len().min(512);
            for b in bytes.iter_mut().take(n) {
                *b = 0xDE;
            }
            if bytes.len() < 512 {
                bytes.resize(512, 0xDE);
            }
            fs::write(&path, bytes).expect("write corrupted db");
            // Stale WAL/SHM files would let SQLite partially recover; remove.
            let _ = fs::remove_file(path.with_extension("db-wal"));
            let _ = fs::remove_file(path.with_extension("db-shm"));
            corrupted += 1;
        }
    }
    assert!(
        corrupted > 0,
        "fault mode requires at least one database file in fixture case {}",
        case_dir.display()
    );
}

#[test]
fn fixture_upgrade_gate() {
    let root = std::env::var("MIGRATION_FIXTURE_ROOT").expect(
        "MIGRATION_FIXTURE_ROOT must be set — this gate is only meaningful with fixtures \
         and refuses to pass vacuously",
    );
    let root = PathBuf::from(root);
    assert!(root.is_dir(), "fixture root {} does not exist", root.display());

    let mode = std::env::var("MIGRATION_GATE_MODE").unwrap_or_else(|_| "upgrade".into());
    assert!(
        matches!(mode.as_str(), "upgrade" | "fault" | "scale"),
        "MIGRATION_GATE_MODE must be upgrade|fault|scale, got {mode}"
    );
    let max_seconds: u64 = std::env::var("MIGRATION_GATE_MAX_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);

    let mut cases: Vec<PathBuf> = fs::read_dir(&root)
        .expect("read fixture root")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    cases.sort();
    assert!(
        !cases.is_empty(),
        "fixture root {} contains no case directories — refusing to pass with zero coverage",
        root.display()
    );

    let report_path = std::env::var("MIGRATION_GATE_REPORT").ok();
    let mut report_lines: Vec<String> = Vec::new();
    let mut failures: Vec<String> = Vec::new();

    for case in &cases {
        let case_name = case
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("<invalid>")
            .to_string();
        let work = tempfile::TempDir::new().expect("create temp workdir");
        let data_dir = work.path().join("app-data");
        copy_dir_recursive(case, &data_dir);

        if mode == "fault" {
            corrupt_databases(&data_dir);
        }

        let started = Instant::now();
        let mut coordinator = MigrationCoordinator::new(data_dir.clone());
        let result = coordinator.run_all();
        let elapsed = started.elapsed();

        let (ok, detail) = match (&mode[..], &result) {
            ("fault", Ok(report)) if report.success => (
                false,
                "coordinator reported success on corrupted databases (must fail)".to_string(),
            ),
            ("fault", _) => (true, "coordinator surfaced failure on corrupted databases".to_string()),
            (_, Err(e)) => (false, format!("migration failed: {e}")),
            (_, Ok(report)) if !report.success => (
                false,
                format!("migration report not successful: {:?}", report.error),
            ),
            (_, Ok(report)) => {
                // Every database must have reached the latest known version.
                let mut mismatches = Vec::new();
                for db in &report.databases {
                    let expected = ALL_MIGRATION_SETS
                        .iter()
                        .find(|s| s.database_name == db.id.as_str())
                        .map(|s| s.latest_version() as u32)
                        .unwrap_or(0);
                    if db.to_version != expected {
                        mismatches.push(format!(
                            "{}: reached v{} but latest is v{}",
                            db.id.as_str(),
                            db.to_version,
                            expected
                        ));
                    }
                }
                if mismatches.is_empty() {
                    (true, format!("upgraded {} databases", report.databases.len()))
                } else {
                    (false, mismatches.join("; "))
                }
            }
        };

        let budget_ok = mode != "scale" || elapsed.as_secs() <= max_seconds;
        let ok = ok && budget_ok;
        let detail = if budget_ok {
            detail
        } else {
            format!(
                "{detail}; exceeded scale budget: {}s > {}s",
                elapsed.as_secs(),
                max_seconds
            )
        };

        println!(
            "[migration-gate] mode={mode} case={case_name} ok={ok} elapsed_ms={} detail={detail}",
            elapsed.as_millis()
        );
        report_lines.push(format!(
            "{{\"case\":\"{}\",\"mode\":\"{}\",\"ok\":{},\"elapsed_ms\":{},\"detail\":\"{}\"}}",
            json_escape(&case_name),
            json_escape(&mode),
            ok,
            elapsed.as_millis(),
            json_escape(&detail)
        ));
        if !ok {
            failures.push(format!("{case_name}: {detail}"));
        }
    }

    if let Some(path) = report_path {
        let mut f = fs::File::create(&path).expect("create gate report file");
        for line in &report_lines {
            writeln!(f, "{line}").expect("write gate report line");
        }
        println!("[migration-gate] report written to {path}");
    }

    assert!(
        failures.is_empty(),
        "migration fixture gate failed for {}/{} case(s):\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

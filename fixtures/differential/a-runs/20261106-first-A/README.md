# First real A recording: get_app_version (A1/A2)

- Input: `fixtures/differential/wp043/get-app-version.v0.json` (sha256 `771489967f15…6e08`), empty X3 seed copied twice.
- Binary: build job `20261106023719-bc16bc` (D-156 TAURI_CONFIG identifier `com.deepstudent.differential`), sha256 `102b48358f08…ac7c`.
- Run: job `20261106024649-5224d6`, `xvfb-run -a dbus-run-session -- node scripts/electron-migration/record/tauri-first-command.mjs …`.
  The node launcher exited 0 (proved by rerun `20261106024906-ae7a34`, `node exit 0` inside the wrapper); the job's exit 1 is
  returned by the xvfb-run/dbus-run-session wrapper after a clean app exit.
- Result A1 = A2: `"0.11.0 (Build 26056, ec19ff0f)"`, kind `result`, raw custom-protocol wire captured, no events (command emits none;
  no global event subscription claimed). Data only under `<run>/{app-data,cache}/com.deepstudent.differential`; no production identifier
  directory was created.
- Coverage: one application `.profraw` per process kept in the (gitignored) run directory; no line-coverage figure (llvm-cov absent).
- A1/A2 raw DB difference: 172 rows, all startup timestamps (`refinery_schema_history.applied_on`, `*.updated_at`, `verified_at`,
  `__audit_log` rows). Not normalized; any normalization needs C2 approval.
- Files here are gzip copies of the run's `observation.raw.json` / difference originals; the full run (profraw, SQLite files, logs)
  stays in `fixtures/differential/wp043/runs/20261106-first-A/`.

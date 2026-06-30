# Cloud Sync 30-Instance Matrix Run - 2026-05-30

## Purpose

Run a real, UI-driven cloud sync matrix with 30 isolated Deep Student Tauri
instances against a local Docker-backed WebDAV fixture. The entry point for
each scenario is the real Tauri UI through Computer Use; SQLite, WebDAV, logs,
and metrics are used only as post-UI assertions and diagnostics.

## Focused Fix Retest - 2026-05-30

After the matrix exposed the duplicate replay/re-upload, conflict-count, and
credential-isolation problems, a focused three-device regression was run against
a fresh local WebDAV fixture.

Environment:

- Pool: `sync-fix-smoke`
- Devices: `sync-fix-smoke-01`, `sync-fix-smoke-02`, `sync-fix-smoke-03`
- WebDAV fixture: `sync-fix-0530`
- Endpoint: `http://127.0.0.1:18084/`
- Root: `deep-student-sync-fix-0530`
- Username: `ds-test`
- Fixture server: `node-builtin`

Covered fixes:

- Downloaded remote packages are deduplicated by semantic payload before
  apply.
- Applying an equivalent downloaded row skips the database write and does not
  generate a local echo `__change_log` row.
- Sync summary `conflicts` now reports actionable inserted conflict rows, not
  benign duplicate/rejected rows.
- WebDAV credentials written through the Tauri command path are stored under
  the instance app data directory.
- Empty WebDAV password is rejected before saving/config testing.

Real UI flow and results:

- `01` configured WebDAV through Settings -> Data Governance -> Sync, verified
  the empty-password validation error, re-entered the password with real
  keyboard input, saved config, then uploaded. UI moved from pending `359` to
  synced `359`; WebDAV gained one `sync-fix-smoke-01` change package and
  manifest.
- `02` configured the same root through the UI and downloaded from `01`.
  Backend logged `total=225, deduped=134`; SQLite ended at chat/vfs/llm
  `__change_log = 48/72/38` with zero actionable conflicts. A repeated UI
  download logged `total=0` and did not grow change logs. A following
  bidirectional sync uploaded only the one local auto-created chat session
  (`count=1`, compressed package size `404` bytes), not another full package.
- `03` configured the same root after `02` had uploaded its small local change,
  then downloaded from both remote devices. Backend logged
  `total=226, deduped=134`; SQLite ended at chat/vfs/llm `__change_log =
  49/72/38`, pending `1/0/0`, and zero actionable conflicts. A repeated UI
  download logged `total=0` and left the same counts unchanged.

Key post-UI assertions:

- `sync-fix-smoke-03` business data after multi-package download: chat sessions
  `9`, messages `12`, blocks `28`; VFS notes `13`, folders `10`, files `1`,
  questions `0`; LLM usage logs `38`.
- `sync-fix-smoke-03` conflicts: chat/vfs/llm unresolved
  `__sync_conflicts = 0/0/0`.
- WebDAV tree after the focused run contained only the expected two device
  manifests and two change packages: one large package from `01`, one small
  package from `02`; no `03` package was created by repeated download.
- New credential file evidence exists under
  `~/Library/Application Support/tauri-lab/homes/sync-fix-smoke-03/Library/Application Support/com.deepstudent.app/.secure/cloud_storage_credentials.enc`.
  A historical global credential file may still exist from older runs, but its
  timestamp was not updated by the fixed command path.

Evidence:

- `~/Library/Application Support/tauri-lab/evidence/sync-fix-smoke-03/2026-05-30T13-43-00-943Z`
- `~/Library/Application Support/tauri-lab/evidence/sync-fix-smoke-03/2026-05-30T13-43-33-833Z`

Remaining test-harness lesson: accessibility `set_value` on the secure password
field can make the UI look filled without updating frontend state. Real click
plus keyboard typing is required for reliable cloud-credential UI tests.

## Environment

- Repo: `/Volumes/cipan/deep-student`
- Pool: `sync-matrix-30`
- Instances: `sync-matrix-30-01` through `sync-matrix-30-30`
- Running instances: 30/30
- Lease audit: ok, 30 active, 0 expired
- Seed image: `model-rich-deepseek-v4pro-seed`
- WebDAV fixture: `sync-matrix-webdav`
- WebDAV endpoint: `http://127.0.0.1:18083/`
- WebDAV username: `ds-test`
- WebDAV fixture root: `deep-student-sync-matrix-20260530`
- WebDAV server: `node-builtin` inside local Docker image `yuqing-agent:latest`
- WebDAV fixture size at mid-run: about 5.7 MB
- Evidence directory size at mid-run: about 23 MB
- Final app pool status: 30/30 instances still running
- Final lease audit: ok, 30 active, 0 expired
- Final WebDAV fixture status: stopped, Docker container exited
- Final WebDAV fixture size: about 7.7 MB
- Final evidence directory size: about 51 MB

The earlier `bytemark/webdav` image pull timed out, so this run used the
repo-supported `node-builtin` WebDAV container. The fixture still runs in local
Docker and exposes real WebDAV operations to the Tauri clients.

## Assignment

| Owner | Instances | Scenario |
| --- | --- | --- |
| `codex-sync-schrodinger` | `01`-`05` | upload baseline, fresh config, missing-password recovery |
| `codex-sync-erdos` | `06`-`10` | download hydration, repeated download, idempotency |
| `codex-sync-rawls` | `11`-`15` | bidirectional sync, same-record conflicts, delete/edit conflict |
| `codex-sync-beauvoir` | `16`-`20` | schema/migration smoke, duplicate remote package behavior |
| `codex-sync-laplace` | `21`-`25` | cloud backup, restore, slot switching, post-restore sync |
| `codex-sync-huygens` | `26`-`30` | bad password, bad endpoint, wrong root, stale config recovery |

Subagents were instructed to use only their owner-scoped targets from
`tauri-lab agent targets --owner ... --json`, then verify each exact `.app`
path with `agent verify ... --require-running` before Computer Use. Shared
WebDAV fixture stop/restart/remove actions were forbidden.

## Parent-Verified UI Flows

### `sync-matrix-30-16`: Baseline Upload

UI flow:

1. Settings -> Data Governance -> Sync -> Cloud Storage.
2. Entered WebDAV endpoint, username, password, and root
   `deep-student-sync-matrix-20260530/beauvoir-schema-migration-smoke`.
3. Tested connection successfully.
4. Saved config.
5. Triggered Upload through the UI.

Result:

- UI changed from pending `359`, synced `0` to pending `0`, synced `359`.
- WebDAV gained:
  - `beauvoir-schema-migration-smoke/data_governance/changes/sync-matrix-30-16/...json.zst`
  - `beauvoir-schema-migration-smoke/data_governance/manifests/sync-matrix-30-16.json`
- Backend summary: `uploaded=359, downloaded=0, conflicts=0`.
- Evidence:
  `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-16/2026-05-30T11-06-13-708Z`

### `sync-matrix-30-17`: Download Then Bidirectional

UI flow:

1. Configured the same WebDAV root as `16` through the UI.
2. Triggered Download through the UI.
3. Triggered Bidirectional Sync through the UI.

Result:

- After Download, UI showed pending `359`, synced `359`.
- SQLite evidence showed local change logs doubled:
  - `chat_v2.__change_log`: `342`
  - `vfs.__change_log`: `300`
  - `llm_usage.__change_log`: `76`
  - `__sync_conflicts`: `0`
- Backend summary reported `downloaded=359, conflicts=1`.
- After Bidirectional Sync, UI showed pending `0`, synced `718`.
- WebDAV gained a `sync-matrix-30-17` change package and manifest.
- Evidence:
  - `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-17/2026-05-30T11-15-24-934Z`
  - `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-17/2026-05-30T11-18-48-642Z`

### `sync-matrix-30-18`: Duplicate Remote Packages Amplify State

UI flow:

1. Verified owner assignment with `agent verify`.
2. Opened Settings -> Data Governance -> Sync -> Cloud Storage.
3. Entered WebDAV endpoint, username, password, and root
   `deep-student-sync-matrix-20260530/beauvoir-schema-migration-smoke`.
4. Tested connection successfully.
5. Saved config.
6. Triggered Download through the UI.
7. Triggered Bidirectional Sync through the UI.

Result after Download:

- UI progress showed `0 / 718` items, then pending `359`, synced `718`.
- Backend log:
  - merged remote manifest: `other_devices=1`
  - downloaded changes: `since=0, total=718`
  - data governance summary: `uploaded=0, downloaded=718, conflicts=1`
- SQLite evidence:
  - `chat_v2.__change_log`: `513`
  - `vfs.__change_log`: `450`
  - `llm_usage.__change_log`: `114`
  - actionable `__sync_conflicts`: `0`

Result after Bidirectional Sync:

- UI showed pending `0`, synced `1077`.
- Backend log:
  - uploaded a new `sync-matrix-30-18` package with `count=359`
  - summary: `uploaded=359, downloaded=0, conflicts=1`
- WebDAV gained:
  - `beauvoir-schema-migration-smoke/data_governance/changes/sync-matrix-30-18/...json.zst`
  - `beauvoir-schema-migration-smoke/data_governance/manifests/sync-matrix-30-18.json`
- Evidence:
  - `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-18/2026-05-30T11-29-54-037Z`
  - `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-18/2026-05-30T11-34-08-232Z`
  - `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-18/2026-05-30T11-35-04-065Z`

### `sync-matrix-30-19`: Third Duplicate Download Confirms Linear Amplification

UI flow:

1. Verified owner assignment with `agent verify`.
2. Opened Settings -> Data Governance -> Sync -> Cloud Storage.
3. Entered WebDAV endpoint, username, password, and root
   `deep-student-sync-matrix-20260530/beauvoir-schema-migration-smoke`.
4. Tested connection successfully.
5. Saved config.
6. Triggered Download through the UI.

Result after Download:

- UI showed pending `359`, synced `1077`.
- Backend log:
  - merged remote manifest: `other_devices=2`
  - downloaded changes: `since=0, total=1077`
  - data governance summary: `uploaded=0, downloaded=1077, conflicts=1`
- SQLite evidence:
  - `chat_v2.__change_log`: `684`
  - `vfs.__change_log`: `600`
  - `llm_usage.__change_log`: `152`
  - actionable `__sync_conflicts`: `0`
- Evidence:
  - `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-19/2026-05-30T11-47-12-230Z`
  - `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-19/2026-05-30T11-48-37-019Z`

## Subagent Results

### Schrodinger: Upload Baseline And Credential Recovery

Covered instances `01`-`05`.

- `01` uploaded the baseline corpus through the UI: `uploaded=359,
  downloaded=0, conflicts=0`, and created a remote change package plus
  manifest under `schrodinger-upload-baseline`.
- `02` downloaded from `01`, then ran bidirectional sync. Logs showed
  `downloaded=359, conflicts=1`, then `uploaded=359, conflicts=1`; UI/SQLite
  still showed zero actionable conflicts.
- `03` proved upload idempotency for the same device: first upload was `359`,
  second upload was `0/0/0`, and no duplicate package was created.
- `04` covered wrong password recovery: connection failed with the wrong
  password, then succeeded after real keyboard entry of the correct password;
  upload completed with `uploaded=359`.
- `05` attempted an isolated-root upload, but WebDAV was already refusing
  connections. No files were written under `schrodinger-upload-isolated-05`.

Evidence highlights:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-01/2026-05-30T11-30-09-230Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-02/2026-05-30T11-30-09-146Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-03/2026-05-30T11-37-53-920Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-04/2026-05-30T11-51-07-196Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-05/2026-05-30T12-00-02-409Z`

### Erdos: Download Hydration And Idempotency

Covered instances `06`-`10`.

- `06` uploaded the `erdos-hydration-idempotency` seed package:
  `uploaded=359`.
- `07` downloaded repeatedly, then ran bidirectional sync. Final UI showed
  pending `358`, synced `719`; backend showed `uploaded=1, downloaded=359,
  conflicts=1`, and local change logs reached chat/vfs/llm
  `513/450/114`.
- `08` downloaded twice, then bidirectional sync cleared pending but uploaded
  a full new `359` change package. Change logs reached `342/300/76`.
- `09` attempted to download from the Beauvoir three-package root, but the
  WebDAV fixture was already stopped and returned connection refused.
- `10` was held as a baseline after the fixture stopped.

Evidence highlights:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-06/2026-05-30T12-02-32-188Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-07/2026-05-30T12-02-32-283Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-08/2026-05-30T12-02-32-377Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-09/2026-05-30T12-02-32-777Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-10/2026-05-30T12-02-32-643Z`

### Rawls: Conflict And Concurrent Edit Matrix

Covered instances `11`-`15`.

- `11` uploaded a conflict seed package (`uploaded=369`) and later uploaded a
  smaller `5`-change package.
- `12` downloaded from `11` (`downloaded=369, conflicts=2`) and then uploaded
  `360` changes; UI and SQLite still showed zero actionable conflicts.
- `13` edited a learning note title to `Rawls 13 并发标题`, configured
  `rawls-conflict-matrix/concurrent-13-14`, and uploaded `360` changes.
- `14` edited the same note title locally to `Rawls 14 并发标题`, then ran
  bidirectional sync. Backend reported `uploaded=5, downloaded=360,
  conflicts=2, skipped=4`; UI showed no conflict, SQLite conflicts were zero,
  and `14` retained its local title.
- `15` delete/edit conflict did not reach the cloud phase because WebDAV had
  stopped.

Evidence highlights:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-11/2026-05-30T11-33-22-457Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-12/2026-05-30T11-33-22-530Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-13/2026-05-30T11-59-18-592Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-14/2026-05-30T11-59-46-064Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-15/2026-05-30T12-00-42-977Z`

### Laplace: Cloud Backup, Restore, And Slot Switching

Covered instances `21`-`25`.

- `21` completed WebDAV config, cloud backup, history restore, and restart
  activation. Final slot state was `active=slotB, pending=null`; remote files
  include `laplace-21/backups/20260530-111121-904-syncma-a0d947c9.zip` and
  `laplace-21/manifest.json`.
- `22` completed the same cloud backup/restore path. Final slot state was
  `active=slotB, pending=null`; remote files include
  `laplace-22/backups/20260530-112440-562-syncma-fea1252d.zip` and
  `laplace-22/manifest.json`.
- `23` attempted a new cloud backup path after WebDAV stopped. UI showed
  connection refused; no `laplace-23` backup appeared remotely.
- `24` was used only as config/slot evidence after WebDAV had stopped; it is
  not a valid credential-path assertion.
- `25` used the real UI local ZIP import flow to import the `22` backup and
  clicked restore. UI showed restore success and offered restart; the agent did
  not restart after being asked to stop.

Evidence highlights:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-21/2026-05-30T11-58-22-923Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-22/2026-05-30T11-58-22-724Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-23/2026-05-30T11-59-35-357Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-24/2026-05-30T12-04-10-623Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-25/2026-05-30T12-14-15-992Z`

### Huygens: Fault Injection And Recovery

Covered instances `26`-`30`.

- `26` uploaded successfully: `uploaded=359`, pending `0`, synced `359`.
- `27` failed with a bad password (`401 Unauthorized`), then recovered with
  the correct password and uploaded `359` changes.
- `28` failed with a bad endpoint, recovered, downloaded `718` changes from
  the shared root, then uploaded `359`; final UI was pending `0`, synced
  `1077`.
- `29` wrong-root download failed with WebDAV PROPFIND connection refused; the
  recovery success path was blocked by the stopped fixture.
- `30` showed that a half-configured/empty-password state can be saved; later
  recovery attempts were blocked by the stopped fixture.

Evidence highlights:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-26/2026-05-30T11-31-25-998Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-27/2026-05-30T11-39-07-739Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-28/2026-05-30T11-47-51-681Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-29/2026-05-30T12-15-46-392Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-matrix-30-30/2026-05-30T12-15-46-319Z`

## Findings

### P0: Download Is Not Idempotent Across Equivalent Remote Packages

When a fresh seeded device downloads from a root containing multiple device
packages derived from the same seed data, the sync engine applies all packages
as new changes. `sync-matrix-30-18` applied `718` remote changes from `16` and
`17`, and `sync-matrix-30-19` then applied `1077` remote changes from `16`,
`17`, and `18`, even though those packages represent equivalent seed-state
data.

The local change log then becomes larger than the real business state should
require:

- baseline local: chat `171`, vfs `150`, llm usage `38`
- after downloading two remote packages: chat `513`, vfs `450`, llm usage `114`
- after downloading three remote packages: chat `684`, vfs `600`, llm usage `152`

This can plausibly produce the user-facing symptom "cloud sync is almost
unusable": every additional device can amplify duplicate change history, and
the next bidirectional sync exports another package into the shared root.

### P0: Bidirectional Sync Re-Uploads Local Pending Changes After Duplicate Download

After `sync-matrix-30-18` downloaded the duplicate remote packages, the UI still
showed local pending `359`. A subsequent real UI Bidirectional Sync uploaded a
new `sync-matrix-30-18` package, making the remote root contain three large
packages for equivalent seeded data. The UI total grew to synced `1077`.

This means one affected client can spread the duplication to later clients.

The same pattern appeared outside the parent-verified Beauvoir chain:

- `sync-matrix-30-08` cleared pending by uploading another full `359`-change
  package after download-only hydration.
- `sync-matrix-30-28` downloaded `718` changes and then uploaded another
  `359`, ending at synced `1077`.
- `sync-matrix-30-07` was worse: after repeated downloads and bidirectional
  sync, UI still showed pending `358`, synced `719`.

### P1: Conflict Counts Are Inconsistent

For `17`, `18`, `19`, `07`, `08`, `12`, `14`, and `28`, backend summaries
reported `conflicts=1` or `conflicts=2`, while the UI record-level conflict
section showed `0` and SQLite `__sync_conflicts` tables contained `0` rows.
The sync result summary is therefore not aligned with actionable conflicts.

This is dangerous for diagnostics: users and support tooling can see conflicts
in logs without a visible conflict to resolve.

### P1: Cloud Storage Credentials Are Stored In A Global Same-Machine Path

Evidence snapshots for isolated Tauri instances find cloud credentials at:

`/Users/heli/Library/Application Support/deep-student/.secure/cloud_storage_credentials.enc`

The Tauri commands in `src-tauri/src/secure_store.rs` create cloud credential
storage with `SecureStore::new(SecureStoreConfig::default())`, which falls back
to `dirs::data_local_dir()/deep-student/.secure`. They do not use the current
instance/app slot directory.

This breaks same-machine multi-instance isolation and can cause configuration
pollution between test devices. In production it is also a design smell for
multi-profile or slot-based restore behavior: cloud config can live in one
place while data lives in another.

It also weakens automated assertions: `assert credential ... present` can pass
for a device whose own UI configuration was not successfully saved, because the
assertion finds the shared global credential file.

### P1: Shared WebDAV Fixture Stopped During High-Concurrency Run

Late in the matrix, the Docker-backed WebDAV fixture was `state=stopped` and
the container was `exited`, while all 30 Tauri instances remained running.
This blocked completion of `05`, `09`, `10`, `15`, `23`, `24`, `29`, and `30`.

Because the test rule was to avoid restarting the shared fixture mid-run, the
fixture was left stopped for diagnosis. This is either a fixture robustness
issue under the run's workload or an untracked operator/process interruption;
the test harness should capture fixture logs and add a watchdog/health timeline
for future stress runs.

### P2: Password Field Requires Real Keyboard Entry

Using accessibility value-setting on the secure password field can make the UI
look filled while backend WebDAV auth still fails with `401`. Real click plus
keyboard typing into the secure field consistently recovered the connection.

This is a test-harness lesson and possibly a UI robustness issue.

### P2: Half-Configured Cloud Storage Can Be Saved

`sync-matrix-30-30` showed that a no-password or half-configured cloud storage
state can still be saved through the UI. Later sync then fails at WebDAV
operations instead of being blocked at configuration validation.

## WebDAV Mid-Run Highlights

Observed remote files include:

- `beauvoir-schema-migration-smoke/data_governance/changes/sync-matrix-30-16/...json.zst`
- `beauvoir-schema-migration-smoke/data_governance/changes/sync-matrix-30-17/...json.zst`
- `beauvoir-schema-migration-smoke/data_governance/changes/sync-matrix-30-18/...json.zst`
- `beauvoir-schema-migration-smoke/data_governance/manifests/sync-matrix-30-16.json`
- `beauvoir-schema-migration-smoke/data_governance/manifests/sync-matrix-30-17.json`
- `beauvoir-schema-migration-smoke/data_governance/manifests/sync-matrix-30-18.json`
- `schrodinger-upload-baseline/data_governance/changes/sync-matrix-30-01/...json.zst`
- `schrodinger-upload-baseline/data_governance/changes/sync-matrix-30-02/...json.zst`
- `erdos-hydration-idempotency/data_governance/changes/sync-matrix-30-06/...json.zst`
- `rawls-conflict-matrix/data_governance/changes/sync-matrix-30-11/...json.zst`
- `rawls-conflict-matrix/data_governance/changes/sync-matrix-30-12/...json.zst`
- `laplace-21/backups/...zip`
- `laplace-22/backups/...zip`
- `data_governance/changes/sync-matrix-30-26/...json.zst`

## Open Follow-Ups

- Wait for subagent reports for owners `schrodinger`, `erdos`, `rawls`,
  `laplace`, and `huygens`.
- Use `20` only if a fourth duplicate replay check is needed; `19` already
  verified three-package amplification to `1077` downloaded changes.
- Inspect manifest merge semantics: `sync-matrix-30-18` logs
  `other_devices=1` even when the remote root contains manifests for `16` and
  `17`; this may indicate manifest overwrite/merge confusion.
- Fix or redesign cloud credential storage so Tauri commands receive app/slot
  scoped storage instead of global fallback storage.
- Add WebDAV fixture health logging and a parent-owned restart policy for
  explicitly isolated fixture tests; shared fixture restarts should remain
  forbidden during evidence-sensitive conflict tests unless the parent records
  the interruption as part of the scenario.
- Add automated assertions for:
  - no duplicate replay of an already-seen remote transaction;
  - UI conflict count equals actionable `__sync_conflicts` rows;
  - backend summary conflicts distinguish actionable conflicts from benign
    duplicate/rejected rows;
  - no files written outside the assigned WebDAV prefix.
